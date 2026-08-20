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
mod export;
mod vidfab;

const PROJECT_FILE_NAME: &str = "polstudio.json";
/// What the file was called before, newest first. Folders written by earlier
/// builds still open; the next save writes `polstudio.json` and leaves the old
/// file alone, so a project stays readable by the build that made it.
const LEGACY_PROJECT_FILE_NAMES: [&str; 2] = ["pols.json", "polstudio.project.json"];
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
    // Exactly one of the two locations. `relativePath` is a file COPIED into
    // the project folder (images, and anything generated here); `sourcePath` is
    // an absolute path to a file left where the user already keeps it (video
    // and audio, which are far too big to duplicate). Both keys are omitted
    // when absent rather than written as null — see the note on `durationMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    mime_type: String,
    // zod now spells these `.nullish()`, so an explicit `null` WOULD parse.
    // Keep skipping anyway: it is the shape the fixtures pin, and it keeps the
    // absent case unambiguous. Do not restate the old reason — the frontend
    // rejecting null was true once and is the sort of stale justification this
    // file's own rules warn about.
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
    /// An image reference is copied into `references/`; a video or audio
    /// reference is not, and points at wherever the user keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    #[serde(default)]
    intended_use: Vec<String>,
    created_at: String,
}

/// One shot inside a scene. Mirrors `sceneShotSchema` in src/lib/project.ts.
///
/// `startSeconds` and `action` are REQUIRED on the zod side and are plain
/// (non-`Option`) fields here, so they are always written — a `#[serde(default)]`
/// covers a file that predates them without ever producing a key zod refuses.
/// `settings` is the only optional one and carries `skip_serializing_if`,
/// because zod spells it `.nullish()` for the same reason `shotTags` is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SceneShot {
    id: String,
    #[serde(default)]
    start_seconds: f64,
    /// The user's own line, tokens and all. May be empty: a shot they have just
    /// added has nothing written in it, and this layer never fills it in.
    #[serde(default)]
    action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationJob {
    id: String,
    #[serde(default)]
    title: String,
    /// A MIRROR of the scene's shot lines for a scene-shaped job, and the user's
    /// only copy of their words for every job written before scenes existed.
    /// That is why it may be empty here but not there — see the emptiness rule
    /// in `validate_and_normalize_config`, which is zod's `superRefine` on
    /// `generationJobSchema` written out.
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
    /// The H3 vocabulary tags this shot was built from: group id -> option ids.
    /// zod spells it `.nullish()` (src/lib/project.ts `shotTagSelectionSchema`),
    /// so `null` IS readable on the frontend — but the key is still skipped
    /// when there is nothing to say, because every project written before shot
    /// tags existed has no key here and must keep round-tripping unchanged.
    ///
    /// Only the SHAPE is checked, on both sides: the vocabulary itself lives in
    /// src/lib/shot-tags.ts and nowhere else, so a term can be reworded without
    /// this file knowing, and an id from a newer build is preserved rather than
    /// dropped on the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shot_tags: Option<BTreeMap<String, Vec<String>>>,
    /// The shots this scene holds, in playing order. Every one of the four
    /// fields below is an `Option` with `skip_serializing_if`, because every
    /// project written before scenes existed has none of these keys and must
    /// round-trip byte-for-byte: zod spells all four `.nullish()`, so `null`
    /// would also be readable, but an absent key is what the old files have.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shots: Option<Vec<SceneShot>>,
    /// How long the whole scene runs, 0-15 seconds. Absent means the length
    /// every shot was generated at before this was settable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_seconds: Option<f64>,
    /// Base guide §4.6 and §4.7 — per-prompt fields, so they sit on the scene
    /// rather than on a shot. Absent means the compiler writes its own
    /// content-neutral line and marks it as PolStudio's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    soundscape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    music: Option<String>,
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

/// One file the user added to a project. An IMAGE is copied into the project's
/// `media/` folder and comes back with `relative_path`; VIDEO and AUDIO are
/// left exactly where they are and come back with an absolute `source_path`,
/// because copying a rush or a stem doubles gigabytes on disk for no benefit.
/// Exactly one of the two is ever set.
///
/// Deliberately carries no duration or dimensions: PolStudio has no decoder
/// yet, and a made-up number here would be indistinguishable from a measured
/// one everywhere downstream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedMediaFile {
    kind: &'static str,
    name: String,
    relative_path: Option<String>,
    source_path: Option<String>,
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

/// The other kind of stored location: a file the project points at but does
/// NOT contain. Video and audio are never copied — a 40 GB rush is not going to
/// be duplicated into a project folder — so the project records where the user
/// already keeps it.
///
/// It must be ABSOLUTE, because it is resolved against nothing: no working
/// directory, no project root. `..` is refused so the recorded string is the
/// same string every comparison sees; canonicalised paths never contain one.
/// The separators are left exactly as the OS wrote them. This mirrors
/// `normalizeExternalPath` in src/lib/project.ts and must keep mirroring it in
/// both directions.
fn normalize_external_path(value: &str) -> Result<String, String> {
    if value.is_empty() || value.contains('\0') {
        return Err("External media paths cannot be empty or contain null bytes.".into());
    }
    let bytes = value.as_bytes();
    let windows_drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    if !(windows_drive || value.starts_with("\\\\") || value.starts_with('/')) {
        return Err(format!(
            "External media must be recorded as an absolute path, received '{value}'."
        ));
    }
    if value.split(['\\', '/']).any(|component| component == "..") {
        return Err("External media paths cannot contain '..'.".into());
    }
    Ok(value.to_string())
}

/// Every location a project can hold is one of two things and never both: a
/// file inside the folder, or a file outside it. `label` names the record so
/// the message points at the row the user has to fix.
fn check_one_location(
    label: &str,
    relative_path: Option<&String>,
    source_path: Option<&String>,
) -> Result<(), String> {
    match (relative_path, source_path) {
        (Some(_), Some(_)) => Err(format!(
            "{label} cannot have both a project-relative path and an external source path."
        )),
        (None, None) => Err(format!(
            "{label} must have either a project-relative path or an external source path."
        )),
        _ => Ok(()),
    }
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

/// The id shape both validators accept. This IS `SHOT_TAG_ID_PATTERN` from
/// src/lib/shot-tags.ts — `^[a-z][a-zA-Z0-9-]*$` — written out because a regex
/// crate would be a dependency for one pattern. Change one and change the other
/// or the two layers disagree about what may be stored. (The group ids are
/// camelCase, `cameraAmplitude` among them; the leading character is still
/// lowercase so nothing here can be mistaken for a type name or a sentence.)
fn is_shot_tag_id(value: &str) -> bool {
    let mut characters = value.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_lowercase())
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// Tidies a shot's tags for storage, in the same three steps and the same order
/// as `normalizeShotTagSelection` in src/lib/shot-tags.ts: drop empty groups,
/// drop repeats within a group, and collapse an empty result to `None` so the
/// key is left out of the file entirely. `BTreeMap` also sorts the groups, which
/// is what the frontend's `Object.keys().sort()` does — otherwise the same
/// selection would serialise to different bytes depending on which layer wrote
/// it last, and every save would show a spurious diff.
///
/// Unknown ids are KEPT: the vocabulary is the frontend's, and a build that has
/// never heard of a tag must not silently delete the user's choice.
fn normalize_shot_tags(
    tags: Option<BTreeMap<String, Vec<String>>>,
) -> Result<Option<BTreeMap<String, Vec<String>>>, String> {
    let Some(tags) = tags else {
        return Ok(None);
    };
    let mut normalized: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (group, options) in tags {
        if !is_shot_tag_id(&group) {
            return Err(format!("has an invalid shot tag group '{group}'."));
        }
        let mut kept: Vec<String> = Vec::new();
        for option in options {
            if !is_shot_tag_id(&option) {
                return Err(format!("has an invalid shot tag '{option}'."));
            }
            if !kept.contains(&option) {
                kept.push(option);
            }
        }
        if !kept.is_empty() {
            normalized.insert(group, kept);
        }
    }
    Ok(if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    })
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
        asset.relative_path = asset
            .relative_path
            .as_deref()
            .map(normalize_project_path)
            .transpose()?;
        asset.source_path = asset
            .source_path
            .as_deref()
            .map(normalize_external_path)
            .transpose()?;
        check_one_location(
            &format!("Asset '{}'", asset.id),
            asset.relative_path.as_ref(),
            asset.source_path.as_ref(),
        )?;
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
        reference.source_path = reference
            .source_path
            .as_deref()
            .map(normalize_external_path)
            .transpose()?;
        if reference.relative_path.is_some() && reference.source_path.is_some() {
            return Err(format!(
                "Reference '{}' cannot have both a project-relative path and an external source path.",
                reference.id
            ));
        }
        match reference.kind.as_str() {
            // A text reference may legitimately be blank: the UI creates one the
            // moment "New definition" is clicked, before the user has typed. It
            // is marked incomplete there rather than failing the whole save —
            // refusing here blocked every unrelated edit in the project.
            "text" => {}
            // A file-backed reference has to say where its file is. An image is
            // copied into `references/`; a video or audio reference is not, and
            // carries the absolute path of the file the user already has.
            "image" | "video" | "audio"
                if reference.relative_path.is_some() || reference.source_path.is_some() => {}
            kind @ ("image" | "video" | "audio") => {
                return Err(format!(
                    "A reference of kind '{kind}' needs the file it refers to."
                ))
            }
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
        /* Normalise the scene BEFORE anything is judged, so both layers judge
           the same thing. An empty `shots` array collapses to no key at all —
           the same three-step tidy `normalize_shot_tags` performs, for the same
           reason: two builds must write the same bytes for the same scene. The
           ORDER of the shots is left exactly as given; the frontend orders them
           by start time when it reads them (`normalizeSceneShots`), and a layer
           that reordered on write would produce a spurious diff on every save.
           Both layers ACCEPT the same files either way, which is the contract. */
        if let Some(shots) = job.shots.as_mut() {
            let mut seen: BTreeSet<String> = BTreeSet::new();
            for shot in shots.iter_mut() {
                if shot.id.trim().is_empty() {
                    return Err(format!("Scene '{}' has a shot with an empty id.", job.id));
                }
                if !seen.insert(shot.id.clone()) {
                    return Err(format!(
                        "Scene '{}' has two shots with the id '{}'.",
                        job.id, shot.id
                    ));
                }
                if !shot.start_seconds.is_finite() || !(0.0..=15.0).contains(&shot.start_seconds) {
                    return Err(format!(
                        "Shot '{}' in scene '{}' starts at {} seconds, outside the 0-15 second scene.",
                        shot.id, job.id, shot.start_seconds
                    ));
                }
                shot.settings = normalize_shot_tags(shot.settings.take())
                    .map_err(|reason| format!("Shot '{}' {reason}", shot.id))?;
            }
        }
        if job.shots.as_ref().is_some_and(|shots| shots.is_empty()) {
            job.shots = None;
        }
        if let Some(seconds) = job.duration_seconds {
            if !seconds.is_finite() || !(0.0..=15.0).contains(&seconds) {
                return Err(format!(
                    "Scene '{}' is {seconds} seconds long, outside the 0-15 second range.",
                    job.id
                ));
            }
        }
        // Blank is the same as unset for both of these; the compiler falls back
        // to its own line, and writing `""` would be a key zod has to tolerate
        // for no gain.
        for field in [&mut job.soundscape, &mut job.music] {
            if field.as_deref().is_some_and(|text| text.trim().is_empty()) {
                *field = None;
            }
        }
        /* The words live in ONE of two places. A scene keeps them on its shots,
           so `prompt` and `creativeBrief` are only its mirror and may be blank;
           a job with no shots — every project written before scenes existed —
           keeps them here, where blank would mean the user's words were lost.
           `generationJobSchema.superRefine` in src/lib/project.ts is this rule. */
        let has_shots = job.shots.as_ref().is_some_and(|shots| !shots.is_empty());
        if job.id.trim().is_empty()
            || job.title.trim().is_empty()
            || job.compiled_prompt.trim().is_empty()
            || (!has_shots && (job.prompt.trim().is_empty() || job.creative_brief.trim().is_empty()))
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
        job.shot_tags = normalize_shot_tags(job.shot_tags.take())
            .map_err(|reason| format!("Generation job '{}' {reason}", job.id))?;
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

/// The settings file to READ from a project folder: the current name if it is
/// there, otherwise the first legacy name that is. Returns the current name
/// when the folder holds none of them, so the caller reports a missing
/// `polstudio.json` rather than a file nobody has written since 2025.
fn project_file_in(folder: &Path) -> PathBuf {
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

fn read_project(folder: &Path) -> Result<ProjectRecord, String> {
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
    let config = validate_and_normalize_config(config)?;
    Ok(ProjectRecord {
        folder_path: display_path(&canonical_folder),
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

/// `Path::canonicalize` returns a Windows *verbatim* path — the real prefix is
/// four characters, `\\?\`, and the previous version of this function looked
/// for a three-character `\?\` that no path has ever started with. Nothing was
/// stripped, so every project in the library rendered as
/// `\\?\D:\tmp\news\News broadcast`.
///
/// Strip it for any path that leaves this process. Every command
/// re-canonicalizes what it is given, so the stripped form is still a valid
/// round trip. A verbatim UNC path is `\\?\UNC\server\share`, whose ordinary
/// form is `\\server\share` — dropping only the `\\?\` would leave the bogus
/// `UNC\server\share`. Non-Windows paths carry neither prefix and come back
/// untouched.
pub(crate) fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
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
        .set_title("Open a PolStudio project folder")
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
                // Never a verbatim path: this one is shown in the composer
                // beside the file's name before the project even exists.
                source_path: display_path(&source),
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

/// One reference the user added: an image copied into `references/`, or a
/// video/audio file left where it is and pointed at.
#[derive(Debug, Clone)]
struct ImportedReference {
    kind: &'static str,
    name: String,
    relative_path: Option<String>,
    source_path: Option<String>,
}

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
static PICKED_EXTERNAL_FILES: std::sync::LazyLock<
    std::sync::Mutex<BTreeMap<PathBuf, BTreeSet<PathBuf>>>,
> = std::sync::LazyLock::new(Default::default);

/// The identity a project folder is remembered by. Canonical, so one folder
/// spelled two ways is one key. `None` when the folder cannot be resolved, in
/// which case nothing is remembered and the project file on disk stays the only
/// allow-list.
fn session_key(project_folder: &Path) -> Option<PathBuf> {
    project_folder.canonicalize().ok()
}

fn remember_picked_file(project_folder: &Path, path: &Path) {
    let (Some(key), Ok(canonical)) = (session_key(project_folder), path.canonicalize()) else {
        return;
    };
    // A poisoned lock only means another thread panicked mid-insert; the
    // fallback is the project file, so there is nothing to escalate here.
    if let Ok(mut picked) = PICKED_EXTERNAL_FILES.lock() {
        picked.entry(key).or_default().insert(canonical);
    }
}

/// Was this file picked in this run *for this project*? A pick made while a
/// different project was open is not an answer here.
fn was_picked_for_project(project_folder: &Path, canonical: &Path) -> bool {
    let Some(key) = session_key(project_folder) else {
        return false;
    };
    PICKED_EXTERNAL_FILES
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
fn external_source_path(source: &Path) -> Result<String, String> {
    let canonical = source
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", source.to_string_lossy()))?;
    normalize_external_path(&display_path(&canonical))
}

/// The same path, and a note that the user just chose this file FOR this
/// project — so its preview works before the project has been saved. Only the
/// import paths call this, and they only run on what came back from a native
/// picker.
fn picked_external_source_path(source: &Path, project_folder: &Path) -> Result<String, String> {
    let path = external_source_path(source)?;
    remember_picked_file(project_folder, source);
    Ok(path)
}

/// Adds one file to a project as a reference, following the same rule the media
/// panel does: pictures are small and get copied so the folder stays portable;
/// video and audio are not copied at any size.
fn import_reference_file(
    source: &Path,
    project_folder: &Path,
) -> Result<ImportedReference, String> {
    if !source.is_file() {
        return Err("The selected file does not exist.".into());
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match media_kind_and_mime(&extension) {
        Some(("image", _)) => {
            let copied = copy_reference_image(source, project_folder)?;
            Ok(ImportedReference {
                kind: "image",
                name: copied.name,
                relative_path: Some(copied.relative_path),
                source_path: None,
            })
        }
        Some((kind @ ("video" | "audio"), _)) => Ok(ImportedReference {
            kind,
            name: source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Reference")
                .to_string(),
            relative_path: None,
            source_path: Some(picked_external_source_path(source, project_folder)?),
        }),
        _ => Err("Choose an image, a video, or a sound file.".into()),
    }
}

/// Extensions PolStudio accepts, and what each one is. Anything not listed is
/// refused rather than imported as an unknown blob.
fn media_kind_and_mime(extension: &str) -> Option<(&'static str, &'static str)> {
    Some(match extension {
        "mp4" | "m4v" => ("video", "video/mp4"),
        "mov" => ("video", "video/quicktime"),
        "webm" => ("video", "video/webm"),
        "mkv" => ("video", "video/x-matroska"),
        "mp3" => ("audio", "audio/mpeg"),
        "m4a" | "aac" => ("audio", "audio/mp4"),
        "wav" => ("audio", "audio/wav"),
        "flac" => ("audio", "audio/flac"),
        "ogg" | "oga" => ("audio", "audio/ogg"),
        "png" => ("image", "image/png"),
        "jpg" | "jpeg" => ("image", "image/jpeg"),
        "webp" => ("image", "image/webp"),
        "gif" => ("image", "image/gif"),
        _ => return None,
    })
}

const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "png",
    "jpg", "jpeg", "webp", "gif",
];

/// Adds one file to the project. Video and audio are NEVER copied: a folder of
/// rushes is tens of gigabytes, and duplicating it to make the project folder
/// "portable" costs the user that much disk to gain a copy they did not ask
/// for. The project records where the file already lives instead. Images are
/// small and stay copied, so a project's own artwork travels with it.
fn import_media_file(source: &Path, project_folder: &Path) -> Result<ImportedMediaFile, String> {
    if !source.is_file() {
        return Err(format!("{} does not exist.", source.to_string_lossy()));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The selected file needs a file extension.".to_string())?;
    let (kind, mime_type) = media_kind_and_mime(&extension)
        .ok_or_else(|| format!("PolStudio cannot import .{extension} files yet."))?;
    if kind != "image" {
        return Ok(ImportedMediaFile {
            kind,
            name: source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Imported media")
                .to_string(),
            relative_path: None,
            source_path: Some(picked_external_source_path(source, project_folder)?),
            mime_type: mime_type.into(),
        });
    }
    let media_folder = project_folder.join("media");
    fs::create_dir_all(&media_folder)
        .map_err(|error| format!("Could not prepare media folder: {error}"))?;
    let display_name = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported media");
    let base_name = safe_folder_name(display_name);
    let mut file_name = format!("{base_name}.{extension}");
    let mut destination = media_folder.join(&file_name);
    let mut suffix = 2;
    // Never overwrite: two different files with the same name are two files.
    while destination.exists() {
        file_name = format!("{base_name}-{suffix}.{extension}");
        destination = media_folder.join(&file_name);
        suffix += 1;
    }
    fs::copy(source, &destination)
        .map_err(|error| format!("Could not copy {display_name} into this project: {error}"))?;
    Ok(ImportedMediaFile {
        kind,
        name: display_name.to_string(),
        relative_path: Some(format!("media/{file_name}")),
        source_path: None,
        mime_type: mime_type.into(),
    })
}

/// The canonical folder of a folder that actually holds a PolStudio project.
///
/// Every read command takes the folder from its caller, and "a folder" is not
/// the same claim as "a project". Requiring the settings file to be there means
/// a caller cannot aim a read at `C:\Users\NN\.ssh` and have the rest of the
/// command's checks — which only ever constrain the path *relative* to that
/// folder — do exactly what they promise while pointing at the wrong disk.
fn project_root(folder_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve project folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected project folder does not exist.".into());
    }
    if !project_file_in(&root).is_file() {
        return Err(format!(
            "{} does not hold a PolStudio project.",
            display_path(&root)
        ));
    }
    Ok(root)
}

/// Hands the webview the bytes of one file inside a project, so it can show a
/// reference image the user imported. Confined to a real project folder, twice
/// over: the folder must actually contain the settings file, and the relative
/// path goes through the same normaliser every stored path does and is then
/// checked to still sit under the canonical root. So a crafted `..` in a
/// hand-edited polstudio.json cannot read the rest of the disk, and a caller
/// that names some other folder entirely does not get a reader for it.
#[tauri::command]
fn read_project_file(
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

/// Every absolute path this project has recorded — the media and references
/// that live OUTSIDE the folder. It is the allow-list for
/// `read_external_media_file`: the webview may read a file outside the project
/// only because the project itself names it.
fn recorded_external_paths(config: &ProjectConfig) -> Vec<String> {
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

/// The bytes of one file the project points at but does not contain.
///
/// Video and audio are no longer copied in, so the webview has to be able to
/// read them where they are — and that is exactly the shape of an arbitrary
/// file read. Read the rule literally, because it is wider than "the user
/// picked this file" and pretending otherwise is how the next reader is fooled:
///
/// 1. The folder named must actually hold a project, and the path asked for
///    must be one that project NAMES — either written in its `polstudio.json`
///    on disk (canonicalised on both sides before comparing), or picked from a
///    native dialog for THAT project earlier in this run. The session list
///    exists because saving is deliberate: a clip imported a moment ago is not
///    in the project file yet.
/// 2. It must still carry a media extension PolStudio imports (checked on the
///    canonicalised path, so a symlink is judged by its target), so no project
///    file can turn this into a reader for keys, wallets or documents.
/// 3. It must be a regular file that exists now.
///
/// So the actor whose choice opens a file is the PROJECT FILE, not necessarily
/// the person. A `polstudio.json` the user merely OPENED — a template a
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
/// machine reopens silently, while a `polstudio.json` that arrived from
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
fn read_external_media_file(
    folder_path: String,
    source_path: String,
) -> Result<tauri::ipc::Response, String> {
    external_media_bytes(&folder_path, &source_path).map(tauri::ipc::Response::new)
}

fn external_media_bytes(folder_path: &str, source_path: &str) -> Result<Vec<u8>, String> {
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
    if !recorded && !was_picked_for_project(&root, &requested) {
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
        return Err(format!(
            "{source_path} is not a media file PolStudio reads."
        ));
    }
    fs::read(&requested).map_err(|error| format!("Could not read {source_path}: {error}"))
}

/// Adds the chosen files to the project: images are copied in, video and audio
/// are recorded where they already are. An empty list means the user cancelled.
#[tauri::command]
fn import_media_files(
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
            let imported = import_reference_file(source, &project_folder)?;
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
                // Whatever the file actually is. A video or sound reference is
                // recorded by path, not copied, so calling it an image here
                // would be a claim about a file nobody has looked at.
                kind: imported.kind.into(),
                name: imported.name,
                // MUST stay empty. The prompt compiler emits a reference's
                // description as the subject's own traits in the text sent to
                // the paid model, so any sentence written here is presented to
                // the model as if the user had described the image that way.
                // Same hazard the text path documents at src/lib/project.ts:87.
                description: String::new(),
                content: None,
                relative_path: imported.relative_path,
                source_path: imported.source_path,
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

/// Probes the video engine from provider settings alone. The settings screen
/// has no project in hand — engine paths belong to the machine, not to a
/// project file — so it cannot go through `runtime_status`.
#[tauri::command]
fn vidfab_status(settings: BTreeMap<String, ProviderSetting>) -> vidfab::VidfabStatus {
    vidfab::status(&settings)
}

/// One OS picker for one engine path. `directory` picks a folder (the
/// tokenizer is one); `extensions` filters the file picker and an empty list
/// means any file.
#[tauri::command]
fn choose_engine_path(
    app: AppHandle,
    title: String,
    directory: bool,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title(title);
    if !directory && !extensions.is_empty() {
        let filters = extensions.iter().map(String::as_str).collect::<Vec<_>>();
        dialog = dialog.add_filter("Supported files", &filters);
    }
    let selected = if directory {
        dialog.blocking_pick_folder()
    } else {
        dialog.blocking_pick_file()
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Could not access the selected path: {error}"))?;
    Ok(Some(display_path(&path)))
}

/// What is installed on this computer: the two agent CLIs and the video engine.
///
/// Async on purpose — this launches two CLIs (up to 7s each) and loads the
/// engine DLL. Run inline on the main thread it froze the window for as long
/// as that took, which is what it was doing.
///
/// Takes provider settings rather than a whole project: what is installed here
/// is a property of the machine, so the frontend probes it ONCE at startup and
/// every project shares the answer.
#[tauri::command]
async fn runtime_status(
    settings: BTreeMap<String, ProviderSetting>,
) -> Result<RuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || RuntimeStatus {
        providers: agent::provider_statuses(&settings),
        vidfab: vidfab::status(&settings),
    })
    .await
    .map_err(|error| format!("Could not probe this computer: {error}"))
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

/* ── Exit guard ──────────────────────────────────────────────────────────────
   The video engine runs inside this process, so closing the window ends a
   generation outright — and vidfab writes no file of its own, so an unfinished
   run leaves nothing behind. The webview therefore has to be able to answer the
   close request before the window goes away.

   The window is held open ONLY while the frontend has said something is
   generating (`set_generation_active`). A webview that never loaded, or one
   with nothing to lose, closes on the first click exactly as before: the guard
   can never be the reason a user is stuck in a window that will not shut.
   -------------------------------------------------------------------------- */

#[derive(Default)]
struct ExitGuard {
    /// Set by the frontend whenever the number of running or queued generations
    /// changes. False means "close without asking".
    generation_active: std::sync::atomic::AtomicBool,
    /// True between putting the question to the webview and its answer, so a
    /// second click on the close button does not stack a second dialog.
    asking: std::sync::atomic::AtomicBool,
}

#[derive(Debug, PartialEq, Eq)]
enum CloseDecision {
    /// Nothing is generating: let the window close.
    Close,
    /// Hold the window open and ask the webview.
    Ask,
    /// Hold the window open; the question is already on screen.
    Waiting,
}

impl ExitGuard {
    fn on_close_requested(&self) -> CloseDecision {
        if !self.generation_active.load(Ordering::Acquire) {
            return CloseDecision::Close;
        }
        if self.asking.swap(true, Ordering::AcqRel) {
            CloseDecision::Waiting
        } else {
            CloseDecision::Ask
        }
    }

    /// Records the webview's answer. `true` also clears the active flag, so the
    /// close that follows is not stopped by the guard a second time.
    fn answered(&self, confirmed: bool) {
        self.asking.store(false, Ordering::Release);
        if confirmed {
            self.generation_active.store(false, Ordering::Release);
        }
    }
}

#[tauri::command]
fn set_generation_active(state: tauri::State<'_, ExitGuard>, active: bool) {
    state.generation_active.store(active, Ordering::Release);
}

#[tauri::command]
fn answer_app_close(window: tauri::Window, state: tauri::State<'_, ExitGuard>, confirmed: bool) {
    state.answered(confirmed);
    if confirmed {
        let _ = window.destroy();
    }
}

/* The window's own ground — what the OS paints before the webview has anything
 * to show. A FIFTH copy of a colour that tokens.css already owns, after
 * tokens.css itself, theme.ts, public/theme-boot.js and the `backgroundColor`
 * in tauri.conf.json; src/lib/theme.test.ts now pins every one of them.
 *
 * Why Rust repaints it at all: tauri.conf.json holds ONE static value, and the
 * appearance preference has three states. Left at the dark ground, a
 * light-theme computer showed a black window for the moment before the webview
 * painted. The preference itself lives in the webview's localStorage — there is
 * nothing here that can read it — so this follows the OS instead, which is
 * exactly what the default "system" choice resolves to, and is right for an
 * explicit choice that agrees with the computer. The one case it still gets
 * wrong is an explicit choice that opposes the OS, and no value obtainable in
 * this process fixes that: it would need the preference duplicated into a
 * second store, which is precisely the drift this comment exists to record.
 * theme-boot.js corrects it on the first frame the webview draws either way. */
const GROUND_DARK: tauri::window::Color = tauri::window::Color(0x08, 0x0a, 0x0f, 0xff);
const GROUND_LIGHT: tauri::window::Color = tauri::window::Color(0xee, 0xf1, 0xf6, 0xff);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager as _;
            if let Some(window) = app.get_webview_window("main") {
                let ground = if matches!(window.theme(), Ok(tauri::Theme::Light)) {
                    GROUND_LIGHT
                } else {
                    GROUND_DARK
                };
                // A window that will not take a background colour is not a
                // reason to refuse to start: the webview repaints in a frame.
                let _ = window.set_background_color(Some(ground));
            }
            Ok(())
        })
        .manage(agent::AgentRuntime::default())
        .manage(vidfab::VidfabRuntime::default())
        .manage(ExitGuard::default())
        .on_window_event(|window, event| {
            use tauri::{Emitter as _, Manager as _};
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let guard = window.state::<ExitGuard>();
            match guard.on_close_requested() {
                CloseDecision::Close => {}
                CloseDecision::Waiting => api.prevent_close(),
                CloseDecision::Ask => {
                    api.prevent_close();
                    // If the question cannot even be delivered there is nobody
                    // to answer it, and refusing to close would be worse than
                    // closing unasked.
                    if window.emit("app-close-requested", ()).is_err() {
                        guard.answered(true);
                        let _ = window.destroy();
                    }
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_project,
            choose_project_folder,
            choose_initial_reference_images,
            choose_reference_image,
            import_media_files,
            read_project_file,
            read_external_media_file,
            create_project,
            save_project,
            runtime_status,
            vidfab_status,
            choose_engine_path,
            run_agent_turn,
            cancel_agent_turn,
            resolve_vidfab_plan,
            enqueue_vidfab_generation,
            cancel_vidfab_generation,
            set_generation_active,
            answer_app_close,
            export::choose_export_destination,
            export::write_export_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running PolStudio");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ProjectConfig {
        serde_json::from_str(include_str!("../../fixtures/project-v1-complete.json")).unwrap()
    }

    /// A project created BEFORE scenes existed, and the shape every project on
    /// disk today still has: one generation job with no `shots`, no
    /// `durationSeconds` and no sound fields, holding its words in `prompt` and
    /// `creativeBrief` alone. It was the byte-exact output of
    /// `createProjectConfig`, which now opens a scene instead — the file is kept
    /// exactly as it was because that is the point of it. The complete fixture
    /// cannot stand in for it: it has no draft job without a clip, which is the
    /// shape that broke every create and open.
    fn created_fixture() -> ProjectConfig {
        serde_json::from_str(include_str!("../../fixtures/project-v1-created.json")).unwrap()
    }

    /// A project whose video and audio live OUTSIDE the folder, alongside a
    /// copied image — every shape the two location fields can take, in one
    /// file both validators read.
    fn external_fixture() -> ProjectConfig {
        serde_json::from_str(include_str!(
            "../../fixtures/project-v1-external-media.json"
        ))
        .unwrap()
    }

    /// A SCENE: three shots with their own start times, settings and reference
    /// tokens, plus the two per-prompt sound fields. Every key scenes added is
    /// present here, so a struct that forgets `skip_serializing_if` shows up in
    /// `rust-serialized-scene.json` and fails on the frontend's real zod.
    fn scene_fixture() -> ProjectConfig {
        serde_json::from_str(include_str!("../../fixtures/project-v1-scene.json")).unwrap()
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
        for (name, config) in [
            ("created", created_fixture()),
            ("complete", fixture()),
            ("scene", scene_fixture()),
        ] {
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
        // The external-location shapes: an absolute Windows path, an absolute
        // POSIX one, a UNC share, and a copied image beside them. Rust writes
        // exactly these bytes; the frontend suite parses them with real zod.
        write_fixture(
            "rust-serialized-external-media.json",
            &serialize(&validate_and_normalize_config(external_fixture()).unwrap()),
        );
        // Everything a scene added: shots with start times and per-shot
        // settings, a scene length, and the two sound fields.
        write_fixture(
            "rust-serialized-scene.json",
            &serialize(&validate_and_normalize_config(scene_fixture()).unwrap()),
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
        for (name, config) in [
            ("created", created_fixture()),
            ("complete", fixture()),
            ("scene", scene_fixture()),
        ] {
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
        normalized.assets[0].relative_path = Some(".\\media\\imported//macro.mp4".into());
        assert_eq!(
            validate_and_normalize_config(normalized).unwrap().assets[0]
                .relative_path
                .as_deref(),
            Some("media/imported/macro.mp4")
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
            escaping.assets[0].relative_path = Some(path.into());
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
    fn the_windows_verbatim_prefix_never_reaches_the_user() {
        // `\\?\D:\tmp\news\News broadcast` is what canonicalize hands back and
        // what the library rendered under every project. The prefix is an
        // OS-level escape hatch; the user's path is the rest of it.
        assert_eq!(
            display_path(Path::new(r"\\?\D:\tmp\news\News broadcast")),
            r"D:\tmp\news\News broadcast"
        );
        // A verbatim UNC path names a share. Stripping only `\\?\` would leave
        // `UNC\studio-nas\shared`, which points at nothing.
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\studio-nas\shared\Footage")),
            r"\\studio-nas\shared\Footage"
        );
        // Everything else is already what it should be, prefix-shaped or not.
        for path in [
            r"D:\tmp\news",
            "/home/nn/projects/news",
            r"\\studio-nas\shared",
            "relative/is/left/alone",
            r"D:\?\odd\but\real",
        ] {
            assert_eq!(display_path(Path::new(path)), path);
        }
        // And the stripped form is what every command re-canonicalises, so a
        // real project folder still opens by the name the user was shown.
        let root = tempfile::tempdir().unwrap();
        let created = create_project_in(root.path(), &fixture()).unwrap();
        assert!(
            !created.folder_path.starts_with(r"\\?\"),
            "a verbatim path reached the frontend: {}",
            created.folder_path
        );
        assert!(read_project(Path::new(&created.folder_path)).is_ok());
    }

    #[test]
    fn video_and_audio_are_recorded_where_they_are_and_images_are_copied() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let outside = root.path().join("Rushes");
        fs::create_dir(&outside).unwrap();

        for (name, bytes) in [
            ("news broadcast.mp4", &b"video"[..]),
            ("room tone.wav", &b"audio"[..]),
            ("title card.png", &b"\x89PNG\r\n\x1a\n"[..]),
        ] {
            fs::write(outside.join(name), bytes).unwrap();
        }

        // A rush is not duplicated to make a folder "portable": the project
        // records where it already is.
        for name in ["news broadcast.mp4", "room tone.wav"] {
            let imported = import_media_file(&outside.join(name), &project).unwrap();
            assert_eq!(imported.relative_path, None, "{name} was copied");
            let source = imported.source_path.expect("external media needs a path");
            assert!(
                !source.starts_with(r"\\?\"),
                "a verbatim path was stored: {source}"
            );
            assert_eq!(
                normalize_external_path(&source).unwrap(),
                source,
                "{name} stored a path the schema would reject"
            );
            assert!(Path::new(&source).is_file());
        }
        // A picture is small, and a project's own artwork should travel with it.
        let image = import_media_file(&outside.join("title card.png"), &project).unwrap();
        assert_eq!(image.relative_path.as_deref(), Some("media/title card.png"));
        assert_eq!(image.source_path, None);
        assert!(project.join("media/title card.png").is_file());

        // Nothing but the image ever landed inside the project folder.
        let copied: Vec<_> = fs::read_dir(project.join("media"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(copied, ["title card.png"]);
    }

    #[test]
    fn a_video_reference_is_pointed_at_while_an_image_reference_is_copied() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let video = root.path().join("reference cut.mov");
        fs::write(&video, b"video").unwrap();
        let image = root.path().join("harbor facade.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();

        let referenced = import_reference_file(&video, &project).unwrap();
        assert_eq!(referenced.kind, "video");
        assert_eq!(referenced.relative_path, None);
        assert!(referenced.source_path.is_some());
        assert!(
            !project
                .join("references")
                .join("reference cut.mov")
                .exists(),
            "a video reference was copied into the project"
        );

        let copied = import_reference_file(&image, &project).unwrap();
        assert_eq!(copied.kind, "image");
        assert_eq!(
            copied.relative_path.as_deref(),
            Some("references/harbor facade.png")
        );
        assert_eq!(copied.source_path, None);
        assert!(project.join("references/harbor facade.png").is_file());
    }

    #[test]
    fn external_media_is_readable_only_because_the_project_names_it() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("Rushes");
        fs::create_dir(&outside).unwrap();
        let clip = outside.join("rush-01.mp4");
        fs::write(&clip, b"rush bytes").unwrap();
        let secret = outside.join("id_rsa");
        fs::write(&secret, b"private key").unwrap();
        let unlisted = outside.join("rush-02.mp4");
        fs::write(&unlisted, b"another rush").unwrap();

        let mut config = created_fixture();
        config.assets.push(ProjectAsset {
            id: "asset-external".into(),
            kind: "video".into(),
            name: "Rush 01".into(),
            relative_path: None,
            source_path: Some(external_source_path(&clip).unwrap()),
            mime_type: "video/mp4".into(),
            duration_ms: None,
            width: None,
            height: None,
            created_at: config.created_at.clone(),
        });
        let created = create_project_in(root.path(), &config).unwrap();
        let folder = created.folder_path.as_str();
        let recorded = created.config.assets[0].source_path.clone().unwrap();

        // The file the user picked, which the project now names.
        assert_eq!(
            external_media_bytes(folder, &recorded).unwrap(),
            b"rush bytes"
        );

        // A media file next to it that the project does NOT name.
        let error = external_media_bytes(folder, &unlisted.to_string_lossy()).unwrap_err();
        assert!(error.contains("not one of the files this project points at"));

        // And the shape this command must never take: reading anything the
        // caller asks for. A path the project does not carry is refused
        // whatever it points at.
        assert!(external_media_bytes(folder, &secret.to_string_lossy()).is_err());
        assert!(external_media_bytes(folder, "/etc/passwd").is_err());
    }

    #[test]
    fn a_clip_imported_a_moment_ago_previews_before_the_project_is_saved() {
        // Saving is a deliberate act, so the project file on disk does not
        // mention a clip the user just imported. Refusing to read it until they
        // press Save would mean every fresh import shows a broken preview.
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        write_project(&project, &created_fixture()).unwrap();
        let clip = root.path().join("just picked.mp4");
        fs::write(&clip, b"fresh rush").unwrap();

        let imported = import_media_file(&clip, &project).unwrap();
        let source = imported.source_path.unwrap();
        assert!(
            recorded_external_paths(&read_project(&project).unwrap().config).is_empty(),
            "the saved project must not know about the import yet"
        );
        assert_eq!(
            external_media_bytes(&project.to_string_lossy(), &source).unwrap(),
            b"fresh rush"
        );

        // The gap it closes is exactly one file wide: a sibling nobody picked
        // is still refused.
        let sibling = root.path().join("never picked.mp4");
        fs::write(&sibling, b"other rush").unwrap();
        assert!(
            external_media_bytes(&project.to_string_lossy(), &sibling.to_string_lossy()).is_err()
        );
    }

    /// S5: the window shipped with `"csp": null`, which is not a policy — it is
    /// the absence of one, and it is what made every other fence here matter so
    /// much. The policy has to stay narrow in the direction that costs an
    /// attacker something (no inline or eval'd script, nothing off-origin) and
    /// stay open in the two directions media previews genuinely need: `blob:`
    /// URLs for imported footage and `data:` URIs for thumbnails.
    #[test]
    fn the_window_ships_a_policy_that_previews_still_work_under() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"]
            .as_str()
            .expect("the webview must ship a Content-Security-Policy");
        let directive = |name: &str| {
            csp.split(';')
                .map(str::trim)
                .find(|part| part.split_whitespace().next() == Some(name) || part.trim() == name)
                .unwrap_or_else(|| panic!("the policy says nothing about {name}: {csp}"))
                .to_string()
        };

        // Scripts: same origin only, and nothing the page can talk itself into.
        let script = directive("script-src");
        assert!(script.contains("'self'"), "{script}");
        for hole in ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:"] {
            assert!(
                !script.split_whitespace().any(|source| source == hole),
                "script-src allows {hole}: {script}"
            );
        }
        assert!(directive("default-src").contains("'self'"));
        assert!(directive("object-src").contains("'none'"));

        // Previews: a blob URL is how every imported clip and image reaches an
        // <img> or a <video>, and a data URI is how thumbnails do. A policy
        // that forbids these does not secure the app, it breaks it.
        for name in ["img-src", "media-src"] {
            let sources = directive(name);
            assert!(
                sources.contains("blob:"),
                "{name} blocks previews: {sources}"
            );
            assert!(
                sources.contains("data:"),
                "{name} blocks thumbnails: {sources}"
            );
        }
        // invoke() reaches Rust over the ipc protocol.
        assert!(directive("connect-src").contains("ipc:"));
    }

    /// The window must NOT take the OS drag-and-drop handler.
    ///
    /// Tauri defaults `dragDropEnabled` to true, which on Windows makes wry
    /// call `RegisterDragDrop` on the window and own the OLE drop target. That
    /// is the same channel WebView2 needs for HTML5 drag-and-drop *inside* the
    /// page, so with it on, a drag started in the media panel fires `dragstart`
    /// and then `dragend` immediately — no `dragover`, no `drop`, no clip. The
    /// user reported exactly that and the jsdom tests could not see it, because
    /// jsdom has no OS drag loop and a browser has no Tauri window.
    ///
    /// Turning it off costs nothing the app uses: files come in through the
    /// Import button's native dialog, not by dropping them on the window.
    #[test]
    fn the_window_leaves_drag_and_drop_to_the_webview() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(
            window["dragDropEnabled"],
            serde_json::Value::Bool(false),
            "the window must set dragDropEnabled: false, or dragging media onto \
             a track silently does nothing in the desktop app: {window}"
        );
    }

    /// Writes a minimal real project folder and returns it, so a test can say
    /// "a folder that holds a project" without the create ceremony.
    fn project_folder_at(path: &Path) -> PathBuf {
        fs::create_dir_all(path).unwrap();
        write_project(path, &created_fixture()).unwrap();
        path.to_path_buf()
    }

    /// S1: the perimeter this command actually has, pinned so nobody has to
    /// take the docstring's word for it. The actor that opens a file here is
    /// the PROJECT FILE, not the person — a `polstudio.json` the user merely
    /// opened can name any media file on the disk and get its bytes. That
    /// follows from trusting any project file the user opens; the unbuilt
    /// narrowing is a per-installation approval list (see the command's
    /// docstring). What it IS bounded by is asserted here too.
    #[test]
    fn a_project_the_user_only_opened_reads_any_media_file_it_names() {
        let root = tempfile::tempdir().unwrap();
        let pictures = root.path().join("Pictures");
        fs::create_dir(&pictures).unwrap();
        let private_photo = pictures.join("private.jpg");
        fs::write(&private_photo, b"PRIVATE PHOTO BYTES").unwrap();
        let diary = pictures.join("diary.txt");
        fs::write(&diary, b"DIARY").unwrap();
        let unnamed = pictures.join("holiday.jpg");
        fs::write(&unnamed, b"ANOTHER PHOTO").unwrap();

        // A project file the user did not write: a template a colleague sent,
        // an unzipped folder. Nobody picked these paths in any dialog.
        let mut config = created_fixture();
        for (index, (id, file)) in [("named", &private_photo), ("crafted", &diary)]
            .into_iter()
            .enumerate()
        {
            config.assets.push(ProjectAsset {
                id: format!("asset-{id}"),
                kind: "image".into(),
                name: format!("Shared {index}"),
                relative_path: None,
                source_path: Some(external_source_path(file).unwrap()),
                mime_type: "image/jpeg".into(),
                duration_ms: None,
                width: None,
                height: None,
                created_at: config.created_at.clone(),
            });
        }
        let shared = root.path().join("Shared project");
        fs::create_dir(&shared).unwrap();
        write_project(&shared, &config).unwrap();
        let folder = shared.to_string_lossy().into_owned();

        // The rule, stated plainly: the project names it, so it is served.
        let named = config.assets[0].source_path.clone().unwrap();
        assert_eq!(
            external_media_bytes(&folder, &named).unwrap(),
            b"PRIVATE PHOTO BYTES",
            "this is the documented perimeter, not a wish about it"
        );

        // And the two things that DO bound it. Media extensions only, checked
        // on the canonical path — a project file cannot name credentials.
        let crafted = config.assets[1].source_path.clone().unwrap();
        assert!(external_media_bytes(&folder, &crafted)
            .unwrap_err()
            .contains("not a media file"));
        // And only what the project names: not the whole folder around it.
        assert!(external_media_bytes(&folder, &unnamed.to_string_lossy())
            .unwrap_err()
            .contains("not one of the files this project points at"));
    }

    /// S2: a file picked while project A was open is not project B's to read.
    /// The session list used to be process-global, so opening a colleague's
    /// project after importing your own rushes handed their project file a
    /// reader for your footage — no hand-editing required, the paths were
    /// already in memory.
    #[test]
    fn one_project_s_picks_are_not_another_project_s_to_read() {
        let root = tempfile::tempdir().unwrap();
        let rushes = root.path().join("Rushes");
        fs::create_dir(&rushes).unwrap();
        let footage = rushes.join("my footage.mp4");
        fs::write(&footage, b"A's footage").unwrap();

        let mine = project_folder_at(&root.path().join("Mine"));
        let theirs = project_folder_at(&root.path().join("Theirs"));

        // Imported into MY project, and not saved yet: only the session list
        // knows about it.
        let imported = import_media_file(&footage, &mine).unwrap();
        let source = imported.source_path.unwrap();
        assert!(recorded_external_paths(&read_project(&mine).unwrap().config).is_empty());

        assert_eq!(
            external_media_bytes(&mine.to_string_lossy(), &source).unwrap(),
            b"A's footage",
            "the project the clip was imported into must still preview it"
        );
        let error = external_media_bytes(&theirs.to_string_lossy(), &source).unwrap_err();
        assert!(
            error.contains("not one of the files this project points at"),
            "another project read a file picked for this one: {error}"
        );
    }

    /// S3: `read_project_file` confines the relative path against the folder it
    /// is handed, and nothing used to check that the folder was a project. The
    /// pair was the hole: every check passed while pointing at `.ssh`.
    #[test]
    fn reading_a_project_file_requires_the_folder_to_hold_a_project() {
        let root = tempfile::tempdir().unwrap();
        let ssh = root.path().join(".ssh");
        fs::create_dir(&ssh).unwrap();
        fs::write(ssh.join("id_rsa"), b"BEGIN OPENSSH PRIVATE KEY").unwrap();

        // `tauri::ipc::Response` is not `Debug`, so the error comes out by hand.
        let read = |folder: &Path, relative: &str| {
            read_project_file(folder.to_string_lossy().into_owned(), relative.into())
                .map(|_| ())
                .err()
        };
        let error = read(&ssh, "id_rsa").expect("a folder with no project was read");
        assert!(
            error.contains("does not hold a PolStudio project"),
            "unexpected error: {error}"
        );
        // Same shape for the external read, which takes the folder too.
        assert!(external_media_bytes(
            &ssh.to_string_lossy(),
            &ssh.join("id_rsa").to_string_lossy()
        )
        .unwrap_err()
        .contains("does not hold a PolStudio project"));

        // A real project still reads its own files.
        let project = project_folder_at(&root.path().join("project"));
        fs::create_dir_all(project.join("references")).unwrap();
        fs::write(project.join("references/harbor.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert_eq!(read(&project, "references/harbor.png"), None);
        // ...and still cannot climb out of itself.
        assert!(read(&project, "../.ssh/id_rsa").is_some());
    }

    #[test]
    fn a_project_file_only_yields_media_a_hand_edit_cannot_widen() {
        // Belt and braces for the direction the allow-list alone cannot cover:
        // a HAND-EDITED project file naming something that is not media. The
        // path is recorded, so the allow-list passes — the extension check is
        // what refuses it.
        let root = tempfile::tempdir().unwrap();
        let secret = root.path().join("id_rsa");
        fs::write(&secret, b"private key").unwrap();

        let mut config = created_fixture();
        config.assets.push(ProjectAsset {
            id: "asset-crafted".into(),
            kind: "video".into(),
            name: "Not a clip".into(),
            relative_path: None,
            source_path: Some(external_source_path(&secret).unwrap()),
            mime_type: "video/mp4".into(),
            duration_ms: None,
            width: None,
            height: None,
            created_at: config.created_at.clone(),
        });
        let created = create_project_in(root.path(), &config).unwrap();
        let recorded = created.config.assets[0].source_path.clone().unwrap();
        let error = external_media_bytes(&created.folder_path, &recorded).unwrap_err();
        assert!(
            error.contains("not a media file"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn every_stored_location_is_one_place_and_only_one() {
        let external = external_fixture();
        let normalized = validate_and_normalize_config(external.clone()).unwrap();
        assert_eq!(
            normalized.assets[0].source_path.as_deref(),
            Some(r"D:\tmp\news\News broadcast\rush-01.mp4"),
            "an external path is stored verbatim, not rewritten as a relative one"
        );
        assert!(normalized.assets[0].relative_path.is_none());

        // Both at once is not a location, and neither is neither.
        let mut both = external_fixture();
        both.assets[0].relative_path = Some("media/rush-01.mp4".into());
        assert!(validate_and_normalize_config(both)
            .unwrap_err()
            .contains("cannot have both"));
        let mut neither = external_fixture();
        neither.assets[0].source_path = None;
        assert!(validate_and_normalize_config(neither)
            .unwrap_err()
            .contains("must have either"));

        // A "source path" that is not absolute resolves against nothing.
        for path in [
            "Footage\\clip.mp4",
            "media/clip.mp4",
            "..\\..\\clip.mp4",
            "D:\\..\\clip.mp4",
            "",
        ] {
            let mut relative = external_fixture();
            relative.assets[0].source_path = Some(path.into());
            assert!(
                validate_and_normalize_config(relative).is_err(),
                "accepted '{path}' as an absolute source path"
            );
        }
        // Every absolute form is accepted on every platform: a project file
        // written on Windows is still read on Linux and back.
        for path in [
            "D:\\Footage\\clip.mp4",
            "D:/Footage/clip.mp4",
            "/home/nn/clip.mp4",
            "\\\\nas\\share\\clip.mp4",
        ] {
            let mut absolute = external_fixture();
            absolute.assets[0].source_path = Some(path.into());
            assert!(
                validate_and_normalize_config(absolute).is_ok(),
                "rejected the absolute path '{path}'"
            );
        }

        // References follow the same rule, and a file-backed one still needs
        // its file.
        let mut both_on_reference = external_fixture();
        both_on_reference.references[1].relative_path = Some("references/cut.mov".into());
        assert!(validate_and_normalize_config(both_on_reference).is_err());
        let mut nowhere = external_fixture();
        nowhere.references[1].source_path = None;
        assert!(validate_and_normalize_config(nowhere).is_err());
    }

    #[test]
    fn the_settings_file_is_polstudio_json_and_the_older_names_still_open() {
        assert_eq!(PROJECT_FILE_NAME, "polstudio.json");
        let root = tempfile::tempdir().unwrap();
        let created = create_project_in(root.path(), &fixture()).unwrap();
        let folder = PathBuf::from(&created.folder_path);
        assert!(folder.join("polstudio.json").is_file());

        // Every older name still opens, one folder per name, because a project
        // written by an earlier build must not become unopenable.
        for legacy in LEGACY_PROJECT_FILE_NAMES {
            let old = root.path().join(format!("old-{legacy}"));
            fs::create_dir(&old).unwrap();
            fs::copy(folder.join(PROJECT_FILE_NAME), old.join(legacy)).unwrap();
            assert_eq!(
                read_project(&old).unwrap().config,
                created.config,
                "a project stored as {legacy} failed to open"
            );
            // Saving migrates the name and leaves the old file where it is, so
            // the build that wrote it can still read the project.
            write_project(&old, &created.config).unwrap();
            assert!(old.join(PROJECT_FILE_NAME).is_file());
            assert!(old.join(legacy).is_file());
            // The new name wins once both exist.
            assert_eq!(project_file_in(&old), old.join(PROJECT_FILE_NAME));
        }
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
            source_path: None,
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
        rejects("shot tag group id the frontend regex refuses", |config| {
            config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
                "Camera Movement".into(),
                vec!["push-in".into()],
            )]));
        });
        rejects("shot tag id the frontend regex refuses", |config| {
            config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
                "cameraMovement".into(),
                vec!["Push In".into()],
            )]));
        });
        rejects("empty shot tag id", |config| {
            config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
                "cameraMovement".into(),
                vec![String::new()],
            )]));
        });
    }

    #[test]
    fn shot_tags_normalize_the_same_way_the_frontend_does() {
        // The three steps `normalizeShotTagSelection` performs in
        // src/lib/shot-tags.ts, in the same order. If these drift the same
        // selection serialises differently depending on which layer wrote it
        // last, and every save shows a diff nobody made.
        let mut config = fixture();
        config.generation_jobs[0].shot_tags = Some(BTreeMap::from([
            // A group emptied by unticking its last option: dropped, not stored.
            ("mood".into(), Vec::new()),
            // A repeat: kept once, in first-seen order.
            (
                "lighting".into(),
                vec!["soft-light".into(), "soft-light".into(), "backlight".into()],
            ),
        ]));
        let normalized = validate_and_normalize_config(config).unwrap();
        let tags = normalized.generation_jobs[0].shot_tags.as_ref().unwrap();
        assert!(!tags.contains_key("mood"), "an empty group must be dropped");
        assert_eq!(
            tags["lighting"],
            vec!["soft-light".to_string(), "backlight".to_string()]
        );

        // Nothing left to say -> the key is absent, never `{}` and never null,
        // so a shot built from prose alone writes the file it always wrote.
        let mut emptied = fixture();
        emptied.generation_jobs[0].shot_tags = Some(BTreeMap::from([("mood".into(), Vec::new())]));
        let emptied = validate_and_normalize_config(emptied).unwrap();
        assert_eq!(emptied.generation_jobs[0].shot_tags, None);
        let json = serde_json::to_string(&emptied).unwrap();
        assert!(
            !json.contains("shotTags"),
            "an empty selection must not reach the file: {json}"
        );

        // A tag id this build has never heard of belongs to the user, not to
        // this build: it survives a load and a save untouched.
        let mut future = fixture();
        future.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
            "weather".into(),
            vec!["light-rain".into()],
        )]));
        let future = validate_and_normalize_config(future).unwrap();
        assert_eq!(
            future.generation_jobs[0].shot_tags.as_ref().unwrap()["weather"],
            vec!["light-rain".to_string()]
        );
    }

    #[test]
    fn a_project_written_before_shot_tags_existed_still_opens() {
        // The created fixture is the byte-exact output of createProjectConfig
        // before this field existed; `created_fixture()` still deserialises it
        // because the field is `#[serde(default)]`.
        let created = validate_and_normalize_config(created_fixture()).unwrap();
        assert_eq!(created.generation_jobs[0].shot_tags, None);
        let json = serde_json::to_string_pretty(&created).unwrap();
        assert!(
            !json.contains("shotTags"),
            "a tagless job must not grow a shotTags key: {json}"
        );
    }

    #[test]
    fn a_project_written_before_scenes_existed_still_opens_and_grows_no_scene_keys() {
        // Both pre-scene shapes: the byte-exact output of createProjectConfig,
        // and a fuller project. Neither has `shots`, `durationSeconds`,
        // `soundscape` or `music`, and neither may sprout one — the frontend
        // reads such a job as a single-shot scene without the file changing.
        for (name, config) in [("created", created_fixture()), ("complete", fixture())] {
            let opened = validate_and_normalize_config(config).unwrap();
            let job = &opened.generation_jobs[0];
            assert_eq!(job.shots, None, "{name}");
            assert_eq!(job.duration_seconds, None, "{name}");
            assert_eq!(job.soundscape, None, "{name}");
            assert_eq!(job.music, None, "{name}");
            let json = serde_json::to_string_pretty(&opened).unwrap();
            for key in ["shots", "durationSeconds", "soundscape", "music"] {
                assert!(
                    !json.contains(&format!("\"{key}\"")),
                    "the {name} fixture grew a {key} key it never had: {json}"
                );
            }
        }
    }

    #[test]
    fn a_scene_keeps_its_shots_and_normalizes_them_the_way_the_frontend_does() {
        let scene = validate_and_normalize_config(scene_fixture()).unwrap();
        let job = &scene.generation_jobs[0];
        let shots = job.shots.as_ref().expect("the scene fixture has shots");
        assert_eq!(shots.len(), 3);
        assert_eq!(
            shots.iter().map(|shot| shot.start_seconds).collect::<Vec<_>>(),
            vec![0.0, 4.5, 9.0]
        );
        assert_eq!(job.duration_seconds, Some(12.0));
        // Per-shot settings go through the same tidy as the legacy per-job tags.
        assert_eq!(shots[0].settings.as_ref().unwrap()["shotSize"], vec!["wide"]);
        assert_eq!(shots[2].settings, None);
        // Its words are on the shots, and `prompt`/`creativeBrief` mirror them.
        assert!(shots[0].action.contains("@[ref:reference-woman]"));

        // An emptied group is dropped from a SHOT's settings exactly as it is
        // from a job's tags, and an emptied shot list collapses to no key.
        let mut emptied = scene_fixture();
        emptied.generation_jobs[0].shots.as_mut().unwrap()[1].settings =
            Some(BTreeMap::from([("mood".into(), Vec::new())]));
        let emptied = validate_and_normalize_config(emptied).unwrap();
        assert_eq!(emptied.generation_jobs[0].shots.as_ref().unwrap()[1].settings, None);

        let mut no_shots = scene_fixture();
        no_shots.generation_jobs[0].shots = Some(Vec::new());
        let no_shots = validate_and_normalize_config(no_shots).unwrap();
        assert_eq!(no_shots.generation_jobs[0].shots, None);
        let json = serde_json::to_string_pretty(&no_shots).unwrap();
        assert!(!json.contains("\"shots\""), "an empty shot list must not be written: {json}");
    }

    #[test]
    fn a_scene_may_have_no_words_left_in_its_mirror_but_a_pre_scene_job_may_not() {
        // The words live on the shots, so blanking the mirror is not a loss.
        let mut scene = scene_fixture();
        scene.generation_jobs[0].prompt = String::new();
        scene.generation_jobs[0].creative_brief = String::new();
        assert!(
            validate_and_normalize_config(scene).is_ok(),
            "a scene keeps its words on its shots, so the mirror may be blank"
        );

        // Without shots the mirror IS the only copy, and blanking it would lose
        // them. zod's superRefine on generationJobSchema refuses the same file.
        for blank in [0, 1] {
            let mut legacy = fixture();
            if blank == 0 {
                legacy.generation_jobs[0].prompt = String::new();
            } else {
                legacy.generation_jobs[0].creative_brief = String::new();
            }
            assert!(
                validate_and_normalize_config(legacy).is_err(),
                "a job with no shots must keep its words"
            );
        }
    }

    #[test]
    fn an_empty_scene_survives_the_round_trip_the_plus_button_creates() {
        /* The Generator's + adds a scene holding ONE shot with nothing written
           in it and no words in the mirror — PolStudio writes no line for
           anyone. Rust writes that file to disk before the frontend ever parses
           it back, so if this side accepted it and zod did not, the project
           would save and then fail to open. `createDraftGenerationJob("")`
           builds exactly this shape. */
        let mut empty = scene_fixture();
        let job = &mut empty.generation_jobs[0];
        job.prompt = String::new();
        job.creative_brief = String::new();
        job.reference_ids = Vec::new();
        job.shots = Some(vec![SceneShot {
            id: "scene-walk-shot-1".into(),
            start_seconds: 0.0,
            action: String::new(),
            settings: None,
        }]);

        let normalized = validate_and_normalize_config(empty)
            .expect("an empty scene is a scene waiting to be written, not an invalid one");
        let shots = normalized.generation_jobs[0]
            .shots
            .as_ref()
            .expect("one blank shot is still a shot and must not be dropped");
        assert_eq!(shots.len(), 1);
        assert_eq!(shots[0].action, "");
    }

    #[test]
    fn a_scene_is_bounded_to_fifteen_seconds_on_both_the_length_and_the_cuts() {
        // The frontend spells this `z.number().min(0).max(15)` on both fields.
        for seconds in [0.0, 7.5, 15.0] {
            let mut config = scene_fixture();
            config.generation_jobs[0].duration_seconds = Some(seconds);
            assert!(
                validate_and_normalize_config(config).is_ok(),
                "rejected a valid scene length of {seconds}s"
            );
        }
        for seconds in [-0.5, 15.1, f64::NAN, f64::INFINITY] {
            let mut config = scene_fixture();
            config.generation_jobs[0].duration_seconds = Some(seconds);
            assert!(
                validate_and_normalize_config(config).is_err(),
                "accepted a scene length of {seconds}s"
            );
            let mut cut = scene_fixture();
            cut.generation_jobs[0].shots.as_mut().unwrap()[1].start_seconds = seconds;
            assert!(
                validate_and_normalize_config(cut).is_err(),
                "accepted a cut at {seconds}s"
            );
        }
        // Two shots that share an id would make "the shot with id X" ambiguous
        // in every edit the UI performs. zod refuses the same file.
        let mut twins = scene_fixture();
        twins.generation_jobs[0].shots.as_mut().unwrap()[1].id = "scene-walk-shot-1".into();
        assert!(validate_and_normalize_config(twins).is_err());
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

/* ── Exit guard tests ─────────────────────────────────────────────────────── */
#[cfg(test)]
mod exit_guard_tests {
    use super::{CloseDecision, ExitGuard};
    use std::sync::atomic::Ordering;

    fn generating() -> ExitGuard {
        let guard = ExitGuard::default();
        guard.generation_active.store(true, Ordering::Release);
        guard
    }

    #[test]
    fn a_window_with_nothing_generating_closes_without_asking() {
        let guard = ExitGuard::default();
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
        // And it keeps closing: the guard must never latch on its own.
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }

    #[test]
    fn a_generation_holds_the_window_and_asks_once() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        // Clicking the close button again while the question is on screen must
        // still hold the window, but must not stack a second dialog.
        assert_eq!(guard.on_close_requested(), CloseDecision::Waiting);
    }

    #[test]
    fn keeping_generating_leaves_the_guard_ready_to_ask_again() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        guard.answered(false);
        // The run is still going, so the next attempt is a fresh question and
        // not a silent close.
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
    }

    #[test]
    fn confirming_lets_the_window_go() {
        let guard = generating();
        assert_eq!(guard.on_close_requested(), CloseDecision::Ask);
        guard.answered(true);
        // destroy() can itself raise a close request; if the flag were still
        // set the guard would ask again and the window would never shut.
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }

    #[test]
    fn a_run_that_finishes_first_takes_the_guard_back_out_of_the_way() {
        let guard = generating();
        guard.generation_active.store(false, Ordering::Release);
        assert_eq!(guard.on_close_requested(), CloseDecision::Close);
    }
}
