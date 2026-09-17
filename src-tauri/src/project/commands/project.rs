use crate::project::*;
use super::{types::ProjectCommand, batch::*, effects::Effects};
pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, _timestamp: &str, _effects: &mut Effects) -> Result<(), String> {
    match command {
        ProjectCommand::ProjectSet {
            name,
            prompt,
            target_seconds,
            aspect_ratio,
            resolution,
            frame_rate,
            background_color,
        } => {
            ensure_any(
                [
                    name.is_some(),
                    prompt.is_some(),
                    target_seconds.is_some(),
                    aspect_ratio.is_some(),
                    resolution.is_some(),
                    frame_rate.is_some(),
                    background_color.is_some(),
                ],
                "has no fields to change",
            )?;
            if let Some(value) = name {
                project.name = value.clone();
            }
            if let Some(value) = prompt {
                project.brief.prompt = value.clone();
            }
            if let Some(value) = target_seconds {
                project.brief.target_duration_seconds = *value;
            }
            if let Some(value) = aspect_ratio {
                project.settings.aspect_ratio = value.clone();
                project.brief.aspect_ratio = value.clone();
            }
            if let Some(value) = resolution {
                project.settings.resolution = value.clone();
                project.brief.resolution = value.clone();
            }
            if let Some(value) = frame_rate {
                project.settings.frame_rate = *value;
            }
            if let Some(value) = background_color {
                project.settings.background_color = value.clone();
            }
        }
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    Ok(())
}
