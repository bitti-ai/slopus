use crate::project::*;
use crate::project::paths::*;
use std::collections::BTreeSet;
use super::values::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
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
        reference.icon_relative_path = reference.icon_relative_path.as_deref()
            .map(normalize_project_path).transpose()?;
        if reference.relative_path.is_some() && reference.source_path.is_some() {
            return Err(format!(
                "Reference '{}' cannot have both a project-relative path and an external source path.",
                reference.id
            ));
        }
        let mut image_ids = BTreeSet::new();
        let mut refmod_ids = BTreeSet::new();
        for refmod in &mut reference.refmods {
            let file = &mut refmod.file;
            if file.id.trim().is_empty() || file.name.trim().is_empty() || !refmod_ids.insert(file.id.clone())
                || !refmod.strength.is_finite() || !(0.0..=1.0).contains(&refmod.strength)
                || !(1..=10).contains(&refmod.copies) {
                return Err("Refmods need unique ids, names, strength 0 to 1 and copies 1 to 10.".into());
            }
            file.relative_path = file.relative_path.as_deref().map(normalize_project_path).transpose()?;
            file.source_path = file.source_path.as_deref().map(normalize_external_path).transpose()?;
            check_one_location("Refmod", file.relative_path.as_ref(), file.source_path.as_ref())?;
        }
        if let Some(video) = &reference.video {
            if reference.kind != "video" || !video.start_seconds.is_finite() || video.start_seconds < 0.0
                || !video.duration_seconds.is_finite() || !(2.0..=15.0).contains(&video.duration_seconds) {
                return Err(format!("Reference '{}' needs a nonnegative clip start and a duration of 2 to 15 seconds.", reference.id));
            }
        }
        for image in &mut reference.images {
            if image.id.trim().is_empty() || image.name.trim().is_empty() {
                return Err(format!(
                    "Reference '{}' has an image with an empty id or name.",
                    reference.id
                ));
            }
            if !image_ids.insert(image.id.as_str()) {
                return Err(format!(
                    "Reference '{}' has duplicate image id '{}'.",
                    reference.id, image.id
                ));
            }
            image.relative_path = image
                .relative_path
                .as_deref()
                .map(normalize_project_path)
                .transpose()?;
            image.source_path = image
                .source_path
                .as_deref()
                .map(normalize_external_path)
                .transpose()?;
            check_one_location(
                &format!("Reference image '{}'", image.id),
                image.relative_path.as_ref(),
                image.source_path.as_ref(),
            )?;
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
                "character" | "animal" | "product" | "location" | "style" | "audio"
            ) {
                return Err(format!("Unsupported reference intended use '{intent}'."));
            }
        }
    }
    Ok(())
}
