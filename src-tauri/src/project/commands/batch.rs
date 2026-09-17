use crate::project::validation::{validate_checked, issue::ValidationIssue};
use crate::project::{ProjectConfig, GenerationJob};
use super::{types::*, effects::Effects};
/** Apply a complete batch to a clone. Callers validate agent conventions after
 * this returns; neither a command error nor a validator error mutates input. */
#[cfg(test)]
pub fn execute_commands(
    current: &ProjectConfig,
    commands: &[ProjectCommand],
) -> Result<ProjectConfig, String> {
    execute_commands_at(current, commands, &current.updated_at)
}

pub fn execute_commands_at(
    current: &ProjectConfig,
    commands: &[ProjectCommand],
    timestamp: &str,
) -> Result<ProjectConfig, String> {
    execute_with_defaults(current, commands, timestamp, crate::generation::models::default_model().defaults)
}

pub(crate) fn execute_with_defaults(
    current: &ProjectConfig,
    commands: &[ProjectCommand],
    timestamp: &str,
    defaults: crate::generation::models::SceneDefaults,
) -> Result<ProjectConfig, String> {
    execute_checked(current, commands, timestamp, defaults).map_err(|issue| issue.message)
}

pub(crate) fn execute_checked(current: &ProjectConfig, commands: &[ProjectCommand], timestamp: &str, defaults: crate::generation::models::SceneDefaults) -> Result<ProjectConfig, ValidationIssue> {
    if commands.is_empty() {
        return Err(ValidationIssue::new("commands.empty", None, "commands", "Agent command batch cannot be empty.".into()));
    }
    if commands.len() > MAX_COMMANDS_PER_TURN {
        return Err(ValidationIssue::new("commands.limit", None, "commands", format!("Agent command batch exceeds the limit of {MAX_COMMANDS_PER_TURN} commands.")));
    }
    let mut next = current.clone();
    let mut effects = Effects::new(defaults);
    for (index, command) in commands.iter().enumerate() {
        apply_command(&mut next, command, timestamp, &mut effects).map_err(|error| {
            ValidationIssue::new("command.invalid", Some((index + 1).to_string()), command_name(command), format!("Command {} ({}): {error}", index + 1, command_name(command)))
        })?;
    }
    effects.synchronize(&mut next).map_err(|message| ValidationIssue::new("scene.derived", None, "shots", message))?;
    validate_checked(next)
}

fn apply_command(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str, effects: &mut Effects) -> Result<(), String> {
    match command {
        ProjectCommand::ProjectSet { .. } => super::project::apply(project, command, timestamp, effects),
        ProjectCommand::ReferenceAdd { .. } | ProjectCommand::ReferenceSet { .. } | ProjectCommand::ReferenceRemove { .. } => super::references::apply(project, command, timestamp, effects),
        ProjectCommand::SceneAdd { .. } | ProjectCommand::SceneSet { .. } | ProjectCommand::SceneRemove { .. } | ProjectCommand::SceneMove { .. } => super::scenes::apply(project, command, timestamp, effects),
        ProjectCommand::ShotAdd { .. } | ProjectCommand::ShotSet { .. } | ProjectCommand::ShotRemove { .. } => super::shots::apply(project, command, timestamp, effects),
        ProjectCommand::ClipAdd { .. } | ProjectCommand::ClipSet { .. } | ProjectCommand::ClipRemove { .. } => super::clips::apply(project, command, timestamp, effects),
    }
}
pub(super) fn find_scene_mut<'a>(
    project: &'a mut ProjectConfig,
    id: &str,
) -> Result<&'a mut GenerationJob, String> {
    project
        .generation_jobs
        .iter_mut()
        .find(|job| job.id == id)
        .ok_or_else(|| format!("scene '{id}' was not found"))
}

pub(super) fn ensure_any<const N: usize>(fields: [bool; N], error: &str) -> Result<(), String> {
    fields
        .into_iter()
        .any(|field| field)
        .then_some(())
        .ok_or_else(|| error.into())
}
