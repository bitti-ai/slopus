use crate::media::artifacts::*;
use crate::project::paths::*;
use crate::{app_paths, diagnostics, reference_icons, rendered};
use std::fs;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle,
};
pub(crate) const GENERATED_FOLDER_HEADER: &str = "x-generated-folder";
pub(crate) const GENERATED_JOB_HEADER: &str = "x-generated-job";
pub(crate) const THUMBNAIL_FOLDER_HEADER: &str = "x-thumbnail-folder";
pub(crate) const THUMBNAIL_JOB_HEADER: &str = "x-thumbnail-job";
pub(crate) const THUMBNAIL_TIME_HEADER: &str = "x-thumbnail-time";
/// Writes the webview's encoded MP4 into the project folder.
///
/// The bytes arrive as a raw IPC body for the same reason an export's do: a
/// 30 MB file serialised as a JSON array of numbers is hundreds of megabytes of
/// text. That leaves nowhere for the arguments, so the project folder and the
/// scene id ride in headers, percent-encoded because a header is ASCII and a
/// Windows path is not.
#[tauri::command]
pub(crate) fn write_generated_video(request: Request<'_>) -> Result<GeneratedVideoFile, String> {
    let mut logged_job_id: Option<String> = None;
    let result = (|| {
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err("The rendered scene was sent as JSON instead of raw bytes.".to_string());
        };
        if bytes.is_empty() {
            return Err("The encoder produced no bytes, so nothing was written.".to_string());
        }
        let header = |name: &str| super::binary::decoded_header(&request, name);
        let folder = header(GENERATED_FOLDER_HEADER)?;
        let job_id = header(GENERATED_JOB_HEADER)?;
        logged_job_id = Some(job_id.clone());
        diagnostics::info(
            "generated-video",
            "write.started",
            "Writing encoded scene to the project.",
            serde_json::json!({
                "jobId": job_id, "bytes": bytes.len(),
            }),
        );
        let (destination, relative_path) = generated_video_destination(&folder, &job_id)?;
        crate::storage::atomic::write_atomically(&destination, bytes)?;
        Ok(GeneratedVideoFile {
            relative_path,
            bytes: bytes.len() as u64,
        })
    })();
    match &result {
        Ok(file) => diagnostics::info(
            "generated-video",
            "write.completed",
            "Encoded scene was written.",
            serde_json::json!({
                "jobId": logged_job_id, "bytes": file.bytes, "relativePath": file.relative_path,
            }),
        ),
        Err(error) => diagnostics::error(
            "generated-video",
            "write.failed",
            error,
            serde_json::json!({ "jobId": logged_job_id }),
        ),
    }
    result
}

#[tauri::command]
pub(crate) fn write_scene_last_frame(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The last frame must be sent as raw PNG bytes.".into());
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The last frame is not a PNG image.".into());
    }
    let header = |name: &str| super::binary::decoded_header(&request, name);
    let root = ProjectRoot::open(&header(GENERATED_FOLDER_HEADER)?)?;
    let stem = generated_file_stem(&header(GENERATED_JOB_HEADER)?)?;
    let directory = root.directory("cache/scene-last")?;
    crate::storage::atomic::write_atomically(&directory.join(format!("{stem}.png")), bytes)
}
/// Writes one small, derived timeline still. Its location is deterministic,
/// so it never needs to enter slopus.json and can be rebuilt from the MP4.
#[tauri::command]
pub(crate) fn write_timeline_thumbnail(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The timeline thumbnail was sent as JSON instead of raw bytes.".into());
    };
    if bytes.is_empty() {
        return Err("The timeline thumbnail contains no bytes.".into());
    }
    let header = |name: &str| super::binary::decoded_header(&request, name);
    let root = ProjectRoot::open(&header(THUMBNAIL_FOLDER_HEADER)?)?;
    let stem = generated_file_stem(&header(THUMBNAIL_JOB_HEADER)?)?;
    let time_ms = header(THUMBNAIL_TIME_HEADER)?.parse::<u32>().map_err(|_| {
        "The timeline thumbnail time is not a non-negative millisecond value.".to_string()
    })?;
    let directory = root.directory(&format!("thumbnails/timeline/{stem}"))?;
    crate::storage::atomic::write_atomically(&directory.join(format!("{time_ms:08}.jpg")), bytes)
}

/// Removes only one scene's derived stills. The scene id is validated before
/// it becomes a path component, keeping recursive deletion pinned below the
/// project's timeline-thumbnail directory.
#[tauri::command]
pub(crate) fn purge_timeline_thumbnails(folder_path: String, job_id: String) -> Result<(), String> {
    let root = ProjectRoot::open(&folder_path)?;
    let stem = generated_file_stem(&job_id)?;
    let relative = format!("thumbnails/timeline/{stem}");
    let directory = root.path().join(&relative);
    if directory.exists() {
        let directory = root.existing(&relative)?;
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("Could not remove {}: {error}", display_path(&directory)))?;
    }
    Ok(())
}

/// What is waiting to be encoded for this scene, or None when nothing is. The
/// webview asks this first: it decides what to encode from what Rust actually
/// holds rather than from the event that told it to look.
#[tauri::command]
pub(crate) fn generated_summary(job_id: String) -> Option<rendered::RenderedSummary> {
    rendered::summary(&job_id)
}

/// Save only a true 256x256 still-image result, directly from the DLL's frame
/// buffer. Icon artwork is stored separately from conditioning attachments.
#[tauri::command]
pub(crate) fn save_reference_icon(folder_path: String, job_id: String) -> Result<String, String> {
    write_reference_icon_frame(&folder_path, &job_id, &reference_icon_pixels(&job_id)?)
}

/// Preserve the full-resolution still; reference icons intentionally downscale.
#[tauri::command]
pub(crate) fn save_generated_image(
    folder_path: String,
    job_id: String,
) -> Result<GeneratedImageFile, String> {
    let summary =
        rendered::summary(&job_id).ok_or("The generated image is no longer in memory.")?;
    if summary.frame_count != 1 {
        return Err("Expected a single still image.".into());
    }
    let rgba = rendered::frame(&job_id, 0)?.ok_or("The generated image has no pixels.")?;
    write_generated_image_frame(&folder_path, &job_id, summary.width, summary.height, &rgba)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageFile {
    pub relative_path: String,
    pub width: u16,
    pub height: u16,
}

pub(crate) fn write_generated_image_frame(
    folder_path: &str,
    job_id: &str,
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<GeneratedImageFile, String> {
    let root = ProjectRoot::open(folder_path)?;
    let stem = generated_file_stem(job_id)?;
    let width = u16::try_from(width).map_err(|_| "Image width exceeds JPEG limits.")?;
    let height = u16::try_from(height).map_err(|_| "Image height exceeds JPEG limits.")?;
    if width == 0 || height == 0 || rgba.len() != width as usize * height as usize * 4 {
        return Err("Image dimensions do not match the RGBA pixels.".into());
    }
    let mut bytes = Vec::new();
    jpeg_encoder::Encoder::new(&mut bytes, 95)
        .encode(rgba, width, height, jpeg_encoder::ColorType::Rgba)
        .map_err(|error| format!("Could not encode image: {error}"))?;
    let directory = root.directory("media/generated")?;
    let relative_path = format!("media/generated/{stem}.jpg");
    crate::storage::atomic::write_atomically(&directory.join(format!("{stem}.jpg")), &bytes)?;
    Ok(GeneratedImageFile {
        relative_path,
        width,
        height,
    })
}

#[tauri::command]
pub(crate) async fn export_generated_image(
    app: AppHandle,
    folder_path: String,
    relative_path: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let root = ProjectRoot::open(&folder_path)?;
        let source = root.existing(&relative_path)?;
        if !relative_path.starts_with("media/generated/")
            || source.extension().and_then(|s| s.to_str()) != Some("jpg")
        {
            return Err("Choose a generated JPEG image to export.".into());
        }
        let Some(destination) = app
            .dialog()
            .file()
            .set_title("Export image")
            .add_filter("JPEG image", &["jpg", "jpeg"])
            .set_file_name("image.jpg")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let destination = destination
            .into_path()
            .map_err(|_| "Choose a local image destination.")?;
        let bytes = fs::read(source).map_err(|error| format!("Could not read image: {error}"))?;
        crate::storage::atomic::write_atomically(&destination, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn list_builtin_reference_icons(app: AppHandle) -> Result<Vec<String>, String> {
    reference_icons::list_builtin(&app_paths::data_directory(&app))
}

#[tauri::command]
pub(crate) fn read_builtin_reference_icon(
    app: AppHandle,
    preset_id: String,
) -> Result<tauri::ipc::Response, String> {
    reference_icons::read_builtin(&app_paths::data_directory(&app), &preset_id)
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub(crate) fn save_builtin_reference_icon(
    app: AppHandle,
    preset_id: String,
    job_id: String,
) -> Result<(), String> {
    reference_icons::save_builtin(
        &app_paths::data_directory(&app),
        &preset_id,
        &reference_icon_pixels(&job_id)?,
    )
}
/// One frame of a finished render, as RGBA the webview can build a `VideoFrame`
/// from. A frame at a time because a whole render is hundreds of megabytes and
/// the encoder only ever wants the next one.
#[tauri::command]
pub(crate) fn generated_frame(job_id: String, index: u32) -> Result<tauri::ipc::Response, String> {
    rendered::frame(&job_id, index)?
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| {
            format!("Frame {index} of {job_id} is not in memory. The render was released, dropped to make room, or never finished.")
        })
}

/// The render's soundtrack, interleaved little-endian f32 — one read, because
/// even fifteen seconds of stereo is a couple of megabytes.
#[tauri::command]
pub(crate) fn generated_audio(job_id: String) -> Result<tauri::ipc::Response, String> {
    rendered::audio(&job_id)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| format!("The audio of {job_id} is not in memory."))
}

/// Hands the memory back. Called when the file has been written AND when the
/// webview has given up: a render nobody can encode is still hundreds of
/// megabytes nobody should be holding.
#[tauri::command]
pub(crate) fn release_generated_frames(job_id: String) -> bool {
    rendered::release(&job_id)
}
