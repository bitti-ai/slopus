use super::values::*;
use crate::project::paths::*;
use crate::project::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    for asset in &mut config.assets {
        if asset.image_draft == Some(true) && (asset.kind != "image" || !asset.image_generation.as_ref().is_some_and(|snapshot| snapshot.scene.root_type.as_deref() != Some("image") || snapshot.scene.source_image.is_some())) {
            return Err("Image drafts require a scene snapshot and image roots require a source.".into());
        }
        if let Some(snapshot) = &mut asset.image_generation {
            snapshot.scene.validate()?;
            if asset.kind != "image"
                || !is_supported_resolution(&snapshot.resolution)
                || !is_supported_aspect_ratio(&snapshot.aspect_ratio)
                || snapshot.default_look.as_deref().is_some_and(|look| !is_shot_tag_id(look))
                || snapshot.generator_template_id.is_empty()
                || snapshot.references.len() > 100
            {
                return Err("Invalid image generation snapshot settings.".into());
            }
            super::references::validate_references(&mut snapshot.references)?;
            let ids = unique_ids(snapshot.references.iter().map(|reference| reference.id.as_str()), "image snapshot reference")?;
            if snapshot.scene.reference_ids.iter().chain(snapshot.scene.nodes.iter().flat_map(|node| node.reference_ids.iter().flatten())).any(|id| !ids.contains(id.as_str())) {
                return Err("Image generation snapshot has a missing reference.".into());
            }
        }
        if asset.parent_asset_id.as_ref().is_some_and(|parent| asset.kind != "image" || parent.trim().is_empty() || *parent == asset.id) {
            return Err(format!("Asset '{}' can only name another image as its parent.", asset.id));
        }
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
        // Generated scenes and blank image drafts have no file until generation
        // completes. Imported assets still have exactly one stored location.
        if (asset.kind != "generated" && asset.image_draft != Some(true)) || asset.relative_path.is_some() || asset.source_path.is_some()
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
