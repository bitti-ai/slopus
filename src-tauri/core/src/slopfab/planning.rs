#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum RequestPurpose {
    Plan,
    Generate,
}
use super::{
    config::Configuration,
    ffi::{self, RequestHandle},
    h3::configure_request,
    platform::detect_platform,
    references::ReferenceVideos,
    types::*,
};
use crate::settings::ProviderSetting;
use getrandom::fill as fill_random;
use std::collections::BTreeMap;

pub fn resolve_plan(
    request: &GenerationRequest,
    settings: &BTreeMap<String, ProviderSetting>,
    references: &ReferenceVideos,
) -> Result<ResolvedPlan, String> {
    let _models = super::MODEL_ACCESS.try_read().map_err(|_| {
        "Model files are in use. Retry planning after generation or LoRA preparation finishes."
    })?;
    validate_generation_controls(request)?;
    let configuration = Configuration::from_settings(settings);
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    let platform = configuration.platform(detect_platform(&api));
    let handle = RequestHandle::new(&api)?;
    configure_request(
        &api,
        &handle,
        request,
        &configuration,
        platform,
        RequestPurpose::Plan,
        references,
    )?;
    let plan = api.resolve(&handle)?;
    let description = api.describe(&handle)?;
    let (_, frames) = scene_frame_window(request, plan.aligned_frames)?;
    Ok(ResolvedPlan {
        canvas_width: plan.canvas_width,
        canvas_height: plan.canvas_height,
        aligned_frames: frames,
        duration_seconds: plan.duration_seconds * frames as f64 / plan.aligned_frames as f64,
        model_evaluations: plan.num_model_evaluations * request.image_edit.as_ref().map_or(1, |edit| edit.edits.len() as i32),
        sequence_rows_without_text: plan.sequence_rows_without_text,
        latent_frames: plan.latent_frames,
        latent_width: plan.latent_width,
        latent_height: plan.latent_height,
        description,
        boundary: "Plan only. Model and adapter metadata may be read; no inference was run or media file created.",
    })
}

pub(super) fn validate_generation_controls(request: &GenerationRequest) -> Result<(), String> {
    super::continuation::validate(request)?;
    if let Some(edit) = &request.image_edit {
        if !request.still_image || request.frames != 1 || request.continuation_relative_path.is_some() || request.continuation_path.is_some() || request.video_transition.is_some()
            || edit.edits.is_empty() || edit.edits.len() > 500 || request.canvas_width > 8192 || request.canvas_height > 8192
            || edit.edits.iter().any(|step| step.prompt.trim().is_empty() || step.x < 0 || step.y < 0 || step.width <= 0 || step.height <= 0
                || step.feather.is_some_and(|feather| !(0..=8192).contains(&feather))
                || i64::from(step.x) + i64::from(step.width) > i64::from(request.canvas_width)
                || i64::from(step.y) + i64::from(step.height) > i64::from(request.canvas_height)) {
            return Err("Image edits require one source image and nonempty boxes inside its dimensions.".into());
        }
        for step in &edit.edits {
            if step.invert_mask && (edit.edits.len() != 1 || step.feather != Some(0)
                || (step.x == 0 && step.y == 0 && step.width == request.canvas_width && step.height == request.canvas_height)
                || (i64::from(step.x) + 15) / 16 >= (i64::from(step.x) + i64::from(step.width)) / 16
                || (i64::from(step.y) + 15) / 16 >= (i64::from(step.y) + i64::from(step.height)) / 16) {
                return Err("Outpainting requires one preserved box with original context, room outside it and zero feather.".into());
            }
        }
    }
    let limits = crate::models::H3_CAPABILITIES;
    if request.reference_paths.len() > limits.max_image_references
        || request.reference_video_ids.len() > limits.max_video_references
        || request.reference_audio_ids.len() > limits.max_audio_references
        || request.reference_count() > limits.max_references
    {
        return Err("Use at most nine images, three videos and three sounds per generation.".into());
    }
    if request.still_image && (!request.reference_video_ids.is_empty() || !request.reference_audio_ids.is_empty()) {
        return Err("Video and sound references cannot be used for still-image generation.".into());
    }
    if request.steps < limits.min_steps {
        return Err("Generation step count must be at least 2.".into());
    }
    if request.audio_steps.is_some_and(|steps| !(2..=1_000_000).contains(&steps)) {
        return Err("Audio step count must be a whole number from 2 to 1000000.".into());
    }
    if request.seed < -1 {
        return Err("Generation seed must be -1 or greater.".into());
    }
    if request.canvas_width <= 0 || request.canvas_height <= 0 {
        return Err("Generation canvas dimensions must be positive.".into());
    }
    Ok(())
}

pub(super) fn generation_seed(value: i64) -> Result<u64, String> {
    if value == -1 {
        let mut bytes = [0_u8; 8];
        fill_random(&mut bytes)
            .map_err(|error| format!("Could not create a random generation seed: {error}"))?;
        Ok(u64::from_ne_bytes(bytes))
    } else {
        u64::try_from(value).map_err(|_| "Generation seed must be -1 or greater.".to_string())
    }
}

/// Keep the full joined decode. Timeline scene ranges are resolved by the
/// editor; discarding the prefix here loses the source side of the VAE join.
pub(super) fn scene_frame_window(
    request: &GenerationRequest,
    total: i32,
) -> Result<(i32, i32), String> {
    if total <= 0 {
        return Err("Slopfab returned no video frames.".into());
    }
    if request.continuation_path.is_none() {
        return Ok((0, total));
    }
    if request.frames <= 0 {
        return Err("Continuation needs a positive frame count.".into());
    }
    let limits = crate::models::H3_CAPABILITIES;
    let frames = request
        .frames
        .checked_add(limits.frame_stride - 1)
        .ok_or("Continuation frame count overflow.")?
        / limits.frame_stride
        * limits.frame_stride;
    total
        .checked_sub(frames)
        .filter(|offset| *offset >= request.continuation_overlap_frames.unwrap_or(limits.continuation_overlap))
        .ok_or("Slopfab continuation output is missing its source frames.".to_string())?;
    Ok((0, total))
}
