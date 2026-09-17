use crate::project::paths::*;
use crate::media::{access::*, import::*};
use std::{fs, path::PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
#[tauri::command]
pub(crate) fn choose_initial_reference_images(app: AppHandle) -> Result<Vec<PendingReferenceImage>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Add references to the project brief")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_files()
        .unwrap_or_default();
    selected
        .into_iter()
        .map(|path| {
            let source = path
                .into_path()
                .map_err(|error| format!("Could not access selected image: {error}"))?;
            validate_reference_image(&source)?;
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Image reference")
                .to_string();
            Ok(PendingReferenceImage {
                // Never a verbatim path: this one is shown in the composer
                // beside the file's name before the project even exists.
                source_path: display_path(&source),
                name,
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn choose_reference_image(
    app: AppHandle,
    folder_path: String,
) -> Result<Option<ImportedReferenceImage>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Add an image reference")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let source = selected
        .into_path()
        .map_err(|error| format!("Could not access selected image: {error}"))?;
    if !source.is_file() {
        return Err("The selected image does not exist.".into());
    }
    let project_folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    copy_reference_image(&source, &project_folder).map(Some)
}

#[tauri::command]
pub(crate) fn choose_reference_images(
    app: AppHandle,
    folder_path: String,
) -> Result<Vec<ImportedReferenceImage>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Add reference images")
        .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_files()
        .unwrap_or_default();
    if selected.is_empty() {
        return Ok(Vec::new());
    }
    let project_folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    selected
        .into_iter()
        .map(|path| {
            let source = path
                .into_path()
                .map_err(|error| format!("Could not access selected image: {error}"))?;
            copy_reference_image(&source, &project_folder)
        })
        .collect()
}
/// Hands the webview the bytes of one file inside a project, so it can show a
/// reference image the user imported. Confined to a real project folder, twice
/// over: the folder must actually contain the settings file, and the relative
/// path goes through the same normaliser every stored path does and is then
/// checked to still sit under the canonical root. So a crafted `..` in a
/// hand-edited slopus.json cannot read the rest of the disk, and a caller
/// that names some other folder entirely does not get a reader for it.
#[tauri::command]
pub(crate) fn read_project_file(
    folder_path: String,
    relative_path: String,
) -> Result<tauri::ipc::Response, String> {
    let root = project_root(&folder_path)?;
    let relative = normalize_project_path(&relative_path)?;
    let target = root
        .join(&relative)
        .canonicalize()
        .map_err(|error| format!("Could not resolve {relative}: {error}"))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(format!("{relative} is not a file inside this project."));
    }
    let bytes = fs::read(&target).map_err(|error| format!("Could not read {relative}: {error}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
/// The bytes of one file the project points at but does not contain.
///
/// Video and audio are no longer copied in, so the webview has to be able to
/// read them where they are — and that is exactly the shape of an arbitrary
/// file read. Read the rule literally, because it is wider than "the user
/// picked this file" and pretending otherwise is how the next reader is fooled:
///
/// 1. The folder named must actually hold a project, and the path asked for
///    must be one that project NAMES — either written in its `slopus.json`
///    on disk (canonicalised on both sides before comparing), or picked from a
///    native dialog for THAT project earlier in this run. The session list
///    exists because saving is deliberate: a clip imported a moment ago is not
///    in the project file yet.
/// 2. It must still carry a media extension Slopus imports (checked on the
///    canonicalised path, so a symlink is judged by its target), so no project
///    file can turn this into a reader for keys, wallets or documents.
/// 3. It must be a regular file that exists now.
///
/// So the actor whose choice opens a file is the PROJECT FILE, not necessarily
/// the person. A `slopus.json` the user merely OPENED — a template a
/// colleague sent, an unzipped project, anything they double-clicked without
/// reading — can name `C:\Users\NN\Pictures\private.jpg` and this command will
/// serve those bytes to the webview. What bounds the damage is rule 2 (media
/// only, never credentials) and rule 1's scoping (one project's picks are not
/// another's). What does NOT bound it is the caller's good intentions, and
/// nothing here should be described as "the user chose it".
///
/// This is inherent to trusting ANY project file the user opens — not to
/// recording external paths, which is a weaker requirement. The narrowing that
/// exists and has NOT been built is a per-installation approval list, kept by
/// Rust beside the settings file (never in localStorage — the webview must not
/// be the authority on what it may read): a project created or approved on this
/// machine reopens silently, while a `slopus.json` that arrived from
/// somewhere else has its external paths treated as offline until relinked.
/// That is also better product behaviour, because an absolute path written on
/// another machine is almost certainly wrong here — if it resolves at all, it
/// resolves to a file the sender never meant. Approve-once-and-remember rather
/// than refuse, so a genuinely shared project on a shared drive still works.
/// Until that exists, read the rule above literally.
///
/// What it deliberately does NOT do is trust the caller's string: an argument
/// the project does not name is refused whatever it points at.
#[tauri::command]
pub(crate) fn read_external_media_file(
    folder_path: String,
    source_path: String,
) -> Result<tauri::ipc::Response, String> {
    external_media_bytes(&folder_path, &source_path).map(tauri::ipc::Response::new)
}

/// Adds the chosen files to the project: images are copied in, video and audio
/// are recorded where they already are. An empty list means the user cancelled.
#[tauri::command]
pub(crate) fn import_media_files(
    app: AppHandle,
    folder_path: String,
) -> Result<Vec<ImportedMediaFile>, String> {
    let project_folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    let selected = app
        .dialog()
        .file()
        .set_title("Add media to this project")
        .add_filter("Media", MEDIA_EXTENSIONS)
        .blocking_pick_files();
    let Some(selected) = selected else {
        return Ok(Vec::new());
    };
    selected
        .into_iter()
        .map(|path| {
            let source = path
                .into_path()
                .map_err(|error| format!("Could not access the selected file: {error}"))?;
            import_media_file(&source, &project_folder)
        })
        .collect()
}
#[tauri::command]
pub(crate) fn choose_reference_video(app: AppHandle, folder_path: String) -> Result<Option<String>, String> {
    let root = project_root(&folder_path)?;
    let picked = app.dialog().file().set_title("Add a video reference")
        .add_filter("MP4 video", &["mp4", "m4v", "mov"]).blocking_pick_file();
    let Some(picked) = picked else { return Ok(None); };
    let path = picked.into_path().map_err(|error| format!("Could not access selected video: {error}"))?;
    if !path.is_file() { return Err("The selected video does not exist.".into()); }
    picked_external_source_path(&path, &root).map(Some)
}

#[tauri::command]
pub(crate) fn choose_reference_files(app: AppHandle, folder_path: String) -> Result<Vec<ImportedReference>, String> {
    let root = project_root(&folder_path)?;
    let selected = app.dialog().file().set_title("Add reference files")
        .add_filter("Images, videos and refmods", &["png", "jpg", "jpeg", "webp", "mp4", "m4v", "mov", "safetensors"])
        .blocking_pick_files().unwrap_or_default();
    let paths = selected.into_iter().map(|path| path.into_path().map_err(|error| format!("Could not access selected file: {error}")))
        .collect::<Result<Vec<_>, _>>()?;
    import_reference_attachments(&root, &paths)
}
