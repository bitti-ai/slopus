use crate::project::{*, paths::*, storage::read_project};
use std::{fs, path::{Path, PathBuf}, collections::{BTreeMap, BTreeSet}};
use super::import::media_kind_and_mime;
/// Files the user chose from the OS picker in THIS run, canonicalised, keyed by
/// the canonical folder of the project they were picked FOR.
///
/// The project file on disk is the durable record of what may be read from
/// outside the folder, but it lags: saving is a deliberate act, so a clip
/// imported a second ago is not in it yet and its preview would be refused as
/// "not one of the files this project points at". This map closes that gap
/// without widening anything — every entry got here because the user picked
/// that exact file in a native dialog, for that one project.
///
/// The key is the point. A flat list was process-global, so importing your own
/// rushes and then opening a colleague's project let THEIR project file name
/// and read YOUR footage: nothing in the read path could tell which project a
/// pick belonged to. Entries are never written to disk and never survive a
/// restart; the project file does that.
#[derive(Default)]
pub(crate) struct MediaAccess { picked: std::sync::Mutex<BTreeMap<PathBuf, BTreeSet<PathBuf>>> }

/// The identity a project folder is remembered by. Canonical, so one folder
/// spelled two ways is one key. `None` when the folder cannot be resolved, in
/// which case nothing is remembered and the project file on disk stays the only
/// allow-list.
pub(crate) fn session_key(project_folder: &Path) -> Option<PathBuf> {
    project_folder.canonicalize().ok()
}

pub(crate) fn remember_picked_file(access: &MediaAccess, project_folder: &Path, path: &Path) {
    let (Some(key), Ok(canonical)) = (session_key(project_folder), path.canonicalize()) else {
        return;
    };
    // A poisoned lock only means another thread panicked mid-insert; the
    // fallback is the project file, so there is nothing to escalate here.
    if let Ok(mut picked) = access.picked.lock() {
        picked.entry(key).or_default().insert(canonical);
    }
}

/// Was this file picked in this run *for this project*? A pick made while a
/// different project was open is not an answer here.
pub(crate) fn was_picked_for_project(access: &MediaAccess, project_folder: &Path, canonical: &Path) -> bool {
    let Some(key) = session_key(project_folder) else {
        return false;
    };
    access.picked
        .lock()
        .map(|picked| {
            picked
                .get(&key)
                .is_some_and(|files| files.contains(canonical))
        })
        .unwrap_or(false)
}

/// The absolute, prefix-free path this project will remember a file by.
/// Canonicalised so it survives a working-directory change and so the
/// containment check in `read_external_media_file` compares like with like,
/// then run through `display_path` so no `\\?\` ever reaches the project file
/// or the UI, and finally through the same validator the schema applies.
pub(crate) fn external_source_path(source: &Path) -> Result<String, String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", source.to_string_lossy()))?;
    normalize_external_path(&display_path(&canonical))
}

/// The same path, and a note that the user just chose this file FOR this
/// project — so its preview works before the project has been saved. Only the
/// import paths call this, and they only run on what came back from a native
/// picker.
pub(crate) fn picked_external_source_path(access: &MediaAccess, source: &Path, project_folder: &Path) -> Result<String, String> {
    let path = external_source_path(source)?;
    remember_picked_file(access, project_folder, source);
    Ok(path)
}
/// Every absolute path this project has recorded — the media and references
/// that live OUTSIDE the folder. It is the allow-list for
/// `read_external_media_file`: the webview may read a file outside the project
/// only because the project itself names it.
pub(crate) fn recorded_external_paths(config: &ProjectConfig) -> Vec<String> {
    config
        .assets
        .iter()
        .filter_map(|asset| asset.source_path.clone())
        .chain(
            config
                .references
                .iter()
                .filter_map(|reference| reference.source_path.clone()),
        )
        .collect()
}
pub(crate) fn external_media_bytes(access: &MediaAccess, folder_path: &str, source_path: &str) -> Result<Vec<u8>, String> {
    let root = project_root(folder_path)?;
    let project = read_project(&root)?;
    let requested = PathBuf::from(&source_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve {source_path}: {error}"))?;
    let recorded = recorded_external_paths(&project.config)
        .into_iter()
        .any(|path| {
            PathBuf::from(&path)
                .canonicalize()
                .map(|canonical| canonical == requested)
                .unwrap_or(false)
        });
    if !recorded && !was_picked_for_project(access, &root, &requested) {
        return Err(format!(
            "{source_path} is not one of the files this project points at."
        ));
    }
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if media_kind_and_mime(&extension).is_none() || !requested.is_file() {
        return Err(format!("{source_path} is not a media file Slopus reads."));
    }
    fs::read(&requested).map_err(|error| format!("Could not read {source_path}: {error}"))
}
