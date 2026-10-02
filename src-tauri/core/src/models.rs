//! What each generation model can do. The desktop app adds authoring rules
//! (shot vocabulary, agent instructions) on top of these limits.

#[derive(Debug, Clone, Copy)]
pub struct ModelCapabilities {
    pub max_scene_seconds: f64,
    pub min_steps: i32,
    pub max_image_references: usize,
    pub max_video_references: usize,
    pub max_references: usize,
    pub continuation_overlap: i32,
    pub frame_stride: i32,
}

pub const H3_CAPABILITIES: ModelCapabilities = ModelCapabilities {
    max_scene_seconds: 15.0,
    min_steps: 2,
    max_image_references: 9,
    max_video_references: 3,
    max_references: 12,
    continuation_overlap: 22,
    frame_stride: 17,
};
