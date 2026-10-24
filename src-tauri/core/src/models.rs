//! What each generation model can do. The desktop app adds authoring rules
//! (shot vocabulary, agent instructions) on top of these limits.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorFeatures {
    pub label: String,
    pub image_generation: bool,
    pub video_generation: bool,
    pub image_editing: bool,
    pub image_references: bool,
    pub image_outpainting: bool,
    pub requires_image_input: bool,
    pub edit_image_references: bool,
    pub max_image_references: usize,
    pub refmods: bool,
    pub sigma_shifts: bool,
    pub cuda_only: bool,
    pub loras: bool,
    pub motion_cache: bool,
    pub generation_effects: bool,
    pub cfg: Option<CfgSettings>,
}

#[derive(Debug, serde::Deserialize)]
pub struct CfgSettings {
    pub default: f32,
}

pub fn validate_cfg_scale(value: f64) -> Result<(), String> {
    if !value.is_finite() || value < 0.0 || value > f32::MAX as f64 { Err("CFG must be a finite, non-negative number within the runtime range.".into()) } else { Ok(()) }
}

pub fn generator_features(model_type: &str) -> &'static GeneratorFeatures {
    static MODELS: std::sync::OnceLock<std::collections::BTreeMap<String, GeneratorFeatures>> = std::sync::OnceLock::new();
    let models = MODELS.get_or_init(|| serde_json::from_str(include_str!("../../../src/lib/generatorModels.json")).expect("valid generator model catalog"));
    models.get(model_type).unwrap_or(&models["minimax-h3"])
}

#[derive(Debug, Clone, Copy)]
pub struct ModelCapabilities {
    pub max_scene_seconds: f64,
    pub min_steps: i32,
    pub max_image_references: usize,
    pub max_video_references: usize,
    pub max_audio_references: usize,
    pub max_references: usize,
    pub continuation_overlap: i32,
    pub frame_stride: i32,
}

pub const H3_CAPABILITIES: ModelCapabilities = ModelCapabilities {
    max_scene_seconds: 15.0,
    min_steps: 2,
    max_image_references: 9,
    max_video_references: 3,
    max_audio_references: 3,
    max_references: 12,
    continuation_overlap: 22,
    frame_stride: 17,
};
