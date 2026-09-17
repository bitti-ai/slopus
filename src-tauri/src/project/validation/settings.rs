use crate::project::*;
use crate::project::paths::*;
use super::values::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
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
    if config.brief.target_duration_seconds > 600 {
        return Err(format!(
            "Target duration must be between 0 and 600 seconds, received {}.",
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
    Ok(())
}
