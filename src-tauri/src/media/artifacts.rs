use crate::project::paths::*;
use crate::storage::atomic::write_atomically;
use crate::{reference_icons, rendered, slopfab};
use serde::Serialize;
use std::path::PathBuf;
/// Where a rendered scene lands, relative to the project root. Created by
/// `create_project` along with the rest of the folder layout.
pub(crate) const GENERATED_DIRECTORY: &str = "media/generated";

/// A scene id, as a file name.
///
/// The webview names the job, so this is caller-controlled text about to become
/// a path — the exact shape of a traversal. Rather than sanitising it, the id
/// is REFUSED unless it is already only letters, digits, dash and underscore,
/// which is what every id Slopus generates looks like. There is nothing to
/// strip and nothing to get wrong: no dots (so no `..` and no second
/// extension), no separators, no length worth arguing about.
pub(crate) fn generated_file_stem(job_id: &str) -> Result<String, String> {
    let trimmed = job_id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("A scene id must be between 1 and 64 characters.".into());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!(
            "'{job_id}' is not a scene id: only letters, digits, dashes and underscores name a rendered file."
        ));
    }
    Ok(trimmed.to_string())
}

/// The single path a generated video may be written to, and what the project
/// will record. Nothing about it comes from the caller except the scene id,
/// which [`generated_file_stem`] has already refused unless it is inert — so
/// unlike an export, there is no destination to authorise, because the webview
/// never names one.
pub(crate) fn generated_video_destination(
    folder_path: &str,
    job_id: &str,
) -> Result<(PathBuf, String), String> {
    let root = ProjectRoot::open(folder_path)?;
    let stem = generated_file_stem(job_id)?;
    let directory = root.directory(GENERATED_DIRECTORY)?;
    Ok((
        directory.join(format!("{stem}.mp4")),
        format!("{GENERATED_DIRECTORY}/{stem}.mp4"),
    ))
}

/// What was written, in the project's own terms: the path that goes into
/// `slopus.json` and the size of the file that demonstrably exists.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedVideoFile {
    pub(crate) relative_path: String,
    pub(crate) bytes: u64,
}
pub(crate) fn generated_latent_destination(
    folder_path: &str,
    job_id: &str,
) -> Result<PathBuf, String> {
    let root = ProjectRoot::open(folder_path)?;
    let stem = generated_file_stem(job_id)?;
    let directory = root.directory("latents")?;
    let destination = directory.join(format!("{stem}.safetensors"));
    if destination.exists() {
        return Err(
            "Latents already exist for this generation. Start a new generation to preserve them."
                .into(),
        );
    }
    Ok(destination)
}

pub(crate) fn prepare_continuation_path(
    request: &mut slopfab::GenerationRequest,
    folder_path: Option<&str>,
) -> Result<(), String> {
    request.continuation_path = None;
    if let Some(relative) = &request.continuation_relative_path {
        let root = ProjectRoot::open(
            folder_path.ok_or("A project folder is required to continue a scene.")?,
        )?;
        let path = root.existing(relative)?;
        if !path.is_file() {
            return Err("Previous scene latents must be a file inside this project.".into());
        }
        request.continuation_path = Some(path);
    }
    Ok(())
}

pub(crate) fn reference_icon_pixels(job_id: &str) -> Result<Vec<u8>, String> {
    let summary = rendered::summary(&job_id).ok_or("The reference icon is no longer available.")?;
    if summary.width != reference_icons::RENDER_SIZE
        || summary.height != reference_icons::RENDER_SIZE
        || summary.frame_count != 1
    {
        return Err("A reference icon must be a single 768x768 frame.".into());
    }
    rendered::frame(job_id, 0)?.ok_or_else(|| "The reference icon has no image.".into())
}
pub(crate) fn write_reference_icon_frame(
    folder_path: &str,
    job_id: &str,
    rgba: &[u8],
) -> Result<String, String> {
    let bytes = reference_icons::encode_jpeg(rgba)?;
    let root = ProjectRoot::open(folder_path)?;
    let stem = generated_file_stem(job_id)?;
    let directory = root.directory("references/icons")?;
    write_atomically(&directory.join(format!("{stem}.jpg")), &bytes)?;
    Ok(format!("references/icons/{stem}.jpg"))
}
