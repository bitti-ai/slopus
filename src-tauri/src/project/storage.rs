use super::{ProjectConfig, ProjectRecord, AgentConversation, validation::validate_and_normalize_config, paths::display_path};
use crate::storage::atomic::atomic_replace;
use std::{fs, io, path::{Path, PathBuf}, sync::atomic::{AtomicU64, Ordering}};
pub(crate) const PROJECT_FILE_NAME: &str = "slopus.json";
/// What the file was called before, newest first. Folders written by earlier
/// builds still open; the next save writes `slopus.json` and leaves the old
/// file alone, so a project stays readable by the build that made it.
pub(crate) const LEGACY_PROJECT_FILE_NAMES: [&str; 3] =
    ["polstudio.json", "pols.json", "polstudio.project.json"];
pub(crate) static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);
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

pub(crate) fn write_project(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    write_project_with_replacer(folder, config, atomic_replace)
}

pub(crate) fn write_project_with_replacer<F>(
    folder: &Path,
    config: &ProjectConfig,
    replacer: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let config = validate_and_normalize_config(config.clone())?;
    if !folder.is_dir() {
        return Err("Project folder does not exist.".into());
    }
    let json = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Could not serialize project: {error}"))?;
    let destination = folder.join(PROJECT_FILE_NAME);
    let sequence = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = folder.join(format!(
        ".{PROJECT_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let write_result = (|| -> io::Result<()> {
        use io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(format!("{json}\n").as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not write project config: {error}"));
    }
    if let Err(error) = replacer(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not finalize project config: {error}"));
    }
    Ok(())
}
