pub(crate) mod h3;

#[derive(Debug, Clone, Copy)]
pub(crate) struct SceneDefaults {
    pub provider_id: &'static str,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ModelCapabilities {
    pub max_scene_seconds: f64,
    pub min_steps: i32,
    pub max_image_references: usize,
    pub max_video_references: usize,
    pub max_references: usize,
    pub continuation_overlap: i32,
    pub frame_stride: i32,
}

pub(crate) struct ModelDefinition {
    pub defaults: SceneDefaults,
    pub capabilities: ModelCapabilities,
    pub agent_instructions: &'static str,
}

pub(crate) fn default_model() -> &'static ModelDefinition { &h3::MODEL }

/// Unknown persisted provider ids remain readable. They do not silently acquire
/// H3 authoring rules; a backend must explicitly register support before use.
pub(crate) fn find(id: &str) -> Option<&'static ModelDefinition> {
    match id { "minimax-h3" => Some(&h3::MODEL), _ => None }
}

pub(crate) fn for_scene(id: Option<&str>) -> Option<&'static ModelDefinition> {
    id.map(find).unwrap_or_else(|| Some(default_model()))
}
