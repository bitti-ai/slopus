use super::{batch::*, effects::Effects, types::ProjectCommand};
use crate::project::*;
pub(super) fn apply(
    project: &mut ProjectConfig,
    command: &ProjectCommand,
    timestamp: &str,
    effects: &mut Effects,
) -> Result<(), String> {
    match command {
        ProjectCommand::SceneAdd {
            id,
            title,
            duration_seconds,
            steps,
            seed,
            sound,
            music,
            start_frame_reference_id,
            end_frame_reference_id,
            use_previous_scene_last_frame,
        } => {
            if project.generation_jobs.iter().any(|job| job.id == *id) {
                return Err(format!("scene '{id}' already exists"));
            }
            let mut job = GenerationJob::draft(id, title, timestamp, effects.defaults);
            job.duration_seconds = Some(*duration_seconds);
            job.steps = *steps;
            job.seed = *seed;
            job.soundscape = sound.clone();
            job.music = music.clone();
            job.start_frame_reference_id = start_frame_reference_id.clone();
            job.end_frame_reference_id = end_frame_reference_id.clone();
            job.use_previous_scene_last_frame = *use_previous_scene_last_frame;
            project.generation_jobs.push(job);
        }
        ProjectCommand::SceneSet {
            id,
            title,
            duration_seconds,
            steps,
            seed,
            sound,
            music,
            start_frame_reference_id,
            end_frame_reference_id,
            use_previous_scene_last_frame,
        } => {
            ensure_any(
                [
                    title.is_some(),
                    duration_seconds.is_some(),
                    steps.is_some(),
                    seed.is_some(),
                    sound.is_changed(),
                    music.is_changed(),
                    start_frame_reference_id.is_changed(),
                    end_frame_reference_id.is_changed(),
                    use_previous_scene_last_frame.is_some(),
                ],
                "has no fields to change",
            )?;
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, id)?;
            if let Some(value) = title {
                job.title = value.clone();
            }
            if let Some(value) = duration_seconds {
                job.duration_seconds = Some(*value);
            }
            if let Some(value) = steps {
                job.steps = Some(*value);
            }
            if let Some(value) = seed {
                job.seed = Some(*value);
            }
            if let Some(value) = sound.value() {
                job.soundscape = value.clone();
            }
            if let Some(value) = music.value() {
                job.music = value.clone();
            }
            if let Some(value) = start_frame_reference_id.value() {
                job.start_frame_reference_id = value.clone();
                job.use_previous_scene_last_frame = None;
            }
            if let Some(value) = end_frame_reference_id.value() {
                job.end_frame_reference_id = value.clone();
            }
            if let Some(value) = use_previous_scene_last_frame {
                job.use_previous_scene_last_frame = Some(*value);
                if *value {
                    job.start_frame_reference_id = None;
                }
            }
            job.updated_at = updated_at;
        }
        ProjectCommand::SceneRemove { id } => {
            let at = project
                .generation_jobs
                .iter()
                .position(|job| job.id == *id)
                .ok_or_else(|| format!("scene '{id}' was not found"))?;
            project.generation_jobs.remove(at);
        }
        ProjectCommand::SceneMove { id, before } => {
            let at = project
                .generation_jobs
                .iter()
                .position(|job| job.id == *id)
                .ok_or_else(|| format!("scene '{id}' was not found"))?;
            if before.as_deref() == Some(id) {
                return Err("a scene cannot be moved before itself".into());
            }
            let moving = project.generation_jobs.remove(at);
            let destination = match before {
                Some(before_id) => project
                    .generation_jobs
                    .iter()
                    .position(|job| job.id == *before_id)
                    .ok_or_else(|| format!("destination scene '{before_id}' was not found"))?,
                None => project.generation_jobs.len(),
            };
            project.generation_jobs.insert(destination, moving);
        }
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    Ok(())
}
