use super::{references::*, scenes::*, timeline::*};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
/// Legacy project preference. Both video and image tools are available for every
/// project; keep reading and writing this field so old documents round-trip.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GenerationType {
    #[default]
    Video,
    Image,
    #[serde(rename = "3d")]
    ThreeD,
    Music,
    Speech,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectConfig {
    pub(crate) schema_version: u32,
    #[serde(default)]
    pub(crate) generation_type: GenerationType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image_scene: Option<super::image::ImageScene>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image_settings: Option<ImageSettings>,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) thumbnail: Option<String>,
    pub(crate) settings: ProjectSettings,
    pub(crate) brief: GenerationBrief,
    pub(crate) assets: Vec<ProjectAsset>,
    pub(crate) timeline: Timeline,
    #[serde(default)]
    pub(crate) references: Vec<ReusableReference>,
    #[serde(default)]
    pub(crate) generation_jobs: Vec<GenerationJob>,
    // Conversation is session state. Read the legacy key so old projects open,
    // but never write it back to slopus.json.
    #[serde(default, skip_serializing)]
    pub(crate) agent_conversation: AgentConversation,
    #[serde(default)]
    pub(crate) provider_settings: BTreeMap<String, ProviderSetting>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageSettings {
    pub(crate) resolution: String,
    pub(crate) aspect_ratio: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default_look: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) default_look: Option<String>,
    pub(crate) aspect_ratio: String,
    pub(crate) resolution: String,
    pub(crate) frame_rate: u32,
    pub(crate) background_color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationBrief {
    pub(crate) prompt: String,
    pub(crate) status: String,
    pub(crate) target_duration_seconds: u32,
    pub(crate) aspect_ratio: String,
    pub(crate) resolution: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SceneMediaSegment {
    pub(crate) scene_id: String,
    pub(crate) latent_relative_path: String,
    pub(crate) start_frame: u32,
    pub(crate) frame_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAsset {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    // Exactly one of the two locations. `relativePath` is a file COPIED into
    // the project folder (images, and anything generated here); `sourcePath` is
    // an absolute path to a file left where the user already keeps it (video
    // and audio, which are far too big to duplicate). Both keys are omitted
    // when absent rather than written as null — see the note on `durationMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_path: Option<String>,
    pub(crate) mime_type: String,
    // zod now spells these `.nullish()`, so an explicit `null` WOULD parse.
    // Keep skipping anyway: it is the shape the fixtures pin, and it keeps the
    // absent case unambiguous. Do not restate the old reason — the frontend
    // rejecting null was true once and is the sort of stale justification this
    // file's own rules warn about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) has_audio: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) scene_segments: Option<Vec<SceneMediaSegment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image_generation: Option<super::image::ImageGenerationSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) image_draft: Option<bool>,
    /// The family's primary image; the image bar shows it first, followed by
    /// the other versions. Choosing a primary keeps the family one level deep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) parent_asset_id: Option<String>,
    pub(crate) created_at: String,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct AgentConversation {
    #[serde(default)]
    pub(crate) messages: Vec<AgentMessage>,
}

impl ProjectAsset {
    pub(crate) fn clip_duration_ms(&self) -> Option<u64> {
        self.scene_segments.as_ref().and_then(|segments| segments.last())
            .map(|segment| (f64::from(segment.frame_count) * 1000.0 / 24.0).round() as u64)
            .or(self.duration_ms)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentMessage {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) created_at: String,
}

// Shared with the LAN worker, which receives provider settings with each job.
pub(crate) use slopus_core::settings::{ProviderOption, ProviderSetting};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectRecord {
    pub(crate) folder_path: String,
    pub(crate) config: ProjectConfig,
}
