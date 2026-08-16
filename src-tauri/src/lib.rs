use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const PROJECT_FILE_NAME: &str = "polstudio.project.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    schema_version: u32,
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    thumbnail: Option<String>,
    settings: ProjectSettings,
    brief: GenerationBrief,
    assets: Vec<ProjectAsset>,
    timeline: Timeline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSettings {
    aspect_ratio: String,
    resolution: String,
    frame_rate: u32,
    background_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationBrief {
    prompt: String,
    status: String,
    target_duration_seconds: u32,
    aspect_ratio: String,
    resolution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAsset {
    id: String,
    kind: String,
    name: String,
    relative_path: String,
    mime_type: String,
    duration_ms: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Timeline {
    tracks: Vec<TimelineTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TimelineTrack {
    id: String,
    kind: String,
    name: String,
    locked: bool,
    muted: bool,
    clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineClip {
    id: String,
    asset_id: String,
    track_id: String,
    start_ms: u64,
    duration_ms: u64,
    source_start_ms: u64,
    label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    folder_path: String,
    config: ProjectConfig,
}

fn validate_config(config: &ProjectConfig) -> Result<(), String> {
    if config.schema_version != 1 {
        return Err(format!(
            "Unsupported project schema version {}. This build supports version 1.",
            config.schema_version
        ));
    }
    if config.id.trim().is_empty() || config.name.trim().is_empty() {
        return Err("Project id and name cannot be empty.".into());
    }
    if config.brief.prompt.trim().is_empty() {
        return Err("Project brief cannot be empty.".into());
    }
    Ok(())
}

fn read_project(folder: &Path) -> Result<ProjectRecord, String> {
    if !folder.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    let canonical_folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    let config_path = canonical_folder.join(PROJECT_FILE_NAME);
    let json = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "Could not read {}: {error}",
            config_path.to_string_lossy()
        )
    })?;
    let config: ProjectConfig = serde_json::from_str(&json)
        .map_err(|error| format!("Project config is not valid: {error}"))?;
    validate_config(&config)?;
    Ok(ProjectRecord {
        folder_path: canonical_folder.to_string_lossy().into_owned(),
        config,
    })
}

fn write_project(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    validate_config(config)?;
    if !folder.is_dir() {
        return Err("Project folder does not exist.".into());
    }
    let json = serde_json::to_string_pretty(config)
        .map_err(|error| format!("Could not serialize project: {error}"))?;
    let destination = folder.join(PROJECT_FILE_NAME);
    let temporary = folder.join(format!("{PROJECT_FILE_NAME}.tmp"));
    fs::write(&temporary, format!("{json}\n"))
        .map_err(|error| format!("Could not write project config: {error}"))?;
    if destination.exists() {
        fs::remove_file(&destination)
            .map_err(|error| format!("Could not replace existing project config: {error}"))?;
    }
    fs::rename(&temporary, &destination)
        .map_err(|error| format!("Could not finalize project config: {error}"))?;
    Ok(())
}

fn safe_folder_name(name: &str) -> String {
    let mut value: String = name
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            character if character.is_control() => '-',
            character => character,
        })
        .collect();
    value = value.trim().trim_matches('.').to_string();
    if value.is_empty() {
        "Untitled video".into()
    } else {
        value.chars().take(80).collect()
    }
}

#[tauri::command]
fn open_project(folder_path: String) -> Result<ProjectRecord, String> {
    read_project(Path::new(&folder_path))
}

#[tauri::command]
fn choose_project_folder(app: AppHandle) -> Result<Option<ProjectRecord>, String> {
    let selected = app
        .dialog()
        .file()
        .set_title("Open a Pol Studio project folder")
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
fn create_project(
    app: AppHandle,
    parent_directory: Option<String>,
    config: ProjectConfig,
) -> Result<Option<ProjectRecord>, String> {
    validate_config(&config)?;
    let parent = match parent_directory {
        Some(path) => PathBuf::from(path),
        None => match app
            .dialog()
            .file()
            .set_title("Choose where to create this project")
            .blocking_pick_folder()
        {
            Some(path) => path
                .into_path()
                .map_err(|error| format!("Could not access selected folder: {error}"))?,
            None => return Ok(None),
        },
    };
    if !parent.is_dir() {
        return Err("The selected parent folder does not exist.".into());
    }
    let project_folder = parent.join(safe_folder_name(&config.name));
    if project_folder.exists() {
        return Err(format!(
            "A folder named ‘{}’ already exists there. Rename the project or choose another location.",
            safe_folder_name(&config.name)
        ));
    }
    fs::create_dir(&project_folder)
        .map_err(|error| format!("Could not create project folder: {error}"))?;
    for child in ["assets", "generated", "exports", "cache"] {
        fs::create_dir(project_folder.join(child))
            .map_err(|error| format!("Could not create {child} folder: {error}"))?;
    }
    if let Err(error) = write_project(&project_folder, &config) {
        let _ = fs::remove_dir_all(&project_folder);
        return Err(error);
    }
    read_project(&project_folder).map(Some)
}

#[tauri::command]
fn save_project(
    folder_path: String,
    config: ProjectConfig,
) -> Result<(), String> {
    let folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    write_project(&folder, &config)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            choose_project_folder,
            create_project,
            save_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pol Studio");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ProjectConfig {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "id": "project-1",
            "name": "Launch Film",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "thumbnail": null,
            "settings": { "aspectRatio": "16:9", "resolution": "4k", "frameRate": 30, "backgroundColor": "#10131a" },
            "brief": { "prompt": "A product launch", "status": "draft", "targetDurationSeconds": 60, "aspectRatio": "16:9", "resolution": "4k" },
            "assets": [],
            "timeline": { "tracks": [] }
        })).unwrap()
    }

    #[test]
    fn project_round_trip_uses_stable_file_name() {
        let root = tempfile::tempdir().unwrap();
        write_project(root.path(), &fixture()).unwrap();
        let record = read_project(root.path()).unwrap();
        assert_eq!(record.config.name, "Launch Film");
        assert!(root.path().join(PROJECT_FILE_NAME).is_file());
    }

    #[test]
    fn sanitizes_folder_names() {
        assert_eq!(safe_folder_name("  Launch: Film?  "), "Launch- Film-");
        assert_eq!(safe_folder_name("..."), "Untitled video");
    }
}
