use crate::project::{lifecycle::*, storage::*, validation::validate_and_normalize_config, *};
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
#[tauri::command]
pub(crate) fn open_project(folder_path: String) -> Result<ProjectRecord, String> {
    read_project(Path::new(&folder_path))
}

#[tauri::command]
pub(crate) fn delete_project(folder_path: String, project_id: String) -> Result<(), String> {
    delete_project_folder(&folder_path, &project_id)
}

#[tauri::command]
pub(crate) fn choose_project_folder(app: AppHandle) -> Result<Option<ProjectRecord>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Open a Slopus project folder")
        .blocking_pick_folder();
    selected
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("Could not access selected folder: {error}"))
                .and_then(|path| read_project(&path))
        })
        .transpose()
}
#[tauri::command]
pub(crate) fn create_project(
    app: AppHandle,
    project_directory: Option<String>,
    config: ProjectConfig,
    initial_reference_paths: Option<Vec<String>>,
) -> Result<Option<ProjectRecord>, String> {
    let config = validate_and_normalize_config(config)?;
    let project_folder = match project_directory {
        Some(path) => PathBuf::from(path),
        None => match app
            .dialog()
            .file()
            .set_title("Choose an empty folder for this project")
            .blocking_pick_folder()
        {
            Some(path) => path
                .into_path()
                .map_err(|error| format!("Could not access selected folder: {error}"))?,
            None => return Ok(None),
        },
    };
    let reference_paths = initial_reference_paths
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    create_project_at_with_references(&project_folder, &config, &reference_paths).map(Some)
}

#[tauri::command]
pub(crate) fn save_project(folder_path: String, config: ProjectConfig) -> Result<(), String> {
    let folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    write_project(&folder, &config)
}
