use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const PROJECT_FILE_NAME: &str = "polstudio.project.json";
const PROJECT_DIRECTORIES: [&str; 6] = [
    "media/imported",
    "media/generated",
    "references",
    "thumbnails",
    "cache",
    "exports",
];
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    #[serde(default)]
    references: Vec<ReusableReference>,
    #[serde(default)]
    generation_jobs: Vec<GenerationJob>,
    #[serde(default)]
    agent_conversation: AgentConversation,
    #[serde(default)]
    provider_settings: BTreeMap<String, ProviderSetting>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSettings {
    aspect_ratio: String,
    resolution: String,
    frame_rate: u32,
    background_color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationBrief {
    prompt: String,
    status: String,
    target_duration_seconds: u32,
    aspect_ratio: String,
    resolution: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Timeline {
    tracks: Vec<TimelineTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct TimelineTrack {
    id: String,
    kind: String,
    name: String,
    locked: bool,
    muted: bool,
    clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReusableReference {
    id: String,
    kind: String,
    name: String,
    content: Option<String>,
    relative_path: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationJob {
    id: String,
    status: String,
    provider_id: Option<String>,
    creative_brief: String,
    compiled_prompt: String,
    #[serde(default)]
    reference_ids: Vec<String>,
    output_relative_path: Option<String>,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct AgentConversation {
    #[serde(default)]
    messages: Vec<AgentMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentMessage {
    id: String,
    role: String,
    content: String,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ProviderSetting {
    enabled: bool,
    model: Option<String>,
    #[serde(default)]
    options: BTreeMap<String, ProviderOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
enum ProviderOption {
    String(String),
    Number(f64),
    Boolean(bool),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectRecord {
    folder_path: String,
    config: ProjectConfig,
}

fn normalize_project_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("Project paths cannot be empty or contain null bytes.".into());
    }
    let scheme_or_drive_prefix = value
        .find(':')
        .map(|colon| {
            colon > 0
                && value.as_bytes()[0].is_ascii_alphabetic()
                && value.as_bytes()[..colon]
                    .iter()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'+' | b'-' | b'.'))
        })
        .unwrap_or(false);
    if value.starts_with('/') || value.starts_with('\\') || scheme_or_drive_prefix {
        return Err("Project paths must be relative to the project root.".into());
    }
    let mut normalized = Vec::new();
    let portable = value.replace('\\', "/");
    for component in portable.split('/') {
        match component {
            "" | "." => {}
            ".." => return Err("Project paths cannot traverse outside the project root.".into()),
            value => normalized.push(value),
        }
    }
    if normalized.is_empty() {
        return Err("Project paths must point to an item below the project root.".into());
    }
    Ok(normalized.join("/"))
}

fn validate_and_normalize_config(mut config: ProjectConfig) -> Result<ProjectConfig, String> {
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
    config.thumbnail = config
        .thumbnail
        .as_deref()
        .map(normalize_project_path)
        .transpose()?;
    for asset in &mut config.assets {
        if asset.id.trim().is_empty() || asset.name.trim().is_empty() {
            return Err("Asset id and name cannot be empty.".into());
        }
        asset.relative_path = normalize_project_path(&asset.relative_path)?;
    }
    for reference in &mut config.references {
        if reference.id.trim().is_empty() || reference.name.trim().is_empty() {
            return Err("Reference id and name cannot be empty.".into());
        }
        reference.relative_path = reference
            .relative_path
            .as_deref()
            .map(normalize_project_path)
            .transpose()?;
        match reference.kind.as_str() {
            "text"
                if reference
                    .content
                    .as_deref()
                    .is_some_and(|value| !value.is_empty()) => {}
            "image" if reference.relative_path.is_some() => {}
            "text" => return Err("Text references require content.".into()),
            "image" => return Err("Image references require a relative path.".into()),
            _ => return Err(format!("Unsupported reference kind '{}'.", reference.kind)),
        }
    }
    for job in &mut config.generation_jobs {
        if job.id.trim().is_empty()
            || job.creative_brief.trim().is_empty()
            || job.compiled_prompt.trim().is_empty()
        {
            return Err(
                "Generation job id, creative brief, and compiled prompt cannot be empty.".into(),
            );
        }
        if !matches!(
            job.status.as_str(),
            "draft" | "queued" | "generating" | "ready" | "failed" | "cancelled"
        ) {
            return Err(format!(
                "Unsupported generation job status '{}'.",
                job.status
            ));
        }
        job.output_relative_path = job
            .output_relative_path
            .as_deref()
            .map(normalize_project_path)
            .transpose()?;
    }
    for message in &config.agent_conversation.messages {
        if message.id.trim().is_empty() || message.content.trim().is_empty() {
            return Err("Agent message id and content cannot be empty.".into());
        }
        if !matches!(message.role.as_str(), "user" | "assistant" | "system") {
            return Err(format!(
                "Unsupported agent message role '{}'.",
                message.role
            ));
        }
    }
    for (provider_id, setting) in &config.provider_settings {
        if provider_id.trim().is_empty() {
            return Err("Provider setting ids cannot be empty.".into());
        }
        if setting
            .model
            .as_deref()
            .is_some_and(|model| model.trim().is_empty())
        {
            return Err("Provider setting models cannot be empty.".into());
        }
    }
    Ok(config)
}

fn read_project(folder: &Path) -> Result<ProjectRecord, String> {
    if !folder.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    let canonical_folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    let config_path = canonical_folder.join(PROJECT_FILE_NAME);
    let json = fs::read_to_string(&config_path)
        .map_err(|error| format!("Could not read {}: {error}", config_path.to_string_lossy()))?;
    let config: ProjectConfig = serde_json::from_str(&json)
        .map_err(|error| format!("Project config is not valid: {error}"))?;
    let config = validate_and_normalize_config(config)?;
    Ok(ProjectRecord {
        folder_path: canonical_folder.to_string_lossy().into_owned(),
        config,
    })
}

fn write_project(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    write_project_with_replacer(folder, config, atomic_replace)
}

fn write_project_with_replacer<F>(
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

#[cfg(not(windows))]
fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)?;
    fs::File::open(destination.parent().expect("project file has a parent"))?.sync_all()
}

#[cfg(windows)]
fn atomic_replace(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::GetLastError,
        Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
        },
    };

    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let succeeded = unsafe {
        if destination.exists() {
            ReplaceFileW(
                destination_wide.as_ptr(),
                temporary_wide.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } else {
            MoveFileExW(
                temporary_wide.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if succeeded == 0 {
        let code = unsafe { GetLastError() };
        Err(io::Error::from_raw_os_error(code as i32))
    } else {
        Ok(())
    }
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
    let config = validate_and_normalize_config(config)?;
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
    create_project_in(&parent, &config).map(Some)
}

fn create_project_in(parent: &Path, config: &ProjectConfig) -> Result<ProjectRecord, String> {
    let config = validate_and_normalize_config(config.clone())?;
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
    for child in PROJECT_DIRECTORIES {
        fs::create_dir_all(project_folder.join(child))
            .map_err(|error| format!("Could not create {child} folder: {error}"))?;
    }
    if let Err(error) = write_project(&project_folder, &config) {
        let _ = fs::remove_dir_all(&project_folder);
        return Err(error);
    }
    read_project(&project_folder)
}

#[tauri::command]
fn save_project(folder_path: String, config: ProjectConfig) -> Result<(), String> {
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
        serde_json::from_str(include_str!("../../fixtures/project-v1-complete.json")).unwrap()
    }

    #[test]
    fn complete_project_create_open_save_reopen_is_lossless() {
        let root = tempfile::tempdir().unwrap();
        let expected = validate_and_normalize_config(fixture()).unwrap();
        let created = create_project_in(root.path(), &expected).unwrap();
        assert_eq!(created.config, expected);

        let project_folder = PathBuf::from(&created.folder_path);
        let opened = read_project(&project_folder).unwrap();
        assert_eq!(opened.config, expected);

        let mut saved = opened.config.clone();
        saved.updated_at = "2026-02-03T04:05:06.000Z".into();
        saved.agent_conversation.messages.push(AgentMessage {
            id: "message-save".into(),
            role: "user".into(),
            content: "Save this portable project.".into(),
            created_at: "2026-02-03T04:05:06.000Z".into(),
        });
        write_project(&project_folder, &saved).unwrap();
        assert_eq!(read_project(&project_folder).unwrap().config, saved);

        let mut directories = Vec::new();
        fn collect_directories(root: &Path, current: &Path, output: &mut Vec<String>) {
            for entry in fs::read_dir(current).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    output.push(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                    collect_directories(root, &path, output);
                }
            }
        }
        collect_directories(&project_folder, &project_folder, &mut directories);
        directories.sort();
        assert_eq!(
            directories,
            [
                "cache",
                "exports",
                "media",
                "media/generated",
                "media/imported",
                "references",
                "thumbnails",
            ]
        );
        let files: Vec<_> = fs::read_dir(&project_folder)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files, [PROJECT_FILE_NAME]);
    }

    #[test]
    fn old_v1_documents_receive_empty_persistence_containers() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("references");
        object.remove("generationJobs");
        object.remove("agentConversation");
        object.remove("providerSettings");
        let config: ProjectConfig = serde_json::from_value(value).unwrap();
        assert!(config.references.is_empty());
        assert!(config.generation_jobs.is_empty());
        assert!(config.agent_conversation.messages.is_empty());
        assert!(config.provider_settings.is_empty());
    }

    #[test]
    fn stored_paths_are_normalized_and_escaping_paths_are_rejected() {
        let mut normalized = fixture();
        normalized.assets[0].relative_path = ".\\media\\imported//macro.mp4".into();
        assert_eq!(
            validate_and_normalize_config(normalized).unwrap().assets[0].relative_path,
            "media/imported/macro.mp4"
        );

        for path in [
            "/etc/passwd",
            "\\Windows\\system.ini",
            "C:\\Users\\creator\\clip.mp4",
            "https://example.com/clip.mp4",
            "media/../../outside.mp4",
            "references/../outside.png",
        ] {
            let mut escaping = fixture();
            escaping.assets[0].relative_path = path.into();
            assert!(
                validate_and_normalize_config(escaping).is_err(),
                "accepted escaping path {path}"
            );
        }

        let mut thumbnail = fixture();
        thumbnail.thumbnail = Some("../thumbnail.webp".into());
        let mut reference = fixture();
        reference.references[1].relative_path = Some("../product.png".into());
        let mut job = fixture();
        job.generation_jobs[0].output_relative_path = Some("C:\\output.mp4".into());
        for config in [thumbnail, reference, job] {
            assert!(validate_and_normalize_config(config).is_err());
        }
    }

    #[test]
    fn replacement_failure_preserves_original_project_json() {
        let root = tempfile::tempdir().unwrap();
        let original = fixture();
        write_project(root.path(), &original).unwrap();
        let destination = root.path().join(PROJECT_FILE_NAME);
        let original_bytes = fs::read(&destination).unwrap();

        let mut changed = original.clone();
        changed.name = "This must not replace the original".into();
        let error = write_project_with_replacer(root.path(), &changed, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "simulated replacement failure",
            ))
        })
        .unwrap_err();

        assert!(error.contains("simulated replacement failure"));
        assert_eq!(fs::read(&destination).unwrap(), original_bytes);
        assert_eq!(read_project(root.path()).unwrap().config, original);
        assert_eq!(
            fs::read_dir(root.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .count(),
            1
        );
    }

    #[test]
    fn sanitizes_folder_names() {
        assert_eq!(safe_folder_name("  Launch: Film?  "), "Launch- Film-");
        assert_eq!(safe_folder_name("..."), "Untitled video");
    }
}
