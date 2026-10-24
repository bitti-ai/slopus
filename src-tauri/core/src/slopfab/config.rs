use super::{default_dll_path, platform::ComputePlatform, types::GenerationRequest};
use crate::settings::{ProviderOption, ProviderSetting};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct LoraAdapter {
    pub(super) path: String,
    pub(super) strength: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum SamplingPreset {
    Dmad4Step,
}

#[derive(Clone, Debug, Default)]
pub(super) struct SigmaShifts {
    pub(super) video: Option<f32>,
    pub(super) audio: Option<f32>,
    pub(super) video_override: Option<f32>,
    pub(super) audio_override: Option<f32>,
}

#[derive(Clone)]
pub(super) struct Configuration {
    pub(super) model_type: String,
    pub(super) dll_path: PathBuf,
    pub(super) vulkan: bool,
    pub(super) attention: &'static str,
    pub(super) motion_cache: bool,
    pub(super) animate: bool,
    pub(super) prompt_embedding: Option<PathBuf>,
    pub(super) latent_upscaler: Option<PathBuf>,
    pub(super) models: [(i32, &'static str, Option<PathBuf>); 5],
    pub(super) loras: Result<Vec<LoraAdapter>, String>,
    pub(super) step_override: Result<Option<i32>, String>,
    pub(super) sampling_preset: Result<Option<SamplingPreset>, String>,
    pub(super) sigma_shifts: Result<SigmaShifts, String>,
}

impl Configuration {
    pub(super) fn from_settings(settings: &BTreeMap<String, ProviderSetting>) -> Self {
        let slopfab = settings.get("slopfab");
        let string_option = |name: &str| {
            slopfab.and_then(|setting| match setting.options.get(name) {
                Some(ProviderOption::String(value)) => Some(value.as_str()),
                _ => None,
            })
        };
        let option = |name: &str| {
            slopfab.and_then(|setting| match setting.options.get(name) {
                Some(ProviderOption::String(value)) if !value.trim().is_empty() => {
                    Some(PathBuf::from(value))
                }
                _ => None,
            })
        };
        let shift = |name: &str| -> Result<Option<f32>, String> {
            match slopfab.and_then(|setting| setting.options.get(name)) {
                None => Ok(None),
                Some(ProviderOption::Number(value)) if value.is_finite() && *value >= f32::from_bits(1) as f64 && *value <= f32::MAX as f64 => Ok(Some(*value as f32)),
                _ => Err(format!("{name} must be a finite, positive float32 value.")),
            }
        };
        Self {
            model_type: string_option("modelType").unwrap_or("minimax-h3").to_owned(),
            sigma_shifts: (|| Ok(SigmaShifts { video: shift("videoSigmaShift")?, audio: shift("audioSigmaShift")?,
                video_override: shift("videoSigmaShiftOverride")?, audio_override: shift("audioSigmaShiftOverride")? }))(),
            // `dllPath` is no longer written by the app and has no settings UI.
            // It is still READ so a project or a test that carries one keeps
            // working; with none, use the DLL beside the executable.
            dll_path: option("dllPath").unwrap_or_else(default_dll_path),
            vulkan: string_option("inferenceBackend") == Some("vulkan"),
            animate: string_option("generationMode") == Some("animate"),
            motion_cache: matches!(
                slopfab.and_then(|setting| setting.options.get("motionCache")),
                Some(ProviderOption::Boolean(true))
            ),
            prompt_embedding: option("promptEmbedding"),
            latent_upscaler: option("latentUpscaler"),
            attention: match string_option("attention") {
                Some("exact") => "exact",
                Some("flash2") => "flash2",
                Some("sol") => "sol",
                _ => "sage2",
            },
            models: [
                (0, "transformer", option("transformer")),
                (1, "textEncoder", option("textEncoder")),
                (2, "tokenizer", option("tokenizer")),
                (3, "videoVae", option("videoVae")),
                (4, "audioVae", option("audioVae")),
            ],
            loras: match slopfab.and_then(|setting| setting.options.get("loras")) {
                None => Ok(Vec::new()),
                Some(ProviderOption::String(value)) => {
                    serde_json::from_str::<Vec<LoraAdapter>>(value)
                        .map_err(|error| format!("Invalid LoRA settings: {error}"))
                }
                _ => Err("LoRA settings must be a JSON array of paths and strengths.".into()),
            },
            step_override: match slopfab.and_then(|setting| setting.options.get("stepOverride")) {
                None => Ok(None),
                Some(ProviderOption::Number(value))
                    if value.is_finite()
                        && value.fract() == 0.0
                        && *value >= 2.0
                        && *value <= i32::MAX as f64 =>
                {
                    Ok(Some(*value as i32))
                }
                _ => Err("LoRA step override must be a whole number from 2 to 2147483647.".into()),
            },
            sampling_preset: match slopfab.and_then(|setting| setting.options.get("samplingPreset")) {
                None => Ok(None),
                Some(ProviderOption::String(value)) if value == "dmad-4step" => Ok(Some(SamplingPreset::Dmad4Step)),
                _ => Err("Unsupported LoRA sampling recipe.".into()),
            },
        }
    }

    pub(super) fn validate_inputs(&self, request: &GenerationRequest) -> Result<(), String> {
        let features = crate::models::generator_features(&self.model_type);
        if let Some(negative) = &request.negative_prompt {
            if negative.contains('\0') { return Err("Negative prompt cannot contain null characters.".into()); }
            if !negative.is_empty() && (!features.negative_prompt || !request.still_image) {
                return Err(format!("{} does not support negative prompts for this generation.", features.label));
            }
        }
        if let Some(scale) = request.guidance_scale {
            crate::models::validate_cfg_scale(f64::from(scale))?;
            if features.cfg.is_none() || !request.still_image { return Err(format!("{} does not support configurable CFG for this generation.", features.label)); }
        }
        if let Some(effects) = &request.generation_effects {
            if effects.native_settings()?.is_some() && !features.generation_effects { return Err(format!("{} does not support generation effects.", features.label)); }
        }
        if request.still_image && !features.image_generation || !request.still_image && !features.video_generation {
            return Err(format!("{} does not support {} generation.", features.label, if request.still_image { "image" } else { "video" }));
        }
        if !features.image_editing && request.image_edit.is_some() {
            return Err(format!("{} does not support image editing.", features.label));
        }
        if features.requires_image_input && request.image_edit.is_none() && request.reference_paths.is_empty() {
            return Err(format!("{} requires a source image or image references.", features.label));
        }
        if request.still_image && features.image_references && request.reference_paths.len() > features.max_image_references {
            return Err(format!("{} supports at most {} reference images.", features.label, features.max_image_references));
        }
        if !features.refmods && (!request.refmods.is_empty() || request.image_edit.as_ref().is_some_and(|edit| edit.edits.iter().any(|step| step.refmods.as_ref().is_some_and(|items| !items.is_empty())))) {
            return Err(format!("{} does not support refmods.", features.label));
        }
        if let Some(edit) = &request.image_edit {
            if !features.edit_image_references && (!request.reference_paths.is_empty() || edit.edits.iter().any(|step| step.reference_paths.as_ref().is_some_and(|paths| !paths.is_empty()))) {
                return Err(format!("{} edits use exactly one source image without additional image references.", features.label));
            }
            if !features.image_outpainting && edit.edits.iter().any(|step| step.invert_mask) {
                return Err(format!("{} does not support Zoom or outpainting.", features.label));
            }
        }
        if !features.sigma_shifts {
            let shifts = self.sigma_shifts.as_ref().map_err(Clone::clone)?;
            if [shifts.video, shifts.audio, shifts.video_override, shifts.audio_override, request.video_sigma_shift, request.audio_sigma_shift].iter().any(Option::is_some)
                || request.audio_steps.is_some() || self.sampling_preset.as_ref().map_err(Clone::clone)?.is_some() {
                return Err(format!("{} uses its own sampling schedule without H3 overrides.", features.label));
            }
        }
        if self.model_type == "fibo2" && (self.animate || request.latent_upscale || request.latent_bridge.is_some()
            || request.continuation_path.is_some() || request.continuation_relative_path.is_some() || request.save_latents_path.is_some()
            || self.attention != "flash2") {
            return Err("Fibo requires Flash attention, without H3 video or latent features.".into());
        }
        if !features.image_references && (!request.reference_paths.is_empty() || !request.refmods.is_empty()) {
            return Err(format!("{} does not support image references or refmods.", features.label));
        }
        if !features.loras && self.loras.as_ref().map_err(Clone::clone)?.iter().any(|lora| lora.strength != 0.0) {
            return Err(format!("{} does not support LoRAs.", features.label));
        }
        if !features.motion_cache && self.motion_cache {
            return Err(format!("{} does not support MotionCache.", features.label));
        }
        if self.model_type == "moss" && (self.animate || request.latent_upscale || request.latent_bridge.is_some()
            || request.continuation_path.is_some() || request.continuation_relative_path.is_some()) {
            return Err("MOSS supports text-to-image generation only.".into());
        }
        if let Some(mode) = request.video_transition.as_deref() {
            let expected = match mode {
                "extend" => 1,
                "bridge" => 2,
                _ => return Err("Unsupported video transition mode.".into()),
            };
            if self.animate
                || request.still_image
                || request.continuation_path.is_some()
                || request.continuation_relative_path.is_some()
                || !request.refmods.is_empty()
                || !request.reference_paths.is_empty()
                || request.reference_video_ids.len() != expected
                || !request.reference_audio_ids.is_empty()
            {
                return Err("Extend/Bridge requires exactly one/two video references without frame anchors, sound references, Animate, continuation or refmods.".into());
            }
        }
        if self.animate && self.motion_cache {
            return Err("MotionCache is unavailable in Animate mode.".into());
        }
        if self.animate {
            if request.still_image {
                return Err("Animate requires video generation.".into());
            }
            if request.reference_video_ids.len() != 1 {
                return Err("Animate requires exactly one reference video.".into());
            }
            if request.reference_paths.len() != 1 {
                return Err(
                    "Animate requires exactly one repainted frame of the driving scene.".into(),
                );
            }
            if request.continuation_path.is_some() || request.latent_bridge.is_some() || !request.refmods.is_empty() || !request.reference_audio_ids.is_empty() {
                return Err("Animate does not support scene continuation, sound references or refmods.".into());
            }
        } else if request.prompt.trim().is_empty() {
            return Err("Generation prompt cannot be empty.".into());
        }
        Ok(())
    }

    pub(super) fn generation_steps(&self, fallback: i32) -> Result<i32, String> {
        if self.sampling_preset.clone()? == Some(SamplingPreset::Dmad4Step) {
            return Ok(4);
        }
        self.step_override
            .clone()
            .map(|steps| steps.unwrap_or(fallback))
    }

    pub(super) fn platform(&self, detected: ComputePlatform) -> ComputePlatform {
        if self.vulkan {
            ComputePlatform::Vulkan
        } else {
            detected
        }
    }

    pub(super) fn timing_profile(&self, version: &str, platform: ComputePlatform) -> String {
        let models = self
            .models
            .iter()
            .filter_map(|(_, id, path)| {
                path.as_ref().map(|path| {
                    let file = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("unknown");
                    format!("{id}={file}")
                })
            })
            .collect::<Vec<_>>()
            .join(";");
        let adapters = self
            .loras
            .as_ref()
            .map(|loras| {
                loras
                    .iter()
                    .map(|lora| format!("{}@{}", lora.path, lora.strength))
                    .collect::<Vec<_>>()
                    .join(";")
            })
            .unwrap_or_default();
        format!(
            "slopfab={version}|platform={}|attention={}|motionCache={}|{models}|loras={adapters}|steps={:?}|sampling={:?}",
            platform.label(),
            self.attention,
            self.motion_cache,
            self.step_override,
            self.sampling_preset
        )
    }
}
