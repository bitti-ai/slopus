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
use crate::project::ProjectConfig;

pub(crate) fn validate_and_normalize_config(mut config: ProjectConfig) -> Result<ProjectConfig, String> {
    settings::validate(&mut config)?;
    assets::validate(&mut config)?;
    references::validate(&mut config)?;
    super::migrations::normalize_timeline(&mut config)?;
    timeline::validate(&mut config)?;
    scenes::validate(&mut config)?;
    session::validate(&mut config)?;
    relationships::validate(&mut config)?;
    Ok(config)
}
