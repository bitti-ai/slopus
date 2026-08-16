use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

mod agent;
mod vidfab;

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
    // zod spells these `.optional()` with no `.nullable()`, so an explicit
    // `null` is REJECTED by the frontend parser. The key has to stay absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(default)]
    locked: bool,
    #[serde(default)]
    muted: bool,
    // The frontend schema has no default for clips, so it stays required here.
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
    #[serde(default)]
    source_start_ms: u64,
    label: String,
    // `.optional()` without `.nullable()` on the frontend — see ProjectAsset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default = "default_clip_status")]
    status: String,
}

fn default_clip_status() -> String {
    "approved".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReusableReference {
    id: String,
    kind: String,
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    relative_path: Option<String>,
    #[serde(default)]
    intended_use: Vec<String>,
    created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationJob {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    prompt: String,
    status: String,
    #[serde(default)]
    stage: String,
    #[serde(default)]
    progress: f64,
    provider_id: Option<String>,
    creative_brief: String,
    compiled_prompt: String,
    #[serde(default)]
    reference_ids: Vec<String>,
    // `clipId` is `.optional()` and NOT `.nullable()` on the frontend, and no
    // freshly created job ever has one, so emitting `"clipId": null` made every
    // create_project / open_project response fail zod. Keep the key absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    clip_id: Option<String>,
    #[serde(default)]
    output_relative_path: Option<String>,
    #[serde(default)]
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedReferenceImage {
    name: String,
    relative_path: String,
    mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingReferenceImage {
    source_path: String,
    name: String,
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

fn is_supported_aspect_ratio(value: &str) -> bool {
    matches!(value, "16:9" | "9:16" | "1:1" | "4:5")
}

fn is_supported_resolution(value: &str) -> bool {
    matches!(value, "720p" | "1080p" | "4k")
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // The same leap rule zod's date regex spells out branch by branch.
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        // Month 0 and anything past 12 have no days, which rejects the date.
        _ => 0,
    }
}

/// Every date in the schema is validated on the frontend with zod's
/// `z.string().datetime()`. This mirrors zod 3.25's `datetimeRegex` exactly:
/// `YYYY-MM-DD`, a literal `T`, `HH:MM`, OPTIONAL `:SS` which may itself carry
/// an optional `.` plus one or more fractional digits, and a mandatory literal
/// `Z` — no timezone offsets, no lowercase `t`/`z`, and no impossible calendar
/// date (the regex spells out month lengths and the leap-year branch).
///
/// Both directions matter. A value Rust accepts but zod rejects is written to
/// disk and then makes the project unopenable on the next launch; a value zod
/// accepts but Rust rejects makes a legitimate file unsavable. The seconds are
/// genuinely optional in zod, so they are optional here — verified against the
/// installed zod, not assumed.
fn is_iso_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    // `YYYY-MM-DDTHH:MMZ` is the shortest accepted form.
    if bytes.len() < 17 {
        return false;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' || bytes[13] != b':' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && digits(5..7) && digits(8..10) && digits(11..13) && digits(14..16)) {
        return false;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0u32, |total, byte| total * 10 + u32::from(byte - b'0'))
    };
    let (year, month, day) = (number(0, 4), number(5, 7), number(8, 10));
    if day == 0 || day > days_in_month(year, month) {
        return false;
    }
    if number(11, 13) > 23 || number(14, 16) > 59 {
        return false;
    }
    // Seconds are optional. Fractional digits are part of the seconds group, so
    // `...T00:00.5Z` is invalid however tempting it looks.
    let tail = if bytes[16] == b':' {
        if bytes.len() < 20 || !digits(17..19) || number(17, 19) > 59 {
            return false;
        }
        match bytes[19..].split_first() {
            Some((&b'.', fraction)) => {
                let length = fraction
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
                if length == 0 {
                    return false;
                }
                &fraction[length..]
            }
            _ => &bytes[19..],
        }
    } else {
        &bytes[16..]
    };
    matches!(tail, b"Z")
}

fn check_iso_datetime(label: &str, value: &str) -> Result<(), String> {
    if is_iso_datetime(value) {
        Ok(())
    } else {
        Err(format!(
            "{label} must be an ISO date-time like 2026-01-01T00:00:00.000Z, received '{value}'."
        ))
    }
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
    // The frontend caps the name with zod's .max(120), which counts UTF-16 code
    // units, so count the same way here or the two layers disagree on emoji.
    let name_length = config.name.encode_utf16().count();
    if name_length > 120 {
        return Err(format!(
            "Project names cannot be longer than 120 characters, received {name_length}."
        ));
    }
    check_iso_datetime("Project createdAt", &config.created_at)?;
    check_iso_datetime("Project updatedAt", &config.updated_at)?;
    if config.brief.prompt.trim().is_empty() {
        return Err("Project brief cannot be empty.".into());
    }
    if !is_supported_aspect_ratio(&config.settings.aspect_ratio) {
        return Err(format!(
            "Unsupported aspect ratio '{}'.",
            config.settings.aspect_ratio
        ));
    }
    if !is_supported_resolution(&config.settings.resolution) {
        return Err(format!(
            "Unsupported resolution '{}'.",
            config.settings.resolution
        ));
    }
    if !matches!(config.settings.frame_rate, 24 | 25 | 30 | 60) {
        return Err(format!(
            "Unsupported frame rate {}. Use 24, 25, 30, or 60.",
            config.settings.frame_rate
        ));
    }
    let background_color = config.settings.background_color.as_bytes();
    if background_color.len() != 7
        || background_color[0] != b'#'
        || !background_color[1..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "Background color must be a #rrggbb hex value, received '{}'.",
            config.settings.background_color
        ));
    }
    if !matches!(
        config.brief.status.as_str(),
        "draft" | "queued" | "generating" | "ready" | "failed"
    ) {
        return Err(format!(
            "Unsupported project brief status '{}'.",
            config.brief.status
        ));
    }
    // The bounds are spelled u32 so the range's element type cannot fall back
    // to i32 — `u32: PartialOrd<i32>` does not exist.
    if !(5u32..=600u32).contains(&config.brief.target_duration_seconds) {
        return Err(format!(
            "Target duration must be between 5 and 600 seconds, received {}.",
            config.brief.target_duration_seconds
        ));
    }
    if !is_supported_aspect_ratio(&config.brief.aspect_ratio) {
        return Err(format!(
            "Unsupported project brief aspect ratio '{}'.",
            config.brief.aspect_ratio
        ));
    }
    if !is_supported_resolution(&config.brief.resolution) {
        return Err(format!(
            "Unsupported project brief resolution '{}'.",
            config.brief.resolution
        ));
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
        if !matches!(
            asset.kind.as_str(),
            "video" | "audio" | "image" | "caption" | "generated"
        ) {
            return Err(format!("Unsupported asset kind '{}'.", asset.kind));
        }
        if asset.mime_type.is_empty() {
            return Err(format!("Asset '{}' is missing a mime type.", asset.id));
        }
        if asset.width == Some(0) || asset.height == Some(0) {
            return Err(format!(
                "Asset '{}' cannot have a zero width or height.",
                asset.id
            ));
        }
        check_iso_datetime(
            &format!("Asset '{}' createdAt", asset.id),
            &asset.created_at,
        )?;
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
            // A text reference may legitimately be blank: the UI creates one the
            // moment "New definition" is clicked, before the user has typed. It
            // is marked incomplete there rather than failing the whole save —
            // refusing here blocked every unrelated edit in the project.
            "text" => {}
            "image" if reference.relative_path.is_some() => {}
            "image" => return Err("Image references require a relative path.".into()),
            _ => return Err(format!("Unsupported reference kind '{}'.", reference.kind)),
        }
        // Absent content is fine; present-but-empty content is not, matching
        // zod's `z.string().min(1).nullable().optional()`.
        if reference
            .content
            .as_deref()
            .is_some_and(|content| content.is_empty())
        {
            return Err(format!(
                "Reference '{}' cannot have empty content.",
                reference.id
            ));
        }
        check_iso_datetime(
            &format!("Reference '{}' createdAt", reference.id),
            &reference.created_at,
        )?;
        for intent in &reference.intended_use {
            if !matches!(
                intent.as_str(),
                "character" | "product" | "location" | "style" | "audio"
            ) {
                return Err(format!("Unsupported reference intended use '{intent}'."));
            }
        }
    }
    for track in &config.timeline.tracks {
        if !matches!(track.kind.as_str(), "video" | "audio" | "caption") {
            return Err(format!("Unsupported track kind '{}'.", track.kind));
        }
        if track.name.is_empty() {
            return Err(format!("Track '{}' cannot have an empty name.", track.id));
        }
        for clip in &track.clips {
            if clip.label.is_empty() {
                return Err(format!("Clip '{}' cannot have an empty label.", clip.id));
            }
            if clip.duration_ms == 0 {
                return Err(format!(
                    "Clip '{}' must have a duration greater than zero.",
                    clip.id
                ));
            }
            if !matches!(clip.status.as_str(), "draft" | "generated" | "approved") {
                return Err(format!("Unsupported clip status '{}'.", clip.status));
            }
        }
    }
    for job in &mut config.generation_jobs {
        if job.id.trim().is_empty()
            || job.title.trim().is_empty()
            || job.prompt.trim().is_empty()
            || job.creative_brief.trim().is_empty()
            || job.compiled_prompt.trim().is_empty()
        {
            return Err(
                "Generation job id, title, prompt, creative brief, and compiled prompt cannot be empty.".into(),
            );
        }
        if !matches!(
            job.status.as_str(),
            "draft" | "queued" | "generating" | "ready" | "completed" | "failed" | "cancelled"
        ) {
            return Err(format!(
                "Unsupported generation job status '{}'.",
                job.status
            ));
        }
        if !matches!(
            job.stage.as_str(),
            "queued" | "preparing" | "generating" | "encoding" | "completed" | "failed"
        ) || !(0.0..=1.0).contains(&job.progress)
        {
            return Err(format!(
                "Invalid generation stage or progress for job '{}'.",
                job.id
            ));
        }
        if job
            .provider_id
            .as_deref()
            .is_some_and(|provider_id| provider_id.is_empty())
        {
            return Err(format!(
                "Generation job '{}' cannot have an empty provider id.",
                job.id
            ));
        }
        if job
            .error
            .as_deref()
            .is_some_and(|message| message.is_empty())
        {
            return Err(format!(
                "Generation job '{}' cannot have an empty error message.",
                job.id
            ));
        }
        check_iso_datetime(
            &format!("Generation job '{}' createdAt", job.id),
            &job.created_at,
        )?;
        check_iso_datetime(
            &format!("Generation job '{}' updatedAt", job.id),
            &job.updated_at,
        )?;
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
        check_iso_datetime(
            &format!("Agent message '{}' createdAt", message.id),
            &message.created_at,
        )?;
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
    let asset_ids = unique_ids(config.assets.iter().map(|asset| asset.id.as_str()), "asset")?;
    let reference_ids = unique_ids(
        config
            .references
            .iter()
            .map(|reference| reference.id.as_str()),
        "reference",
    )?;
    let track_ids = unique_ids(
        config.timeline.tracks.iter().map(|track| track.id.as_str()),
        "track",
    )?;
    let clip_ids = unique_ids(
        config
            .timeline
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter().map(|clip| clip.id.as_str())),
        "clip",
    )?;
    for track in &config.timeline.tracks {
        for clip in &track.clips {
            if clip.track_id != track.id || !track_ids.contains(clip.track_id.as_str()) {
                return Err(format!(
                    "Clip '{}' is attached to an invalid track.",
                    clip.id
                ));
            }
            if !asset_ids.contains(clip.asset_id.as_str()) {
                return Err(format!("Clip '{}' references an unknown asset.", clip.id));
            }
        }
    }
    for job in &config.generation_jobs {
        if let Some(clip_id) = &job.clip_id {
            if !clip_ids.contains(clip_id.as_str()) {
                return Err(format!(
                    "Generation job '{}' references an unknown clip.",
                    job.id
                ));
            }
        }
        if let Some(reference_id) = job
            .reference_ids
            .iter()
            .find(|reference_id| !reference_ids.contains(reference_id.as_str()))
        {
            return Err(format!(
                "Generation job '{}' references unknown reference '{}'.",
                job.id, reference_id
            ));
        }
    }
    Ok(config)
}

fn unique_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    kind: &str,
) -> Result<BTreeSet<&'a str>, String> {
    let mut unique = BTreeSet::new();
    for id in ids {
        if !unique.insert(id) {
            return Err(format!("Duplicate {kind} id '{id}'."));
        }
    }
    Ok(unique)
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
fn choose_initial_reference_images(app: AppHandle) -> Result<Vec<PendingReferenceImage>, String> {
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
                source_path: source.to_string_lossy().into_owned(),
                name,
            })
        })
        .collect()
}

fn validate_reference_image(source: &Path) -> Result<(String, &'static str), String> {
    if !source.is_file() {
        return Err("The selected image does not exist.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The selected image needs a file extension.".to_string())?;
    let mime_type = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return Err("Choose a PNG, JPEG, or WebP image.".into()),
    };
    Ok((extension, mime_type))
}

fn copy_reference_image(
    source: &Path,
    project_folder: &Path,
) -> Result<ImportedReferenceImage, String> {
    let (extension, mime_type) = validate_reference_image(source)?;
    let references_folder = project_folder.join("references");
    fs::create_dir_all(&references_folder)
        .map_err(|error| format!("Could not prepare references folder: {error}"))?;
    let display_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Image reference");
    let base_name = safe_folder_name(display_name);
    let mut file_name = format!("{base_name}.{extension}");
    let mut destination = references_folder.join(&file_name);
    let mut suffix = 2;
    while destination.exists() {
        file_name = format!("{base_name}-{suffix}.{extension}");
        destination = references_folder.join(&file_name);
        suffix += 1;
    }
    fs::copy(source, &destination)
        .map_err(|error| format!("Could not copy image into this project: {error}"))?;
    Ok(ImportedReferenceImage {
        name: display_name.to_string(),
        relative_path: format!("references/{file_name}"),
        mime_type: mime_type.into(),
    })
}

#[tauri::command]
fn choose_reference_image(
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
fn create_project(
    app: AppHandle,
    parent_directory: Option<String>,
    config: ProjectConfig,
    initial_reference_paths: Option<Vec<String>>,
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
    let reference_paths = initial_reference_paths
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    create_project_in_with_references(&parent, &config, &reference_paths).map(Some)
}

#[cfg(test)]
fn create_project_in(parent: &Path, config: &ProjectConfig) -> Result<ProjectRecord, String> {
    create_project_in_with_references(parent, config, &[])
}

fn create_project_in_with_references(
    parent: &Path,
    config: &ProjectConfig,
    reference_paths: &[PathBuf],
) -> Result<ProjectRecord, String> {
    let mut config = validate_and_normalize_config(config.clone())?;
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
    let prepare_result = (|| -> Result<(), String> {
        for (index, source) in reference_paths.iter().enumerate() {
            let imported = copy_reference_image(source, &project_folder)?;
            let mut reference_id = format!("ref-initial-{}", index + 1);
            let mut suffix = 2;
            while config
                .references
                .iter()
                .any(|reference| reference.id == reference_id)
            {
                reference_id = format!("ref-initial-{}-{suffix}", index + 1);
                suffix += 1;
            }
            config.references.push(ReusableReference {
                id: reference_id.clone(),
                kind: "image".into(),
                name: imported.name,
                // MUST stay empty. The prompt compiler emits a reference's
                // description as the subject's own traits in the text sent to
                // the paid model, so any sentence written here is presented to
                // the model as if the user had described the image that way.
                // Same hazard the text path documents at src/lib/project.ts:87.
                description: String::new(),
                content: None,
                relative_path: Some(imported.relative_path),
                intended_use: vec!["style".into()],
                created_at: config.created_at.clone(),
            });
            if let Some(job) = config.generation_jobs.first_mut() {
                job.reference_ids.push(reference_id);
            }
        }
        write_project(&project_folder, &config)
    })();
    if let Err(error) = prepare_result {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    providers: Vec<agent::ProviderStatus>,
    vidfab: vidfab::VidfabStatus,
}

#[tauri::command]
fn runtime_status(config: ProjectConfig) -> Result<RuntimeStatus, String> {
    let config = validate_and_normalize_config(config)?;
    Ok(RuntimeStatus {
        providers: agent::provider_statuses(&config.provider_settings),
        vidfab: vidfab::status(&config.provider_settings),
    })
}

#[tauri::command]
async fn run_agent_turn(
    state: tauri::State<'_, agent::AgentRuntime>,
    request: agent::AgentTurnRequest,
) -> Result<agent::AgentTurnResponse, String> {
    let runtime = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.run(request))
        .await
        .map_err(|error| format!("Agent task failed: {error}"))?
}

#[tauri::command]
fn cancel_agent_turn(state: tauri::State<'_, agent::AgentRuntime>, request_id: String) -> bool {
    state.cancel(&request_id)
}

#[tauri::command]
fn resolve_vidfab_plan(
    request: vidfab::GenerationRequest,
    config: ProjectConfig,
) -> Result<vidfab::ResolvedPlan, String> {
    let config = validate_and_normalize_config(config)?;
    vidfab::resolve_plan(&request, &config.provider_settings)
}

#[tauri::command]
fn enqueue_vidfab_generation(
    app: AppHandle,
    state: tauri::State<'_, vidfab::VidfabRuntime>,
    request: vidfab::GenerationRequest,
    config: ProjectConfig,
) -> Result<(), String> {
    let config = validate_and_normalize_config(config)?;
    state.enqueue(app, request, &config.provider_settings)
}

#[tauri::command]
fn cancel_vidfab_generation(
    state: tauri::State<'_, vidfab::VidfabRuntime>,
    job_id: String,
) -> bool {
    state.cancel(&job_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(agent::AgentRuntime::default())
        .manage(vidfab::VidfabRuntime::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            choose_project_folder,
            choose_initial_reference_images,
            choose_reference_image,
            create_project,
            save_project,
            runtime_status,
            run_agent_turn,
            cancel_agent_turn,
            resolve_vidfab_plan,
            enqueue_vidfab_generation,
            cancel_vidfab_generation
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

    /// Byte-exact output of the frontend's `createProjectConfig` — what a real
    /// newly created project looks like before anything has been edited. The
    /// complete fixture cannot stand in for it: it has no draft job without a
    /// clip, which is the shape that broke every create and open.
    fn created_fixture() -> ProjectConfig {
        serde_json::from_str(include_str!("../../fixtures/project-v1-created.json")).unwrap()
    }

    /// The keys the frontend schema spells `.optional()` with NO `.nullable()`
    /// (src/lib/project.ts lines 42-44, 56, 109). zod's `.optional()` rejects
    /// `null`, so an explicit null under any of these names makes the whole
    /// config unparseable in the UI — the key has to be absent instead.
    ///
    /// This list is hand-maintained and therefore NOT the authority: a new
    /// `Option` field missing `skip_serializing_if` is invisible here until
    /// someone remembers to add its name. The authority is the generated
    /// `fixtures/rust-serialized-*.json` written by
    /// `serialized_wire_format_fixtures_are_regenerated_for_the_frontend`,
    /// which the frontend test suite parses with the real zod schema — a
    /// forgotten field fails there without anyone editing this array.
    const NON_NULLABLE_OPTIONAL_KEYS: [&str; 5] =
        ["clipId", "durationMs", "width", "height", "color"];

    fn collect_forbidden_nulls(value: &serde_json::Value, path: &str, found: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(fields) => {
                for (key, child) in fields {
                    let child_path = format!("{path}.{key}");
                    if child.is_null() && NON_NULLABLE_OPTIONAL_KEYS.contains(&key.as_str()) {
                        found.push(child_path.clone());
                    }
                    collect_forbidden_nulls(child, &child_path, found);
                }
            }
            serde_json::Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    collect_forbidden_nulls(item, &format!("{path}[{index}]"), found);
                }
            }
            _ => {}
        }
    }

    fn forbidden_nulls(config: &ProjectConfig) -> Vec<String> {
        let json = serde_json::to_string_pretty(config).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let mut found = Vec::new();
        collect_forbidden_nulls(&value, "config", &mut found);
        found
    }

    fn object_of<'a>(
        value: &'a serde_json::Value,
        path: &str,
    ) -> &'a serde_json::Map<String, serde_json::Value> {
        value
            .as_object()
            .unwrap_or_else(|| panic!("{path} is not a JSON object"))
    }

    #[test]
    fn rust_never_emits_a_null_the_frontend_schema_refuses() {
        // The cross-layer direction that went unchecked for nine rounds: Rust
        // WRITING something zod cannot read. Browser mode never touches Rust,
        // so nothing else catches it.
        for (name, config) in [("created", created_fixture()), ("complete", fixture())] {
            let config = validate_and_normalize_config(config).unwrap();
            let found = forbidden_nulls(&config);
            assert!(
                found.is_empty(),
                "{name} fixture serialized nulls that zod's .optional() rejects: {found:?}"
            );
        }

        // Positively: a freshly created draft job carries no clip, and the key
        // must be missing rather than null. `createDraftGenerationJob` never
        // sets clipId, so this is every project that has ever been created.
        let created = validate_and_normalize_config(created_fixture()).unwrap();
        let json = serde_json::to_string_pretty(&created).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let job = object_of(&value["generationJobs"][0], "generationJobs[0]");
        assert!(
            !job.contains_key("clipId"),
            "clipId must be absent, not null: {job:?}"
        );
        assert!(!json.contains("\"clipId\""), "clipId leaked into {json}");
    }

    /// Writes the REAL serialised output of `validate_and_normalize_config`
    /// into `fixtures/rust-serialized-*.json`, which the frontend test suite
    /// parses with its own zod schema. This is how the two-validator contract
    /// stops being hand-maintained: a field added to Rust as an `Option`
    /// without `skip_serializing_if` (or added to zod as a bare `.optional()`)
    /// changes these bytes and fails on the frontend side, with nobody having
    /// to remember to extend `NON_NULLABLE_OPTIONAL_KEYS`.
    ///
    /// THESE FILES ARE GENERATED BY `cargo test` AND COMMITTED ON PURPOSE. If
    /// `git status` is dirty after a test run, the wire format changed: re-run
    /// the frontend schema tests against the new bytes before committing them.
    ///
    /// The output is deterministic — every input is a checked-in fixture or is
    /// derived from one. The imported-reference case runs the real product code
    /// path inside a `tempfile::tempdir()`, but the temp path cannot leak into
    /// the JSON because references store project-relative paths only
    /// (`references/<file>`); the assertion below proves it per run.
    #[test]
    fn serialized_wire_format_fixtures_are_regenerated_for_the_frontend() {
        fn serialize(config: &ProjectConfig) -> String {
            let mut json = serde_json::to_string_pretty(config).unwrap();
            // Trailing newline so the committed bytes are stable under editors
            // and `git diff` alike.
            json.push('\n');
            json
        }

        fn write_fixture(name: &str, json: &str) {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures")
                .join(name);
            fs::write(&path, json)
                .unwrap_or_else(|error| panic!("could not write {}: {error}", path.display()));
        }

        write_fixture(
            "rust-serialized-created.json",
            &serialize(&validate_and_normalize_config(created_fixture()).unwrap()),
        );
        write_fixture(
            "rust-serialized-complete.json",
            &serialize(&validate_and_normalize_config(fixture()).unwrap()),
        );

        // An ACTUALLY IMPORTED reference: produced by the same function the
        // create-project command calls, not a hand-written fixture record.
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("harbor facade.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\n").unwrap();
        let imported = create_project_in_with_references(
            root.path(),
            &created_fixture(),
            std::slice::from_ref(&source),
        )
        .unwrap();
        assert_eq!(
            imported.config.references[0].relative_path.as_deref(),
            Some("references/harbor facade.png"),
            "the imported reference must be stored as a project-relative path"
        );
        let json = serialize(&imported.config);
        // The randomly named temp directory is the only non-deterministic input
        // in this test; if any part of it reached the JSON the committed file
        // would change on every run and dirty the tree at random.
        let temp_marker = root
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(
            !json.contains(&temp_marker),
            "the temp directory name '{temp_marker}' leaked into the generated fixture: {json}"
        );
        write_fixture("rust-serialized-initial-reference.json", &json);
    }

    #[test]
    fn is_iso_datetime_agrees_with_real_zod_on_every_recorded_case() {
        // fixtures/iso-datetime-cases.json is a differential harness: 932
        // strings (single-character mutations, insertions, deletions and
        // truncations of valid stamps, plus calendar and time boundaries),
        // each labelled with the verdict of the frontend's real
        // `z.string().datetime()` from the installed zod 3.25.76. The
        // hand-written table above documents intent readably; THIS test is the
        // one that proves parity, and it is committed rather than run once as
        // a throwaway so a regression is caught by `cargo test`.
        let cases: Vec<(String, bool)> =
            serde_json::from_str(include_str!("../../fixtures/iso-datetime-cases.json"))
                .expect("fixtures/iso-datetime-cases.json is not a [string, bool] array");
        assert!(
            cases.len() > 900,
            "the harness lost cases: only {} remain",
            cases.len()
        );

        // Collect every disagreement before failing: one assert per iteration
        // would report a single string and hide the shape of the regression.
        let mut disagreements = Vec::new();
        for (value, zod_accepts) in &cases {
            if is_iso_datetime(value) != *zod_accepts {
                disagreements.push(format!(
                    "'{value}': zod {}, rust {}",
                    if *zod_accepts { "accepts" } else { "rejects" },
                    if *zod_accepts { "rejects" } else { "accepts" }
                ));
            }
        }
        assert!(
            disagreements.is_empty(),
            "{} of {} cases disagree with zod; first {}:\n{}",
            disagreements.len(),
            cases.len(),
            disagreements.len().min(10),
            disagreements
                .iter()
                .take(10)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    #[test]
    fn both_fixtures_round_trip_losslessly_through_json() {
        for (name, config) in [("created", created_fixture()), ("complete", fixture())] {
            let normalized = validate_and_normalize_config(config).unwrap();
            let json = serde_json::to_string_pretty(&normalized).unwrap();
            let reparsed: ProjectConfig = serde_json::from_str(&json).unwrap();
            assert_eq!(
                reparsed, normalized,
                "{name} fixture lost data in a round trip"
            );
            assert_eq!(
                validate_and_normalize_config(reparsed).unwrap(),
                normalized,
                "{name} fixture failed to re-validate after a round trip"
            );
        }
    }

    #[test]
    fn absent_non_nullable_optionals_are_omitted_entirely() {
        let mut config = fixture();
        config.assets[0].duration_ms = None;
        config.assets[0].width = None;
        config.assets[0].height = None;
        config.timeline.tracks[0].clips[0].color = None;
        config.generation_jobs[0].clip_id = None;
        let config = validate_and_normalize_config(config).unwrap();

        let found = forbidden_nulls(&config);
        assert!(found.is_empty(), "emitted forbidden nulls: {found:?}");

        let value = serde_json::to_value(&config).unwrap();
        let asset = object_of(&value["assets"][0], "assets[0]");
        for key in ["durationMs", "width", "height"] {
            assert!(!asset.contains_key(key), "assets[0].{key} must be omitted");
        }
        let clip = object_of(&value["timeline"]["tracks"][0]["clips"][0], "clips[0]");
        assert!(!clip.contains_key("color"), "clip color must be omitted");
        // The clip's OWN durationMs is required and must survive — the omission
        // is per field, not per key name.
        assert_eq!(clip["durationMs"], serde_json::json!(8000));
        let job = object_of(&value["generationJobs"][0], "generationJobs[0]");
        assert!(!job.contains_key("clipId"), "job clipId must be omitted");

        let reparsed: ProjectConfig = serde_json::from_value(value).unwrap();
        assert_eq!(
            reparsed, config,
            "omitted optionals did not come back as None"
        );
    }

    #[test]
    fn nullable_optionals_still_serialize_as_explicit_null() {
        // The guard against "fixing" the clipId break by blanket-adding
        // skip_serializing_if: every field below is `.nullable()` on the
        // frontend, so an explicit null is what zod expects. Dropping the key
        // breaks the other direction just as badly.
        fn assert_explicit_null(parent: &serde_json::Value, path: &str, key: &str) {
            let fields = object_of(parent, path);
            assert!(
                fields.contains_key(key),
                "{path}.{key} is .nullable() on the frontend and must stay present"
            );
            assert!(
                fields[key].is_null(),
                "{path}.{key} must serialize as null when None, got {}",
                fields[key]
            );
        }

        let mut config = fixture();
        config.thumbnail = None;
        config.references[0].content = None;
        config.references[0].relative_path = None;
        config.generation_jobs[0].provider_id = None;
        config.generation_jobs[0].output_relative_path = None;
        config.generation_jobs[0].error = None;
        config
            .provider_settings
            .get_mut("minimax-h3")
            .unwrap()
            .model = None;
        let config = validate_and_normalize_config(config).unwrap();

        let json = serde_json::to_string_pretty(&config).unwrap();
        assert!(
            json.contains("\"thumbnail\": null"),
            "thumbnail must serialize as an explicit null: {json}"
        );
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_explicit_null(&value, "config", "thumbnail");
        assert_explicit_null(&value["references"][0], "references[0]", "content");
        assert_explicit_null(&value["references"][0], "references[0]", "relativePath");
        assert_explicit_null(
            &value["generationJobs"][0],
            "generationJobs[0]",
            "providerId",
        );
        assert_explicit_null(
            &value["generationJobs"][0],
            "generationJobs[0]",
            "outputRelativePath",
        );
        assert_explicit_null(&value["generationJobs"][0], "generationJobs[0]", "error");
        assert_explicit_null(
            &value["providerSettings"]["minimax-h3"],
            "providerSettings['minimax-h3']",
            "model",
        );
    }

    #[test]
    fn iso_datetime_matches_the_frontend_datetime_rules() {
        for value in [
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00.123456789Z",
            "2024-02-29T23:59:59Z",
            "2000-02-29T00:00:00Z",
            "2026-12-31T23:59:59.9Z",
            // zod's seconds group is optional: `(:[0-5]\d(\.\d+)?)?`. Verified
            // against the installed zod 3.25.76, which accepts this. Rejecting
            // it would make a legitimate file unsavable in the desktop app.
            "2026-01-01T00:00Z",
            "2026-12-31T23:59Z",
        ] {
            assert!(is_iso_datetime(value), "rejected valid date-time '{value}'");
        }
        for value in [
            "2026-01-01",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00+01:00",
            "2026-01-01t00:00:00z",
            "2026-01-01T00:00:00.Z",
            "",
            "not a date",
            "2026-01-01T00:00:00.000Z ",
            " 2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000ZZ",
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-01-00T00:00:00Z",
            "2025-02-29T00:00:00Z",
            "1900-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01 00:00:00Z",
            "20260101T000000Z",
            // The fraction belongs to the seconds group, so it cannot follow
            // bare minutes.
            "2026-01-01T00:00.5Z",
            "2026-01-01T00:00",
            "2026-01-01T00:60Z",
            "2026-01-01T24:00Z",
            "2026-01-01T00:00:Z",
        ] {
            assert!(
                !is_iso_datetime(value),
                "accepted invalid date-time '{value}'"
            );
        }
    }

    #[test]
    fn every_date_field_is_checked_the_way_the_frontend_checks_it() {
        // A date Rust accepts and zod refuses is written to disk and the project
        // disappears from the library on the next launch, so every date field
        // has to be covered — not just the two on the config root.
        assert!(validate_and_normalize_config(fixture()).is_ok());
        assert!(validate_and_normalize_config(created_fixture()).is_ok());

        fn rejects(field: &str, break_config: impl FnOnce(&mut ProjectConfig)) {
            let mut config = fixture();
            break_config(&mut config);
            let error = validate_and_normalize_config(config)
                .expect_err(&format!("accepted a {field} the frontend schema rejects"));
            assert!(
                error.contains("ISO date-time"),
                "unexpected error for {field}: {error}"
            );
        }

        rejects("project createdAt", |config| {
            config.created_at = "2026-01-01".into();
        });
        rejects("project updatedAt", |config| {
            config.updated_at = "2026-01-02T03:04:05".into();
        });
        rejects("asset createdAt", |config| {
            config.assets[0].created_at = "2026-01-01T00:10:00+01:00".into();
        });
        rejects("reference createdAt", |config| {
            config.references[0].created_at = "2026-01-01t00:05:00.000z".into();
        });
        rejects("job createdAt", |config| {
            config.generation_jobs[0].created_at = String::new();
        });
        rejects("job updatedAt", |config| {
            config.generation_jobs[0].updated_at = "not a date".into();
        });
        rejects("agent message createdAt", |config| {
            config.agent_conversation.messages[0].created_at = "2026-01-01T00:11:00".into();
        });
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
    fn project_mutation_rejects_broken_relational_ids() {
        let mut config = fixture();
        config.generation_jobs[0]
            .reference_ids
            .push("missing-reference".into());
        assert!(validate_and_normalize_config(config)
            .unwrap_err()
            .contains("unknown reference"));
    }

    #[test]
    fn initial_reference_images_are_copied_and_bound_to_the_first_draft() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("mood board.webp");
        fs::write(&source, b"fixture-image").unwrap();
        let config = fixture();

        let created =
            create_project_in_with_references(root.path(), &config, std::slice::from_ref(&source))
                .unwrap();
        let reference = created
            .config
            .references
            .iter()
            .find(|reference| reference.id == "ref-initial-1")
            .unwrap();

        assert_eq!(reference.kind, "image");
        assert_eq!(reference.intended_use, vec!["style"]);
        // The description must stay EMPTY. `compileMiniMaxH3Prompt` emits a
        // reference's description as the subject's traits in the prompt sent to
        // the paid model, so app-authored filing boilerplate here is shipped to
        // the model as if the user had written it about their own image
        // ("<Subject 1> is harbor-facade, shown in <Picture 1>. Visual
        // reference supplied with the initial project brief."). The app never
        // invents words and presents them as the user's description — the text
        // path documents the same rule at src/lib/project.ts:87.
        assert_eq!(
            reference.description, "",
            "an imported reference must carry no app-authored description"
        );
        assert!(created
            .config
            .generation_jobs
            .first()
            .unwrap()
            .reference_ids
            .contains(&reference.id));
        assert!(Path::new(&created.folder_path)
            .join(reference.relative_path.as_ref().unwrap())
            .is_file());
    }

    #[test]
    fn sanitizes_folder_names() {
        assert_eq!(safe_folder_name("  Launch: Film?  "), "Launch- Film-");
        assert_eq!(safe_folder_name("..."), "Untitled video");
    }

    #[test]
    fn blank_text_references_never_block_a_project_save() {
        // The workspace creates an empty text reference the instant "New
        // definition" is clicked, before the user has typed anything. Rejecting
        // it here failed the whole save and blocked every unrelated edit in the
        // project — a regression that shipped once already. A blank text
        // reference must stay valid; do not tighten this without a UI change.
        let mut config = fixture();
        config.references.push(ReusableReference {
            id: "reference-blank".into(),
            kind: "text".into(),
            name: "New definition".into(),
            description: String::new(),
            content: None,
            relative_path: None,
            intended_use: Vec::new(),
            created_at: "2026-01-01T00:07:00.000Z".into(),
        });
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "a blank text reference must never block saving the project"
        );
    }

    #[test]
    fn validator_rejects_what_the_frontend_schema_rejects() {
        // Configs arriving from the agent subprocess are written to disk before
        // the frontend ever parses them, so anything zod refuses has to be
        // refused here too or a project lands on disk that cannot be reopened.
        fn rejects(case: &str, break_config: impl FnOnce(&mut ProjectConfig)) {
            let mut config = fixture();
            break_config(&mut config);
            assert!(
                validate_and_normalize_config(config).is_err(),
                "accepted a config the frontend schema rejects: {case}"
            );
        }

        rejects("name longer than 120 characters", |config| {
            config.name = "n".repeat(200);
        });
        rejects("unsupported settings aspect ratio", |config| {
            config.settings.aspect_ratio = "21:9".into();
        });
        rejects("unsupported settings resolution", |config| {
            config.settings.resolution = "8k".into();
        });
        rejects("unsupported frame rate", |config| {
            config.settings.frame_rate = 48;
        });
        rejects("named background color", |config| {
            config.settings.background_color = "black".into();
        });
        rejects("shorthand background color", |config| {
            config.settings.background_color = "#fff".into();
        });
        rejects("non-hex digit in background color", |config| {
            config.settings.background_color = "#10131g".into();
        });
        rejects("unsupported brief status", |config| {
            config.brief.status = "done".into();
        });
        rejects("target duration above 600 seconds", |config| {
            config.brief.target_duration_seconds = 900;
        });
        rejects("target duration below 5 seconds", |config| {
            config.brief.target_duration_seconds = 4;
        });
        rejects("unsupported brief aspect ratio", |config| {
            config.brief.aspect_ratio = "21:9".into();
        });
        rejects("unsupported brief resolution", |config| {
            config.brief.resolution = "8k".into();
        });
        rejects("unsupported asset kind", |config| {
            config.assets[0].kind = "clip".into();
        });
        rejects("empty asset mime type", |config| {
            config.assets[0].mime_type = String::new();
        });
        rejects("zero asset width", |config| {
            config.assets[0].width = Some(0);
        });
        rejects("zero asset height", |config| {
            config.assets[0].height = Some(0);
        });
        rejects("unsupported track kind", |config| {
            config.timeline.tracks[0].kind = "text".into();
        });
        rejects("empty track name", |config| {
            config.timeline.tracks[0].name = String::new();
        });
        rejects("empty clip label", |config| {
            config.timeline.tracks[0].clips[0].label = String::new();
        });
        rejects("zero clip duration", |config| {
            config.timeline.tracks[0].clips[0].duration_ms = 0;
        });
        rejects("unsupported clip status", |config| {
            config.timeline.tracks[0].clips[0].status = "final".into();
        });
        rejects("empty reference content", |config| {
            config.references[0].content = Some(String::new());
        });
        rejects("unsupported reference intended use", |config| {
            config.references[0].intended_use = vec!["mood".into()];
        });
        rejects("empty generation job provider id", |config| {
            config.generation_jobs[0].provider_id = Some(String::new());
        });
        rejects("empty generation job error", |config| {
            config.generation_jobs[0].error = Some(String::new());
        });
    }

    #[test]
    fn validator_accepts_every_boundary_the_frontend_schema_allows() {
        for aspect_ratio in ["16:9", "9:16", "1:1", "4:5"] {
            let mut config = fixture();
            config.settings.aspect_ratio = aspect_ratio.into();
            config.brief.aspect_ratio = aspect_ratio.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid aspect ratio {aspect_ratio}"
            );
        }
        for resolution in ["720p", "1080p", "4k"] {
            let mut config = fixture();
            config.settings.resolution = resolution.into();
            config.brief.resolution = resolution.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid resolution {resolution}"
            );
        }
        for frame_rate in [24u32, 25, 30, 60] {
            let mut config = fixture();
            config.settings.frame_rate = frame_rate;
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid frame rate {frame_rate}"
            );
        }
        for background_color in ["#000000", "#FFFFFF", "#abcdef", "#ABCDEF", "#10131a"] {
            let mut config = fixture();
            config.settings.background_color = background_color.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid background color {background_color}"
            );
        }
        for seconds in [5u32, 60, 600] {
            let mut config = fixture();
            config.brief.target_duration_seconds = seconds;
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid target duration {seconds}"
            );
        }
        for status in ["draft", "queued", "generating", "ready", "failed"] {
            let mut config = fixture();
            config.brief.status = status.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid brief status {status}"
            );
        }
        for kind in ["video", "audio", "image", "caption", "generated"] {
            let mut config = fixture();
            config.assets[0].kind = kind.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid asset kind {kind}"
            );
        }
        for kind in ["video", "audio", "caption"] {
            let mut config = fixture();
            config.timeline.tracks[0].kind = kind.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid track kind {kind}"
            );
        }
        for status in ["draft", "generated", "approved"] {
            let mut config = fixture();
            config.timeline.tracks[0].clips[0].status = status.into();
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid clip status {status}"
            );
        }
        for intent in ["character", "product", "location", "style", "audio"] {
            let mut config = fixture();
            config.references[0].intended_use = vec![intent.into()];
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected valid reference intended use {intent}"
            );
        }

        let mut longest_name = fixture();
        longest_name.name = "n".repeat(120);
        assert!(
            validate_and_normalize_config(longest_name).is_ok(),
            "rejected a 120 character project name"
        );

        let mut sparse = fixture();
        sparse.assets[0].width = None;
        sparse.assets[0].height = None;
        sparse.assets[0].duration_ms = None;
        sparse.references[0].content = None;
        sparse.references[0].intended_use = Vec::new();
        sparse.generation_jobs[0].provider_id = None;
        sparse.generation_jobs[0].error = None;
        assert!(
            validate_and_normalize_config(sparse).is_ok(),
            "rejected a config whose optional fields are absent"
        );
    }

    #[test]
    fn timeline_flags_fall_back_to_the_frontend_defaults() {
        let mut value = serde_json::to_value(fixture()).unwrap();
        value["timeline"]["tracks"][0]
            .as_object_mut()
            .unwrap()
            .remove("locked");
        value["timeline"]["tracks"][0]
            .as_object_mut()
            .unwrap()
            .remove("muted");
        value["timeline"]["tracks"][0]["clips"][0]
            .as_object_mut()
            .unwrap()
            .remove("sourceStartMs");

        let config: ProjectConfig = serde_json::from_value(value).unwrap();
        let track = &config.timeline.tracks[0];
        assert!(!track.locked);
        assert!(!track.muted);
        assert_eq!(track.clips[0].source_start_ms, 0);
        assert!(validate_and_normalize_config(config.clone()).is_ok());
    }
}
