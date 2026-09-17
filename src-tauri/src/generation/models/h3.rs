use crate::project::SceneShot;
use std::sync::LazyLock;
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
    shot_catalog,
    validate_shot_settings: validate_agent_shot_settings,
    agent_instructions: include_str!("../../../assets/h3-agent.md"),
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShotGroup { id: String, multiple: bool, #[serde(default)] scene_wide: bool, options: Vec<ShotOption> }
#[derive(serde::Deserialize)]
struct ShotOption { id: String }
static GROUPS: LazyLock<Vec<ShotGroup>> = LazyLock::new(|| serde_json::from_str(include_str!("../../../../shared/models/minimax-h3-shot-tags.json")).expect("bundled H3 vocabulary"));
pub(crate) fn shot_catalog() -> String {
    GROUPS.iter().map(|group| format!("- {}: {}", group.id, group.options.iter().map(|option| option.id.as_str()).collect::<Vec<_>>().join(", "))).collect::<Vec<_>>().join("\n")
}
fn agent_setting_options(group: &str) -> Option<Vec<&'static str>> {
    GROUPS.iter().find(|candidate| candidate.id == group).map(|group| group.options.iter().map(|option| option.id.as_str()).collect())
}
fn shot_setting_values<'a>(shot: Option<&'a SceneShot>, group: &str) -> &'a [String] {
    shot.and_then(|value| value.settings.as_ref())
        .and_then(|settings| settings.get(group))
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub(crate) fn validate_agent_shot_settings(
    before: Option<&SceneShot>,
    shot: &SceneShot,
    earliest_shot_id: &str,
) -> Result<(), String> {
    if before.and_then(|value| value.settings.as_ref()) == shot.settings.as_ref() {
        return Ok(());
    }
    let Some(settings) = shot.settings.as_ref() else {
        return Ok(());
    };
    for (group, values) in settings {
        let before_values = shot_setting_values(before, group);
        if before_values == values {
            continue;
        }
        let allowed = agent_setting_options(group).ok_or_else(|| {
            format!(
                "Shot '{}' introduces unsupported Settings group '{}'. Use only the supported shot.settings catalog.",
                shot.id, group
            )
        })?;
        for option in values {
            if !allowed.contains(&option.as_str()) && !before_values.contains(option) {
                return Err(format!(
                    "Shot '{}' introduces unsupported Settings option '{}.{}'. Use an exact option id from the supported catalog.",
                    shot.id, group, option
                ));
            }
        }
        if !GROUPS.iter().find(|candidate| candidate.id == *group).is_some_and(|group| group.multiple) && values.len() > 1 {
            return Err(format!(
                "Shot '{}' gives single-choice Settings group '{}' more than one option.",
                shot.id, group
            ));
        }
        if GROUPS.iter().find(|candidate| candidate.id == *group).is_some_and(|group| group.scene_wide) && shot.id != earliest_shot_id {
            return Err(format!(
                "Shot '{}' puts scene Look on a later shot. Store visualStyle on the earliest shot only.",
                shot.id
            ));
        }
    }

    let movement = settings
        .get("cameraMovement")
        .map(Vec::as_slice)
        .unwrap_or_default();
    let speed = settings
        .get("cameraSpeed")
        .map(Vec::as_slice)
        .unwrap_or_default();
    let amplitude = settings
        .get("cameraAmplitude")
        .map(Vec::as_slice)
        .unwrap_or_default();
    let movement_controls_changed = ["cameraMovement", "cameraSpeed", "cameraAmplitude"]
        .iter()
        .any(|group| shot_setting_values(before, group) != shot_setting_values(Some(shot), group));
    if movement_controls_changed {
        if movement.contains(&"static-shot".to_string()) {
            if movement.len() > 1 || !speed.is_empty() || !amplitude.is_empty() {
                return Err(format!(
                    "Shot '{}' combines static-shot with another movement, speed, or amplitude.",
                    shot.id
                ));
            }
        } else if !movement.is_empty() && (speed.len() != 1 || amplitude.len() != 1) {
            return Err(format!(
                "Shot '{}' has camera movement but does not define exactly one cameraSpeed and cameraAmplitude.",
                shot.id
            ));
        } else if movement.is_empty() && (!speed.is_empty() || !amplitude.is_empty()) {
            return Err(format!(
                "Shot '{}' defines cameraSpeed or cameraAmplitude without cameraMovement.",
                shot.id
            ));
        }
    }
    Ok(())
}
