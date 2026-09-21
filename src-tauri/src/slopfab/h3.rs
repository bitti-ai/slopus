//! H3 and Animate request recipes for the SlopFab backend.
use super::{
    config::Configuration,
    ffi::{self, RequestHandle},
    planning::{generation_seed, RequestPurpose},
    platform::ComputePlatform,
    references::ReferenceVideos,
    types::GenerationRequest,
};
use std::path::Path;
pub(super) fn configure_request(
    api: &ffi::Api,
    handle: &RequestHandle,
    request: &GenerationRequest,
    configuration: &Configuration,
    platform: ComputePlatform,
    purpose: RequestPurpose,
    references: &ReferenceVideos,
) -> Result<(), String> {
    configuration.validate_inputs(request)?;
    if configuration.animate {
        let videos = references
            .videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?;
        let video = videos
            .get(&request.reference_video_ids[0])
            .ok_or("The prepared reference video no longer exists. Please retry generation.")?;
        // Animate supplies recipe defaults; explicit step settings follow.
        api.set_animate(handle, video.has_audio())?;
        let source = configuration.prompt_embedding.as_deref()
            .ok_or("Animate conditioning is missing. Download Animate in Settings and select its conditioning additional safetensor.")?;
        let embedding = crate::conditioning::prepare(source)?;
        api.set_prompt_embedding(handle, &embedding)?;
    }
    api.set_prompt(
        handle,
        if configuration.animate {
            ANIMATE_PROMPT
        } else {
            &request.prompt
        },
    )?;
    // Keep lengths within the advertised 15-second range from rounding past
    // Animate's limit. Leave out-of-range requests to the DLL's validation.
    let frames = if configuration.animate && request.frames <= 360 {
        request.frames.min(ANIMATE_MAX_ALIGNED_FRAMES)
    } else {
        request.frames
    };
    api.set_frames(handle, frames)?;
    if request.still_image {
        api.set_still_image(handle)?;
    }
    api.set_steps(handle, configuration.generation_steps(request.steps)?)?;
    api.set_seed(handle, generation_seed(request.seed)?)?;
    api.set_resolution(handle, request.canvas_width, request.canvas_height)?;
    api.set_inference_backend(handle, platform.backend())?;
    api.set_attention(handle, configuration.attention)?;
    api.set_motion_cache(handle, configuration.motion_cache)?;
    api.set_verbose(handle, false)?;
    if let Some(mode) = request.video_transition.as_deref() {
        api.set_video_transition(handle, if mode == "bridge" { 2 } else { 1 })?;
    }
    if let Some(path) = &request.continuation_path {
        api.set_continuation_file(
            handle,
            path,
            crate::generation::models::h3::MODEL
                .capabilities
                .continuation_overlap,
        )?;
    }
    if purpose == RequestPurpose::Generate {
        if let Some(path) = &request.save_latents_path {
            api.set_save_latents(handle, path)?;
        }
    }
    for lora in configuration.loras.as_ref().map_err(Clone::clone)? {
        if lora.path.trim().is_empty() || !lora.strength.is_finite() {
            return Err("LoRA paths must be nonempty and strengths finite.".into());
        }
        if lora.strength == 0.0 {
            continue;
        }
        if purpose == RequestPurpose::Generate && !Path::new(&lora.path).is_file() {
            return Err(format!("LoRA file is missing: {}", lora.path));
        }
        api.add_lora(handle, Path::new(&lora.path), lora.strength)?;
    }
    if purpose == RequestPurpose::Generate {
        api.set_reuse_models(handle, true)?;
    }
    // Planning reads checkpoint metadata for sampling, conditioning, geometry
    // and reference capabilities. Give it the same model paths as execution.
    for (id, _, path) in &configuration.models {
        if configuration.animate && (*id == 1 || *id == 2) {
            continue;
        }
        if request.still_image && *id == 4 {
            continue;
        }
        if let Some(path) = path {
            api.set_model(handle, *id, path)?;
        }
    }
    for path in &request.reference_paths {
        api.add_reference(handle, Path::new(path))?;
    }
    if !request.reference_video_ids.is_empty() {
        let videos = references
            .videos
            .lock()
            .map_err(|_| "Reference video lock failed.")?;
        for id in &request.reference_video_ids {
            videos
                .get(id)
                .ok_or("The prepared reference video no longer exists. Please retry generation.")?
                .attach(handle, &configuration.dll_path)?;
        }
    }
    for refmod in &request.refmods {
        if refmod.path.trim().is_empty()
            || !refmod.strength.is_finite()
            || !(0.0..=1.0).contains(&refmod.strength)
            || !(1..=10).contains(&refmod.copies)
        {
            return Err("Refmods need a path, strength 0 to 1 and copies 1 to 10.".into());
        }
        if refmod.strength == 0.0 {
            continue;
        }
        api.add_refmod(
            handle,
            Path::new(&refmod.path),
            refmod.strength,
            refmod.copies as i32,
        )?;
    }
    Ok(())
}

// https://huggingface.co/Viggle/Viggle-Animate/raw/main/assets/fixed_prompt.txt
pub(super) const ANIMATE_PROMPT: &str =
    include_str!("../../assets/viggle-animate-fixed-prompt.txt");
// SlopFab rounds up to 17*k + 5 frames but rejects Animate plans over 360.
pub(super) const ANIMATE_MAX_ALIGNED_FRAMES: i32 = (360 - 5) / 17 * 17 + 5;
