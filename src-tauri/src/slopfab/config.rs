use super::{default_dll_path, platform::ComputePlatform, types::GenerationRequest};
use crate::project::{ProviderOption, ProviderSetting};
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct LoraAdapter {
    pub(super) path: String,
    pub(super) strength: f32,
}

#[derive(Clone)]
pub(super) struct Configuration {
    pub(super) dll_path: PathBuf,
    pub(super) vulkan: bool,
    pub(super) attention: &'static str,
    pub(super) motion_cache: bool,
    pub(super) animate: bool,
    pub(super) prompt_embedding: Option<PathBuf>,
    pub(super) models: [(i32, &'static str, Option<PathBuf>); 5],
    pub(super) loras: Result<Vec<LoraAdapter>, String>,
    pub(super) step_override: Result<Option<i32>, String>,
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
        Self {
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
            attention: match string_option("attention") {
                Some("exact") => "exact",
                Some("flash2") => "flash2",
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
        }
    }

    pub(super) fn validate_inputs(&self, request: &GenerationRequest) -> Result<(), String> {
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
            {
                return Err("Extend/Bridge requires exactly one/two video references without frame anchors, Animate, continuation or refmods.".into());
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
            if request.continuation_path.is_some() || !request.refmods.is_empty() {
                return Err("Animate does not support scene continuation or refmods.".into());
            }
        } else if request.prompt.trim().is_empty() {
            return Err("Generation prompt cannot be empty.".into());
        }
        Ok(())
    }

    pub(super) fn generation_steps(&self, fallback: i32) -> Result<i32, String> {
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
            "slopfab={version}|platform={}|attention={}|motionCache={}|{models}|loras={adapters}|steps={:?}",
            platform.label(),
            self.attention,
            self.motion_cache,
            self.step_override
        )
    }
}
