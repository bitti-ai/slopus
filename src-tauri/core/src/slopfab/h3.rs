//! Model request recipes for the SlopFab backend.
use super::{
    config::{Configuration, SamplingPreset},
    ffi::{self, RequestHandle},
    planning::{generation_seed, RequestPurpose},
    platform::ComputePlatform,
    references::ReferenceVideos,
    types::GenerationRequest,
};
use std::{io::Write, path::Path};

/// Keep the returned temporary reference alive through planning or generation.
pub(super) fn configure_request(
    api: &ffi::Api,
    handle: &RequestHandle,
    request: &GenerationRequest,
    configuration: &Configuration,
    platform: ComputePlatform,
    purpose: RequestPurpose,
    references: &ReferenceVideos,
) -> Result<Option<tempfile::TempPath>, String> {
    configuration.validate_inputs(request)?;
    if platform == ComputePlatform::Vulkan && configuration.sampling.as_ref().map_err(Clone::clone)?.sampler.as_deref() == Some("ab2") {
        return Err("AB2 sampling requires CUDA. Select a CUDA GPU or worker, or choose another sampler in Settings.".into());
    }
    if request.music.is_some() { return super::music::configure(api, handle, request, configuration, platform).map(|()| None); }
    if request.single_shot.is_some() && request.keystone_path.is_none() { api.require_end_anchor()?; }
    let source_noise = super::continuation::source_noise(request);
    if source_noise.is_some() { api.require_continuation_source_init()?; }
    if crate::models::generator_features(&configuration.model_type).cuda_only {
        if platform == ComputePlatform::Vulkan {
            return Err(format!("{} requires CUDA. Select a CUDA backend or worker.", crate::models::generator_features(&configuration.model_type).label));
        }
        api.set_model_family(handle, &configuration.model_type)?;
    }
    if matches!(configuration.model_type.as_str(), "krea2" | "h3_image") {
        api.set_model_family(handle, &configuration.model_type)?;
        if platform == ComputePlatform::Vulkan { api.set_vulkan_portable(handle)?; }
    }
    if configuration.attention == "sol" && platform == ComputePlatform::Vulkan {
        return Err("Sol attention requires CUDA. Select a CUDA GPU or worker, or choose another attention mode in Settings.".into());
    }
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
    // Ending-anchor APIs count new lead-in/gap frames, while Slopus scene
    // duration includes the short ending. Planning uses equivalent full geometry.
    api.set_frames(handle, if request.single_shot.as_ref().is_some_and(|single| single.ending_path.is_some()) { frames - 22 } else { frames })?;
    if request.still_image && !matches!(configuration.model_type.as_str(), "moss" | "fibo2" | "krea2" | "h3_image") {
        api.set_still_image(handle)?;
    }
    let video_steps = configuration.generation_steps(request.steps)?;
    // Saved H3 settings count grid points, including terminal zero. The updated
    // runtime counts denoising updates. Image-only families already use updates.
    let legacy_h3 = configuration.model_type == "minimax-h3";
    api.set_steps(handle, if legacy_h3 { video_steps - 1 } else { video_steps })?;
    let preset = configuration.sampling_preset.as_ref().map_err(Clone::clone)?;
    if let Some(preset) = preset {
        match preset {
            SamplingPreset::Dmad4Step => api.set_dmad_sampling(handle)?,
            SamplingPreset::Pika6Step => api.set_pika_sampling(handle)?,
        }
    } else {
        let shifts = configuration.sigma_shifts.as_ref().map_err(Clone::clone)?;
        let krea_raw_shift = (configuration.model_type == "krea2" && configuration.krea_raw).then(|| {
            let width = if request.canvas_width > 0 { request.canvas_width } else { 1024 };
            let height = if request.canvas_height > 0 { request.canvas_height } else { 1024 };
            let tokens = f64::from(width / 16) * f64::from(height / 16);
            (0.5 + (tokens - 256.0) * 0.65 / (6400.0 - 256.0)).exp() as f32
        });
        let sampling = configuration.sampling.as_ref().map_err(Clone::clone)?;
        api.set_sampling(handle, shifts.video_override.or(request.video_sigma_shift).or(shifts.video).or(krea_raw_shift),
            shifts.audio_override.or(request.audio_sigma_shift).or(shifts.audio), sampling.sampler.as_deref(), sampling.scheduler.as_deref())?;
    }
    // Sampling presets replace overrides, so apply the audio setting afterward.
    api.set_audio_steps(handle, request.audio_steps.map(|steps| if legacy_h3 { steps - 1 } else { steps }).unwrap_or(0))?;
    if let Some(cfg) = &crate::models::generator_features(&configuration.model_type).cfg {
        let negative = request.negative_prompt.as_deref().unwrap_or("");
        if configuration.model_type == "krea2" {
            api.set_krea_guidance(handle, request.guidance_scale.unwrap_or(if configuration.krea_raw { 3.5 } else { cfg.default }), negative)?;
        } else {
            api.set_image_guidance(handle, request.guidance_scale.unwrap_or(cfg.default), negative)?;
        }
    }
    api.set_seed(handle, generation_seed(request.seed)?)?;
    if let Some(edit) = &request.image_edit {
        let step = edit.edits.first().ok_or("Add an image edit before generating.")?;
        api.set_prompt(handle, &step.prompt)?;
        let bounds = [step.x, step.y, step.width, step.height];
        // Full-image edits have no surrounding pixels to blend into. Enforce
        // this here too, including older requests and sequential RGB edits.
        let whole_image = !step.invert_mask && step.x == 0 && step.y == 0
            && step.width == request.canvas_width && step.height == request.canvas_height;
        let feather = if whole_image { 0 } else { step.feather.unwrap_or(16) };
        let strength = step.strength.unwrap_or(1.0);
        if !strength.is_finite() || strength <= 0.0 || strength > 1.0 {
            return Err("Image edit strength must be greater than zero and at most one.".into());
        }
        if let Some(pixels) = &request.image_edit_pixels {
            api.set_image_edit_rgb(handle, pixels, request.canvas_width, request.canvas_height, bounds, strength, feather)?;
        } else {
            api.set_image_edit_path(handle, request.image_edit_path.as_deref().ok_or("Image edit source has not been resolved.")?, bounds, strength, feather)?;
        }
        if let Some(contours) = &step.mask_contours {
            let mask = crate::image_mask::rasterize_contours(contours, request.canvas_width, request.canvas_height)?;
            api.set_image_edit_mask(handle, &mask, request.canvas_width, request.canvas_height)?;
        }
        if let Some(points) = &step.mask_polygon {
            let mask = crate::image_mask::rasterize_polygon(points, request.canvas_width, request.canvas_height)?;
            api.set_image_edit_mask(handle, &mask, request.canvas_width, request.canvas_height)?;
        }
        if step.invert_mask {
            api.set_image_edit_invert_mask(handle)?;
            if let Some(overlap) = step.outpaint_blend_overlap {
                api.set_outpaint_blend_overlap(handle, overlap)?;
            }
            if let Some(steps) = step.outpaint_langevin_steps.or((configuration.model_type == "h3_image").then_some(0)) {
                api.set_outpaint_langevin_steps(handle, steps)?;
            }
        }
    } else {
        // H3 diffusion needs complete 32-pixel patches. The encoder fits the
        // 2x decoded result to the exact selected output dimensions.
        let (width, height) = if request.latent_upscale {
            ((request.canvas_width / 64 + i32::from(request.canvas_width % 64 != 0)) * 32,
             (request.canvas_height / 64 + i32::from(request.canvas_height % 64 != 0)) * 32)
        } else { (request.canvas_width, request.canvas_height) };
        api.set_resolution(handle, width, height)?;
    }
    let upscaler = if request.latent_upscale {
        let path = configuration.latent_upscaler.as_deref().ok_or("Download Latent upscale weights or choose a local file in Settings > Generator > Other weights first.")?;
        if !path.is_file() {
            return Err(format!("Latent upscale weights are missing: {}", path.display()));
        }
        Some(path)
    } else { None };
    api.set_latent_upscaler(handle, upscaler)?;
    api.set_inference_backend(handle, platform.backend())?;
    api.set_attention(handle, configuration.attention)?;
    let lock_overlap = request.continuation_path.is_some() && (request.single_shot.is_some() || request.continuation_lock_overlap);
    let independent_audio = request.audio_steps.is_some_and(|steps| steps != video_steps);
    // Overlap locking and different audio/video step counts require full evaluations.
    api.set_motion_cache(handle, configuration.motion_cache && preset.is_none() && request.image_edit.is_none() && !lock_overlap && !independent_audio && request.latent_bridge.is_none() && request.single_shot.is_none() && source_noise.is_none())?;
    if let Some(bridge) = &request.latent_bridge {
        api.set_latent_bridge_files(handle,
            request.bridge_left_path.as_deref().ok_or("Missing left Long Shot archive.")?,
            request.bridge_right_path.as_deref().ok_or("Missing right Long Shot archive.")?,
            bridge.left_margin_frames, bridge.right_margin_frames, bridge.context_frames)?;
    }
    api.set_verbose(handle, false)?;
    if let Some(mode) = request.video_transition.as_deref() {
        api.set_video_transition(handle, if mode == "bridge" { 2 } else { 1 })?;
    }
    if let Some(path) = &request.continuation_path {
        let opening = super::continuation::opening_archive(request)?;
        api.set_continuation_file(
            handle,
            opening.as_ref().map_or(path.as_path(), |file| file.as_ref()),
            if request.single_shot.is_some() { 22 } else { request.continuation_overlap_frames.unwrap_or(crate::models::H3_CAPABILITIES.continuation_overlap) },
        )?;
        api.set_continuation_lock_overlap(handle, lock_overlap)?;
        if request.keystone_path.is_some() {
            // Match SlopFab's two-minute anchored test: lock all 22 context
            // frames and preserve the complete preceding video/audio archive.
            // The separate 39/17 Long Context recipe rewrites an approved tail.
            api.set_continuation_regenerate_frames(handle, 0)?;
        }
    }
    if let Some(path) = request.single_shot.as_ref().and_then(|single| single.ending_path.as_ref()) {
        api.set_end_anchor_file(handle, path)?;
    }
    if let Some(noise) = source_noise { api.set_continuation_source_init(handle, noise)?; }
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
    attach_references(api, handle, request, configuration, references)?;
    let blank_reference = blank_image_reference(request, configuration)?;
    if let Some(path) = &blank_reference {
        api.add_reference(handle, path)?;
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
    if let Some(path) = &request.keystone_path {
        // Check after all model/adapter metadata and audio settings are attached.
        // The C API exposes joint evaluations, not the video update count, so
        // it cannot safely be inferred from steps (especially with fixed grids).
        // Prefer four; shorten only for this specific schedule validation error.
        for delay in (0..=4).rev() {
            api.set_keystone_file(handle, path, delay)?;
            match api.resolve(handle) {
                Ok(_) => break,
                Err(error) if delay > 0 && error.contains("capstone lock delay must be smaller than the number of video updates") => continue,
                Err(error) => return Err(error),
            }
        }
    }
    Ok(blank_reference)
}

fn blank_image_reference(
    request: &GenerationRequest,
    configuration: &Configuration,
) -> Result<Option<tempfile::TempPath>, String> {
    // A blank reference improves H3 Image's text-only results. Preserve the
    // prompt and use ordinary reference conditioning, never image editing.
    if configuration.model_type != "h3_image" || !request.still_image
        || request.image_edit.is_some() || request.reference_count() != 0
        || !request.refmods.is_empty() {
        return Ok(None);
    }
    let mut file = tempfile::Builder::new().prefix("slopus-h3-reference-").suffix(".ppm")
        .tempfile().map_err(|error| format!("Could not prepare image reference: {error}"))?;
    // PPM is supported by the runtime on every platform without external codecs.
    file.write_all(b"P6\n64 64\n255\n").and_then(|()| file.write_all(&[255; 64 * 64 * 3]))
        .map_err(|error| format!("Could not write image reference: {error}"))?;
    Ok(Some(file.into_temp_path()))
}

pub(super) fn attach_references(
    api: &ffi::Api,
    handle: &RequestHandle,
    request: &GenerationRequest,
    configuration: &Configuration,
    references: &ReferenceVideos,
) -> Result<(), String> {
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
    // Standalone audio follows the videos, so slopfab numbers it after every
    // video soundtrack. The prompt compiler numbers <Audio N> the same way.
    for id in &request.reference_audio_ids {
        let audio = references.reference_audio(id)?;
        api.add_reference_audio(handle, &audio.samples, audio.channels, audio.sample_rate)?;
    }
    Ok(())
}

// https://huggingface.co/Viggle/Viggle-Animate/raw/main/assets/fixed_prompt.txt
pub(super) const ANIMATE_PROMPT: &str =
    include_str!("../../../assets/viggle-animate-fixed-prompt.txt");
// SlopFab rounds up to 17*k + 5 frames but rejects Animate plans over 360.
pub(super) const ANIMATE_MAX_ALIGNED_FRAMES: i32 = (360 - 5) / 17 * 17 + 5;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_reference_skips_other_models_and_existing_conditioning() {
        let mut configuration = Configuration::from_settings(&Default::default());
        let request = GenerationRequest { still_image: true, ..Default::default() };
        for model in ["minimax-h3", "moss", "fibo2", "krea2"] {
            configuration.model_type = model.into();
            assert!(blank_image_reference(&request, &configuration).unwrap().is_none());
        }
        configuration.model_type = "h3_image".into();
        for patch in [
            serde_json::json!({"stillImage": false}),
            serde_json::json!({"referencePaths": ["image.png"]}),
            serde_json::json!({"referenceVideoIds": ["video"]}),
            serde_json::json!({"referenceAudioIds": ["audio"]}),
            serde_json::json!({"refmods": [{"path": "reference.safetensors", "strength": 1, "copies": 1}]}),
            serde_json::json!({"imageEdit": {"sourceRelativePath": "source.png", "edits": []}}),
        ] {
            let mut value = serde_json::to_value(&request).unwrap();
            value.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            let request = serde_json::from_value(value).unwrap();
            assert!(blank_image_reference(&request, &configuration).unwrap().is_none());
        }
    }
}
