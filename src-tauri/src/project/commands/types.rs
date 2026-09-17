use super::patch::Patch;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
pub const MAX_COMMANDS_PER_TURN: usize = 100;

/**
 * The provider-facing command vocabulary. It deliberately contains only fields
 * an agent is allowed to author. File locations, generated output, provider
 * settings, project identity, progress, and render state have no representation
 * here, so they cannot be changed accidentally or smuggled through a patch.
 */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum ProjectCommand {
    #[serde(rename = "project.set")]
    ProjectSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(
            default,
            rename = "targetSeconds",
            skip_serializing_if = "Option::is_none"
        )]
        target_seconds: Option<u32>,
        #[serde(
            default,
            rename = "aspectRatio",
            skip_serializing_if = "Option::is_none"
        )]
        aspect_ratio: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolution: Option<String>,
        #[serde(default, rename = "frameRate", skip_serializing_if = "Option::is_none")]
        frame_rate: Option<u32>,
        #[serde(
            default,
            rename = "backgroundColor",
            skip_serializing_if = "Option::is_none"
        )]
        background_color: Option<String>,
    },
    #[serde(rename = "ref.add")]
    ReferenceAdd {
        id: String,
        name: String,
        #[serde(rename = "text")]
        description: String,
        #[serde(rename = "use")]
        intended_use: Vec<String>,
    },
    #[serde(rename = "ref.set")]
    ReferenceSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, rename = "text", skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
        intended_use: Option<Vec<String>>,
    },
    #[serde(rename = "ref.remove")]
    ReferenceRemove { id: String },
    #[serde(rename = "scene.add")]
    SceneAdd {
        id: String,
        title: String,
        #[serde(rename = "seconds")]
        duration_seconds: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        music: Option<String>,
        #[serde(
            default,
            rename = "startFrame",
            skip_serializing_if = "Option::is_none"
        )]
        start_frame_reference_id: Option<String>,
        #[serde(default, rename = "endFrame", skip_serializing_if = "Option::is_none")]
        end_frame_reference_id: Option<String>,
        #[serde(
            default,
            rename = "usePreviousSceneLastFrame",
            skip_serializing_if = "Option::is_none"
        )]
        use_previous_scene_last_frame: Option<bool>,
    },
    #[serde(rename = "scene.set")]
    SceneSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, rename = "seconds", skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<i64>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        sound: Patch<String>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        music: Patch<String>,
        #[serde(
            default,
            rename = "startFrame",
            skip_serializing_if = "Patch::is_unchanged"
        )]
        start_frame_reference_id: Patch<String>,
        #[serde(
            default,
            rename = "endFrame",
            skip_serializing_if = "Patch::is_unchanged"
        )]
        end_frame_reference_id: Patch<String>,
        #[serde(
            default,
            rename = "usePreviousSceneLastFrame",
            skip_serializing_if = "Option::is_none"
        )]
        use_previous_scene_last_frame: Option<bool>,
    },
    #[serde(rename = "scene.remove")]
    SceneRemove { id: String },
    #[serde(rename = "scene.move")]
    SceneMove {
        id: String,
        #[serde(default)]
        before: Option<String>,
    },
    #[serde(rename = "shot.add")]
    ShotAdd {
        scene: String,
        id: String,
        #[serde(rename = "at")]
        start_seconds: f64,
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        speech: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<BTreeMap<String, Vec<String>>>,
    },
    #[serde(rename = "shot.set")]
    ShotSet {
        scene: String,
        id: String,
        #[serde(default, rename = "at", skip_serializing_if = "Option::is_none")]
        start_seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<String>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        name: Patch<String>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        speech: Patch<String>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        language: Patch<String>,
        #[serde(default, skip_serializing_if = "Patch::is_unchanged")]
        settings: Patch<BTreeMap<String, Vec<String>>>,
    },
    #[serde(rename = "shot.remove")]
    ShotRemove { scene: String, id: String },
    #[serde(rename = "clip.add")]
    ClipAdd {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scene: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        #[serde(default, rename = "sourceAt", skip_serializing_if = "Option::is_none")]
        source_at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "clip.set")]
    ClipSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        #[serde(default, rename = "sourceAt", skip_serializing_if = "Option::is_none")]
        source_at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "clip.remove")]
    ClipRemove { id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandBatch {
    pub summary: String,
    pub commands: Vec<ProjectCommand>,
}

#[derive(Deserialize)]
pub(super) struct Operation {
    pub(super) op: String,
}

#[derive(Deserialize)]
pub(super) struct CommitLine {
    pub(super) op: String,
    pub(super) summary: String,
}
pub(super) fn command_name(command: &ProjectCommand) -> &'static str {
    match command {
        ProjectCommand::ProjectSet { .. } => "project.set",
        ProjectCommand::ReferenceAdd { .. } => "ref.add",
        ProjectCommand::ReferenceSet { .. } => "ref.set",
        ProjectCommand::ReferenceRemove { .. } => "ref.remove",
        ProjectCommand::SceneAdd { .. } => "scene.add",
        ProjectCommand::SceneSet { .. } => "scene.set",
        ProjectCommand::SceneRemove { .. } => "scene.remove",
        ProjectCommand::SceneMove { .. } => "scene.move",
        ProjectCommand::ShotAdd { .. } => "shot.add",
        ProjectCommand::ShotSet { .. } => "shot.set",
        ProjectCommand::ShotRemove { .. } => "shot.remove",
        ProjectCommand::ClipAdd { .. } => "clip.add",
        ProjectCommand::ClipSet { .. } => "clip.set",
        ProjectCommand::ClipRemove { .. } => "clip.remove",
    }
}
