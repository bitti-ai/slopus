//! Audio-only music requests. Do not apply H3 video or sampling defaults.
use super::{config::Configuration, ffi::{Api, RequestHandle}, platform::ComputePlatform, types::GenerationRequest};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MusicSettings {
    pub lyrics: String,
    pub duration: f64,
    pub planning: String,
    pub abc: String,
    pub abc_max_tokens: i32,
    pub temperature: f64,
    pub top_p: f64,
    pub top_k: i32,
    pub repetition_penalty: f64,
    pub semantic_guidance: f64,
    pub flow_guidance: f64,
}
impl Default for MusicSettings {
    fn default() -> Self { Self { lyrics: String::new(), duration: 30.0, planning: "full".into(), abc: String::new(),
        abc_max_tokens: 4096, temperature: 1.0, top_p: 0.95, top_k: 0, repetition_penalty: 1.2,
        semantic_guidance: 0.0, flow_guidance: 0.0 } }
}
impl MusicSettings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.duration.is_finite() || !(2.0..=300.0).contains(&self.duration)
            || !matches!(self.planning.as_str(), "full" | "melody" | "off")
            || !(32..=4096).contains(&self.abc_max_tokens) || !(0..=1024).contains(&self.top_k)
            || !self.temperature.is_finite() || !(0.0..=10.0).contains(&self.temperature)
            || !self.top_p.is_finite() || self.top_p <= 0.0 || self.top_p > 1.0
            || !self.repetition_penalty.is_finite() || !(1.0..=10.0).contains(&self.repetition_penalty)
            || !self.semantic_guidance.is_finite() || !(0.0..=10.0).contains(&self.semantic_guidance)
            || (self.semantic_guidance > 0.0 && self.semantic_guidance < 1.0)
            || !self.flow_guidance.is_finite() || !(0.0..=10.0).contains(&self.flow_guidance)
            || self.lyrics.chars().count() > 30000 || self.abc.chars().count() > 30000
            || self.lyrics.contains('\0') || self.abc.contains('\0') {
            return Err("Invalid music settings. Use a duration from 2 to 300 seconds and supported sampling ranges.".into());
        }
        if self.planning == "off" && !self.abc.is_empty() { return Err("ABC requires full or melody planning.".into()); }
        Ok(())
    }
}

pub(super) fn validate(request: &GenerationRequest, config: &Configuration) -> Result<(), String> {
    let settings = request.music.as_ref().ok_or("Music settings are missing.")?;
    settings.validate()?;
    if !matches!(config.model_type.as_str(), "yue2" | "minimax_music3") { return Err("Choose a music generator.".into()); }
    if request.prompt.trim().is_empty() || request.prompt.contains('\0') || request.prompt.chars().count() > 10000
        || !(2..=100).contains(&request.steps) || request.seed < -1 { return Err("Music needs a style prompt, 2–100 steps and a valid seed.".into()); }
    if request.still_image || request.image_edit.is_some() || request.reference_count() != 0 || !request.refmods.is_empty()
        || request.latent_upscale || request.latent_bridge.is_some() || request.continuation_path.is_some()
        || request.continuation_relative_path.is_some() || request.video_transition.is_some() || request.save_latents_path.is_some()
        || request.audio_steps.is_some() || request.video_sigma_shift.is_some() || request.audio_sigma_shift.is_some()
        || request.guidance_scale.is_some() || request.negative_prompt.is_some() || request.generation_effects.is_some()
        || config.animate || config.motion_cache || config.prompt_embedding.is_some()
        || !config.loras.as_ref().map_err(Clone::clone)?.is_empty() {
        return Err("Music does not support image/video controls, references, LoRAs or generation effects.".into());
    }
    let defaults = MusicSettings::default();
    if config.model_type == "minimax_music3" && (settings.planning != defaults.planning || !settings.abc.is_empty()
        || settings.abc_max_tokens != defaults.abc_max_tokens || settings.temperature != defaults.temperature
        || settings.top_p != defaults.top_p || settings.repetition_penalty != defaults.repetition_penalty) {
        return Err("MiniMax Music3 does not support YuE2 planning and sampling controls.".into());
    }
    if config.model_type == "yue2" && settings.flow_guidance != 0.0 { return Err("Flow guidance is available for MiniMax Music3 only.".into()); }
    Ok(())
}

pub(super) fn configure(api: &Api, handle: &RequestHandle, request: &GenerationRequest, config: &Configuration, platform: ComputePlatform) -> Result<(), String> {
    validate(request, config)?;
    api.set_model_family(handle, &config.model_type)?;
    api.set_prompt(handle, &request.prompt)?;
    api.set_music_settings(handle, &serde_json::to_string(request.music.as_ref().unwrap()).map_err(|e| e.to_string())?)?;
    api.set_steps(handle, request.steps)?;
    api.set_seed(handle, super::planning::generation_seed(request.seed)?)?;
    api.set_inference_backend(handle, platform.backend())?;
    if platform == ComputePlatform::Vulkan { api.set_vulkan_portable(handle)?; }
    api.set_attention(handle, "flash2")?;
    for (id, _, path) in &config.models {
        if (*id == 0 || config.model_type == "minimax_music3" && (*id == 1 || *id == 4)) && path.is_some() {
            api.set_model(handle, *id, path.as_ref().unwrap())?;
        }
    }
    Ok(())
}
