use crate::project::*;
use crate::project::paths::*;
use super::values::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
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
        // A Generator scene can be cut before it is rendered. Its generated
        // asset deliberately has no file until the render completes, while
        // every imported asset still has exactly one stored location.
        if asset.kind != "generated" || asset.relative_path.is_some() || asset.source_path.is_some()
        {
            check_one_location(
                &format!("Asset '{}'", asset.id),
                asset.relative_path.as_ref(),
                asset.source_path.as_ref(),
            )?;
        }
    }
    Ok(())
}
