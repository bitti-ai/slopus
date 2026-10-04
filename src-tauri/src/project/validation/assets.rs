use super::values::*;
use crate::project::paths::*;
use crate::project::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    for asset in &mut config.assets {
        if let Some(segments) = &mut asset.scene_segments {
            if asset.kind != "generated" || segments.is_empty() {
                return Err("Scene ranges require a generated video.".into());
            }
            let mut end = 0u64;
            for segment in segments {
                if segment.scene_id.trim().is_empty() || segment.frame_count == 0 || u64::from(segment.start_frame) < end {
                    return Err("Invalid joined scene ranges.".into());
                }
                segment.latent_relative_path = normalize_project_path(&segment.latent_relative_path)?;
                end = u64::from(segment.start_frame) + u64::from(segment.frame_count);
                if asset.duration_ms.is_some_and(|duration| end as f64 > duration as f64 * 24.0 / 1000.0 + 1.0) {
                    return Err("Joined scene range exceeds its video.".into());
                }
            }
        }
        if asset.image_draft == Some(true) && (asset.kind != "image" || !asset.image_generation.as_ref().is_some_and(|snapshot| snapshot.scene.root_type.as_deref() != Some("image") || snapshot.scene.source_image.is_some())) {
            return Err("Image drafts require a scene snapshot and image roots require a source.".into());
        }
        if let Some(snapshot) = &mut asset.image_generation {
            snapshot.scene.validate()?;
            if let Some(template) = &snapshot.template { template.validate()?; }
            if asset.kind != "image"
                || !is_supported_resolution(&snapshot.resolution)
                || !is_supported_aspect_ratio(&snapshot.aspect_ratio)
                || snapshot.default_look.as_deref().is_some_and(|look| !is_shot_tag_id(look))
                || snapshot.generator_template_id.is_empty()
                || snapshot.used_seed.is_some_and(|seed| seed > 9_007_199_254_740_991)
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
