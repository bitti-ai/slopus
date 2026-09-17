//! The order is part of the persisted document compatibility contract.
mod values;
#[cfg(test)]
pub(crate) use values::is_iso_datetime;
mod settings;
mod assets;
mod references;
mod timeline;
mod scenes;
mod session;
mod relationships;
pub(crate) mod issue;
use crate::project::ProjectConfig;

pub(crate) fn validate_and_normalize_config(config: ProjectConfig) -> Result<ProjectConfig, String> {
    validate_checked(config).map_err(|issue| issue.message)
}

pub(crate) fn validate_checked(mut config: ProjectConfig) -> Result<ProjectConfig, issue::ValidationIssue> {
    settings::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "settings", message))?;
    assets::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "assets", message))?;
    references::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "references", message))?;
    super::migrations::normalize_timeline(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "migrations", message))?;
    timeline::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "timeline", message))?;
    scenes::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "scenes", message))?;
    session::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "session", message))?;
    relationships::validate(&mut config).map_err(|message| issue::ValidationIssue::new("project.invalid", Some(config.id.clone()), "relationships", message))?;
    Ok(config)
}
