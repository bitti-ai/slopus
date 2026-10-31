use super::{
    paths::display_path, validation::validate_and_normalize_config, AgentConversation,
    ProjectConfig, ProjectRecord,
};
use crate::storage::atomic::atomic_replace;
use std::{
    fs, io,
    path::{Path, PathBuf},
};
pub(crate) const PROJECT_FILE_NAME: &str = "slopus.json";
static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
/// What the file was called before, newest first. Folders written by earlier
/// builds still open; the next save writes `slopus.json` and leaves the old
/// file alone, so a project stays readable by the build that made it.
pub(crate) const LEGACY_PROJECT_FILE_NAMES: [&str; 3] =
    ["polstudio.json", "pols.json", "polstudio.project.json"];
/// The settings file to READ from a project folder: the current name if it is
/// there, otherwise the first legacy name that is. Returns the current name
/// when the folder holds none of them, so the caller reports a missing
/// `slopus.json` rather than a file nobody has written since 2025.
pub(crate) fn project_file_in(folder: &Path) -> PathBuf {
    let current = folder.join(PROJECT_FILE_NAME);
    if current.is_file() {
        return current;
    }
    LEGACY_PROJECT_FILE_NAMES
        .iter()
        .map(|name| folder.join(name))
        .find(|path| path.is_file())
        .unwrap_or(current)
}

pub(crate) fn read_project(folder: &Path) -> Result<ProjectRecord, String> {
    if !folder.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    let canonical_folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    let config_path = project_file_in(&canonical_folder);
    let json = fs::read_to_string(&config_path)
        .map_err(|error| format!("Could not read {}: {error}", config_path.to_string_lossy()))?;
    let config: ProjectConfig = serde_json::from_str(&json)
        .map_err(|error| format!("Project config is not valid: {error}"))?;
    let mut config = validate_and_normalize_config(config)?;
    config.agent_conversation = AgentConversation::default();
    Ok(ProjectRecord {
        folder_path: display_path(&canonical_folder),
        config,
    })
}

/// Desktop entry point, also used for every recent project on startup. Internal
/// reads stay side-effect-free so generation and saves cannot trigger a sweep.
pub(crate) fn open_project_with_migrations(folder: &Path) -> Result<ProjectRecord, String> {
    let _write = WRITES.lock().map_err(|_| "Project save lock was poisoned.".to_string())?;
    let record = read_project(folder)?;
    if let Err(error) = super::cleanup::migrate_on_open(folder, &record.config) {
        // Cleanup must not prevent editing a readable project. Failed scans
        // remain unmarked and retry at the next launch, before new jobs start.
        crate::diagnostics::warn("project", "cleanup.migration_failed", &error,
            serde_json::json!({"folder": record.folder_path}));
    }
    Ok(record)
}

pub(crate) fn write_project(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    write_project_with_replacer(folder, config, atomic_replace)
}

pub(crate) fn write_project_protected(folder: &Path, config: &ProjectConfig, protected_paths: &[String]) -> Result<(), String> {
    write_project_impl(folder, config, protected_paths, atomic_replace)
}

pub(crate) fn write_project_with_replacer<F>(
    folder: &Path,
    config: &ProjectConfig,
    replacer: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    write_project_impl(folder, config, &[], replacer)
}

fn write_project_impl<F>(folder: &Path, config: &ProjectConfig, protected_paths: &[String], replacer: F) -> Result<(), String>
where F: FnOnce(&Path, &Path) -> io::Result<()> {
    // Keep the old-document comparison, commit and cleanup in one ordered
    // operation even when desktop commands save different sessions concurrently.
    let _write = WRITES.lock().map_err(|_| "Project save lock was poisoned.".to_string())?;
    let config = validate_and_normalize_config(config.clone())?;
    if !folder.is_dir() {
        return Err("Project folder does not exist.".into());
    }
    let previous = if project_file_in(folder).exists() { Some(read_project(folder)?.config) } else { None };
    let cleanup = super::cleanup::Cleanup::prepare(folder, previous.as_ref(), &config)?;
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize project: {error}"))?;
    let destination = folder.join(PROJECT_FILE_NAME);
    crate::storage::atomic::write_with_replacer(
        &destination,
        format!("{json}\n").as_bytes(),
        replacer,
    )
    .map_err(|error| format!("Could not write project config: {error}"))?;
    cleanup.finish(protected_paths);
    Ok(())
}
