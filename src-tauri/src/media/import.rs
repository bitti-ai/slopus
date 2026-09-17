use crate::project::paths::*;
use std::{fs, path::{Path, PathBuf}};
use serde::Serialize;
use super::access::picked_external_source_path;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedReferenceImage {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) mime_type: String,
}

/// One file the user added to a project. An IMAGE is copied into the project's
/// `media/` folder and comes back with `relative_path`; VIDEO and AUDIO are
/// left exactly where they are and come back with an absolute `source_path`,
/// because copying a rush or a stem doubles gigabytes on disk for no benefit.
/// Exactly one of the two is ever set.
///
/// Deliberately carries no duration or dimensions: Slopus has no decoder
/// yet, and a made-up number here would be indistinguishable from a measured
/// one everywhere downstream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedMediaFile {
    pub(crate) kind: &'static str,
    pub(crate) name: String,
    pub(crate) relative_path: Option<String>,
    pub(crate) source_path: Option<String>,
    pub(crate) mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingReferenceImage {
    pub(crate) source_path: String,
    pub(crate) name: String,
}

pub(crate) fn validate_reference_image(source: &Path) -> Result<(String, &'static str), String> {
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

pub(crate) fn copy_reference_image(
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
/// One reference the user added: an image copied into `references/`, or a
/// video/audio file left where it is and pointed at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedReference {
    pub(crate) kind: &'static str,
    pub(crate) name: String,
    pub(crate) relative_path: Option<String>,
    pub(crate) source_path: Option<String>,
}
/// Adds one file to a project as a reference, following the same rule the media
/// panel does: pictures are small and get copied so the folder stays portable;
/// video and audio are not copied at any size.
pub(crate) fn import_reference_file(
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

/// Extensions Slopus accepts, and what each one is. Anything not listed is
/// refused rather than imported as an unknown blob.
pub(crate) fn media_kind_and_mime(extension: &str) -> Option<(&'static str, &'static str)> {
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

pub(crate) const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mkv", "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "png",
    "jpg", "jpeg", "webp", "gif",
];

/// Adds one file to the project. Video and audio are NEVER copied: a folder of
/// rushes is tens of gigabytes, and duplicating it to make the project folder
/// "portable" costs the user that much disk to gain a copy they did not ask
/// for. The project records where the file already lives instead. Images are
/// small and stay copied, so a project's own artwork travels with it.
pub(crate) fn import_media_file(source: &Path, project_folder: &Path) -> Result<ImportedMediaFile, String> {
    if !source.is_file() {
        return Err(format!("{} does not exist.", source.to_string_lossy()));
    }
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "The selected file needs a file extension.".to_string())?;
    let (kind, mime_type) = media_kind_and_mime(&extension)
        .ok_or_else(|| format!("Slopus cannot import .{extension} files yet."))?;
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
pub(crate) fn reference_attachment_kind(path: &Path) -> Result<&'static str, String> {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" | "jpg" | "jpeg" | "webp" => Ok("image"),
        "mp4" | "m4v" | "mov" => Ok("video"),
        "safetensors" => Ok("refmod"),
        _ => Err("Choose an image, MP4/MOV video, or refmod safetensors file.".into()),
    }
}

pub(crate) fn import_reference_attachments(root: &Path, paths: &[PathBuf]) -> Result<Vec<ImportedReference>, String> {
    let kinds = paths.iter().map(|path| {
        if !path.is_file() { return Err("The selected reference file does not exist.".into()); }
        reference_attachment_kind(path)
    }).collect::<Result<Vec<_>, String>>()?;
    if kinds.iter().filter(|kind| **kind == "video").count() > 1 {
        return Err("Add one video per reference. Use another reference for additional videos.".into());
    }
    paths.iter().zip(kinds).map(|(path, kind)| {
        if kind == "image" { return import_reference_file(path, root); }
        Ok(ImportedReference {
            kind,
            name: path.file_name().and_then(|name| name.to_str()).unwrap_or("Reference").into(),
            relative_path: None,
            source_path: Some(picked_external_source_path(path, root)?),
        })
    }).collect()
}
