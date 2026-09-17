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
use crate::project::ProviderSetting;
use getrandom::fill as fill_random;
use std::collections::BTreeMap;

pub fn resolve_plan(
    request: &GenerationRequest,
    settings: &BTreeMap<String, ProviderSetting>,
    references: &ReferenceVideos,
) -> Result<ResolvedPlan, String> {
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
        model_evaluations: plan.num_model_evaluations,
        sequence_rows_without_text: plan.sequence_rows_without_text,
        latent_frames: plan.latent_frames,
        latent_width: plan.latent_width,
        latent_height: plan.latent_height,
        description,
        boundary: "Plan only. No weights were opened and no media file was created.",
    })
}

pub(super) fn validate_generation_controls(request: &GenerationRequest) -> Result<(), String> {
    let limits = crate::generation::models::h3::MODEL.capabilities;
    if request.reference_paths.len() > limits.max_image_references
        || request.reference_video_ids.len() > limits.max_video_references
        || request.reference_count() > limits.max_references
    {
        return Err("Use at most nine images and three videos per generation.".into());
    }
    if request.still_image && !request.reference_video_ids.is_empty() {
        return Err("Video references cannot be used for still-image generation.".into());
    }
    if request.steps < limits.min_steps {
        return Err("Generation step count must be at least 2.".into());
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

/// Continuation output is cumulative. Expose only the new scene to the editor,
/// while the DLL saves the full archive for the next continuation.
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
    let limits = crate::generation::models::h3::MODEL.capabilities;
    let frames = request
        .frames
        .checked_add(limits.frame_stride - 1)
        .ok_or("Continuation frame count overflow.")?
        / limits.frame_stride
        * limits.frame_stride;
    let offset = total
        .checked_sub(frames)
        .filter(|offset| *offset >= limits.continuation_overlap)
        .ok_or("Slopfab continuation output is missing its source frames.".to_string())?;
    Ok((offset, frames))
}

pub(super) fn scene_audio_offset(
    frame_offset: i32,
    fps: f64,
    channels: i32,
    sample_rate: i32,
    total: usize,
) -> Result<usize, String> {
    if total == 0 || frame_offset == 0 {
        return Ok(0);
    }
    if !fps.is_finite() || fps <= 0.0 || channels <= 0 || sample_rate <= 0 {
        return Err("Slopfab returned invalid continuation audio timing.".into());
    }
    let samples = (frame_offset as f64 * sample_rate as f64 / fps).round();
    let offset = (samples as usize)
        .checked_mul(channels as usize)
        .filter(|offset| *offset <= total)
        .ok_or("Slopfab continuation audio is shorter than its source scene.")?;
    Ok(offset)
}
