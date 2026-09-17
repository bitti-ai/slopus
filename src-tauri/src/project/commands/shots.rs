use super::{batch::*, effects::Effects, types::ProjectCommand};
use crate::project::*;
pub(super) fn apply(
    project: &mut ProjectConfig,
    command: &ProjectCommand,
    timestamp: &str,
    effects: &mut Effects,
) -> Result<(), String> {
    match command {
        ProjectCommand::ShotAdd {
            scene,
            id,
            start_seconds,
            action,
            name,
            speech,
            language,
            settings,
        } => {
            effects.shots_changed(scene);
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shots = job.shots.get_or_insert_with(Vec::new);
            if shots.iter().any(|shot| shot.id == *id) {
                return Err(format!("shot '{id}' already exists in scene '{scene}'"));
            }
            shots.push(SceneShot {
                id: id.clone(),
                name: name.clone(),
                start_seconds: *start_seconds,
                action: action.clone(),
                speech: speech.clone(),
                speech_language: language.clone(),
                settings: settings.clone(),
            });
            job.updated_at = updated_at;
        }
        ProjectCommand::ShotSet {
            scene,
            id,
            start_seconds,
            action,
            name,
            speech,
            language,
            settings,
        } => {
            ensure_any(
                [
                    start_seconds.is_some(),
                    action.is_some(),
                    name.is_changed(),
                    speech.is_changed(),
                    language.is_changed(),
                    settings.is_changed(),
                ],
                "has no fields to change",
            )?;
            effects.shots_changed(scene);
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shot = job
                .shots
                .get_or_insert_with(Vec::new)
                .iter_mut()
                .find(|shot| shot.id == *id)
                .ok_or_else(|| format!("shot '{id}' was not found in scene '{scene}'"))?;
            if let Some(value) = start_seconds {
                shot.start_seconds = *value;
            }
            if let Some(value) = action {
                shot.action = value.clone();
            }
            if let Some(value) = name.value() {
                shot.name = value.clone();
            }
            if let Some(value) = speech.value() {
                shot.speech = value.clone();
            }
            if let Some(value) = language.value() {
                shot.speech_language = value.clone();
            }
            if let Some(value) = settings.value() {
                shot.settings = value.clone();
            }
            job.updated_at = updated_at;
        }
        ProjectCommand::ShotRemove { scene, id } => {
            effects.shots_changed(scene);
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shots = job.shots.get_or_insert_with(Vec::new);
            let at = shots
                .iter()
                .position(|shot| shot.id == *id)
                .ok_or_else(|| format!("shot '{id}' was not found in scene '{scene}'"))?;
            shots.remove(at);
            job.updated_at = updated_at;
        }
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    Ok(())
}
