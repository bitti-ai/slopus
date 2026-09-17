use super::{ModelCapabilities, ModelDefinition, SceneDefaults};

pub(crate) static MODEL: ModelDefinition = ModelDefinition {
    defaults: SceneDefaults { provider_id: "minimax-h3", duration_seconds: 6.0 },
    capabilities: ModelCapabilities {
        max_scene_seconds: 15.0,
        min_steps: 2,
        max_image_references: 9,
        max_video_references: 3,
        max_references: 12,
        continuation_overlap: 22,
        frame_stride: 17,
    },
    agent_instructions: include_str!("../../../assets/h3-agent.md"),
};
