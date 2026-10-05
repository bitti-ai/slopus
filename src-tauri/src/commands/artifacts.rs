use crate::media::artifacts::*;
use crate::project::paths::*;
use crate::{app_paths, diagnostics, reference_icons, rendered};
use std::fs;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, State,
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

#[tauri::command]
pub(crate) fn write_reference_frame(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The reference frame must be sent as raw PNG bytes.".into());
    };
    let folder = super::binary::decoded_header(&request, "x-reference-folder")?;
    let id = super::binary::decoded_header(&request, "x-reference-frame")?;
    save_reference_frame(&folder, &id, bytes)
}

pub(crate) fn save_reference_frame(folder: &str, id: &str, bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The reference frame is not a PNG image.".into());
    }
    let root = ProjectRoot::open(folder)?;
    let stem = generated_file_stem(id)?;
    let directory = root.directory("references/frames")?;
    crate::storage::atomic::write_atomically(&directory.join(format!("{stem}.png")), bytes)?;
    Ok(format!("references/frames/{stem}.png"))
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
    format: Option<String>,
) -> Result<GeneratedImageFile, String> {
    let summary =
        rendered::summary(&job_id).ok_or("The generated image is no longer in memory.")?;
    if summary.frame_count != 1 {
        return Err("Expected a single still image.".into());
    }
    let rgba = rendered::frame(&job_id, 0)?.ok_or("The generated image has no pixels.")?;
    if format.as_deref() == Some("png") {
        write_generated_png_frame(&folder_path, &job_id, summary.width, summary.height, &rgba)
    } else if format.is_none() || format.as_deref() == Some("jpg") {
        write_generated_image_frame(&folder_path, &job_id, summary.width, summary.height, &rgba)
    } else { Err("Unsupported generated image format.".into()) }
}

pub(crate) fn write_generated_png_frame(folder: &str, id: &str, width: u32, height: u32, rgba: &[u8]) -> Result<GeneratedImageFile, String> {
    use image::ImageEncoder;
    if width == 0 || height == 0 || width > 8192 || height > 8192 || rgba.len() != width as usize * height as usize * 4 {
        return Err("Invalid PNG image dimensions or pixels.".into());
    }
    let root = ProjectRoot::open(folder)?;
    let stem = generated_file_stem(id)?;
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(rgba, width, height, image::ExtendedColorType::Rgba8).map_err(|error| error.to_string())?;
    crate::storage::atomic::write_atomically(&root.directory("media/generated")?.join(format!("{stem}.png")), &bytes)?;
    Ok(GeneratedImageFile { relative_path: format!("media/generated/{stem}.png"), width: width as u16, height: height as u16 })
}

#[tauri::command]
pub(crate) async fn open_image_source(app: AppHandle, folder_path: String) -> Result<Option<crate::project::image::ImageSource>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let Some(selected) = app.dialog().file().set_title("Open image to edit").add_filter("Images", &["png", "jpg", "jpeg"]).blocking_pick_file() else { return Ok(None); };
        let path = selected.into_path().map_err(|_| "Choose a local image file.")?;
        let (width, height) = image::image_dimensions(&path).map_err(|error| format!("Could not read image: {error}"))?;
        if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) { return Err("Image editing supports up to 8192 pixels per axis.".into()); }
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        let extension = match image::guess_format(&bytes).map_err(|error| error.to_string())? {
            image::ImageFormat::Png => "png", image::ImageFormat::Jpeg => "jpg", _ => return Err("Choose a PNG or JPEG image.".into()),
        };
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|error| error.to_string())?;
        let id = random.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let root = ProjectRoot::open(&folder_path)?;
        let filename = format!("image-source-{id}.{extension}");
        crate::storage::atomic::write_atomically(&root.directory("media/imported")?.join(&filename), &bytes)?;
        Ok(Some(crate::project::image::ImageSource { relative_path: format!("media/imported/{filename}"), name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(), width, height }))
    }).await.map_err(|error| error.to_string())?
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

/// How the Export tab asks for the image: its file format, its pixel size
/// (the generated size when absent) and, for JPEG, the quality 1–100.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImageExportOptions {
    pub format: Option<ImageExportFormat>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub quality: Option<u8>,
    pub upscale: Option<crate::slopfab::upscale::UpscaleConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ImageExportFormat {
    Jpg,
    Png,
}

/// The quality generated JPEGs are written at: exporting at this or above,
/// unresized, cannot gain anything over the file itself, so it is copied.
const GENERATED_JPEG_QUALITY: u8 = 95;

#[tauri::command]
pub(crate) async fn choose_image_export_destination(
    app: AppHandle,
    options: Option<ImageExportOptions>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let options = options.unwrap_or_default();
        let dialog = app.dialog().file().set_title("Export image");
        let dialog = match options.format {
            Some(ImageExportFormat::Jpg) => dialog.add_filter("JPEG image", &["jpg", "jpeg"]).set_file_name("image.jpg"),
            Some(ImageExportFormat::Png) => dialog.add_filter("PNG image", &["png"]).set_file_name("image.png"),
            None => dialog
                .add_filter("JPEG image", &["jpg", "jpeg"])
                .add_filter("PNG image", &["png"])
                .set_file_name("image"),
        };
        let Some(destination) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let destination = destination
            .into_path()
            .map_err(|_| "Choose a local image destination.")?;
        // The chosen format wins over a mistyped or missing extension.
        let destination = match options.format {
            Some(ImageExportFormat::Png) if !has_extension(&destination, &["png"]) => destination.with_extension("png"),
            Some(ImageExportFormat::Jpg) if !has_extension(&destination, &["jpg", "jpeg"]) => destination.with_extension("jpg"),
            _ => destination,
        };
        IMAGE_DESTINATIONS.lock().map_err(|e| e.to_string())?.insert(destination.clone());
        Ok(Some(destination.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

static IMAGE_DESTINATIONS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>> = std::sync::LazyLock::new(Default::default);
static IMAGE_EXPORTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>> = std::sync::LazyLock::new(Default::default);

#[tauri::command]
pub(crate) async fn export_generated_image(app: AppHandle, workers: State<'_, crate::worker::Workers>,
    job_id: String, folder_path: String, relative_path: String, destination: String, options: Option<ImageExportOptions>) -> Result<u64, String> {
    let destination = std::path::PathBuf::from(destination);
    if !IMAGE_DESTINATIONS.lock().map_err(|e| e.to_string())?.contains(&destination) {
        return Err("Choose the image destination with the save dialog first.".into());
    }
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut jobs = IMAGE_EXPORTS.lock().map_err(|e| e.to_string())?;
        if jobs.contains_key(&job_id) { return Err("This image export is already running.".into()); }
        jobs.insert(job_id.clone(), stop.clone());
    }
    let id = job_id.clone();
    let workers = workers.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = ProjectRoot::open(&folder_path)?;
        let source = root.existing(&relative_path)?;
        let progress = |phase: &str, detail: &str| {
            let _ = app.emit("export-progress", serde_json::json!({ "jobId": id, "phase": phase,
                "framesDone": if phase == "writing" { 1 } else { 0 }, "frameCount": 1, "detail": detail }));
        };
        export_image_file_running(&source, &destination, options.unwrap_or_default(), &workers, &id, &stop, &progress)?;
        fs::metadata(destination).map(|info| info.len()).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string()).and_then(|result| result);
    IMAGE_EXPORTS.lock().map_err(|e| e.to_string())?.remove(&job_id);
    result
}

#[tauri::command]
pub(crate) fn cancel_image_export(job_id: String) -> Result<(), String> {
    if let Some(stop) = IMAGE_EXPORTS.lock().map_err(|e| e.to_string())?.get(&job_id) {
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

fn has_extension(path: &std::path::Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| extensions.iter().any(|candidate| value.eq_ignore_ascii_case(candidate)))
}

/// Export at the generated size and default quality; see export_image_file_with.
/// The app always passes options; this is the tests' shorthand.
#[cfg(test)]
pub(crate) fn export_image_file(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), String> {
    export_image_file_with(source, destination, ImageExportOptions::default())
}

/// Copy the file untouched when nothing would change (same format, same size,
/// and for JPEG no quality below the one it was written at); otherwise decode,
/// resize with Lanczos3 and encode. File extensions always match the bytes.
#[cfg(test)]
pub(crate) fn export_image_file_with(
    source: &std::path::Path,
    destination: &std::path::Path,
    options: ImageExportOptions,
) -> Result<(), String> {
    export_image_file_running(source, destination, options, &crate::worker::Workers::default(), "image-test",
        &std::sync::atomic::AtomicBool::new(false), &|_, _| {})
}

fn export_image_file_running(source: &std::path::Path, destination: &std::path::Path, options: ImageExportOptions,
    workers: &crate::worker::Workers, id: &str, stop: &std::sync::atomic::AtomicBool, progress: &dyn Fn(&str, &str)) -> Result<(), String> {
    if stop.load(std::sync::atomic::Ordering::Relaxed) { return Err("Export cancelled.".into()); }
    progress("preparing", "Reading image…");
    let destination = if destination.extension().is_none() {
        destination.with_extension("jpg")
    } else {
        destination.to_path_buf()
    };
    let extension = destination
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png") {
        return Err("Choose a .jpg, .jpeg or .png filename for the exported image.".into());
    }
    let quality = options.quality.unwrap_or(GENERATED_JPEG_QUALITY).clamp(1, 100);
    let bytes = fs::read(source).map_err(|error| format!("Could not read image: {error}"))?;
    let source_format = image::guess_format(&bytes).map_err(|error| format!("Could not read image format: {error}"))?;
    let target_format = if extension == "png" { image::ImageFormat::Png } else { image::ImageFormat::Jpeg };
    let (source_width, source_height) = image::ImageReader::with_format(std::io::Cursor::new(&bytes), source_format)
        .into_dimensions()
        .map_err(|error| format!("Could not read image size: {error}"))?;
    let width = options.width.unwrap_or(source_width);
    let height = options.height.unwrap_or(source_height);
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 {
        return Err("Choose an export size between 1 and 16384 pixels.".into());
    }
    let resized = (width, height) != (source_width, source_height);
    let unchanged = source_format == target_format
        && options.upscale.is_none()
        && !resized
        && (target_format == image::ImageFormat::Png || quality >= GENERATED_JPEG_QUALITY);
    let bytes = if unchanged {
        bytes
    } else {
        let mut image = image::load_from_memory_with_format(&bytes, source_format)
            .map_err(|error| format!("Could not decode image: {error}"))?;
        if let Some(config) = &options.upscale {
            let original = image.to_rgba8();
            let mut input = Some(original.clone().into_raw());
            let mut output = None;
            progress("rendering", if config.method == crate::slopfab::upscale::UpscaleMethod::Seedvr2 { "Upscaling with SeedVR2 on worker…" } else { "Upscaling with Real-ESRGAN…" });
            crate::upscale::run(workers, id, config, (source_width, source_height), (width, height),
                1,
                stop, &mut || Ok(input.take()),
                &mut |bytes| { output = Some(bytes); Ok(()) })?;
            let mut restored = image::RgbaImage::from_raw(width, height, output.ok_or("Upscaler returned no image.")?)
                .ok_or("Upscaler returned invalid image dimensions.")?;
            let alpha = image::imageops::resize(&original, width, height, image::imageops::FilterType::Lanczos3);
            for (pixel, source) in restored.pixels_mut().zip(alpha.pixels()) { pixel[3] = source[3]; }
            image = image::DynamicImage::ImageRgba8(restored);
        } else if resized {
            image = image.resize_exact(width, height, image::imageops::FilterType::Lanczos3);
        }
        let mut encoded = std::io::Cursor::new(Vec::new());
        if target_format == image::ImageFormat::Jpeg {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality).encode_image(&image.to_rgb8()).map_err(|error| error.to_string())?;
        } else {
            image.write_to(&mut encoded, target_format).map_err(|error| format!("Could not encode PNG: {error}"))?;
        }
        encoded.into_inner()
    };
    if stop.load(std::sync::atomic::Ordering::Relaxed) { return Err("Export cancelled.".into()); }
    progress("writing", "Writing image…");
    crate::storage::atomic::write_atomically(&destination, &bytes)
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
// Off the main thread: a worker render fetches its frames over the network.
#[tauri::command(async)]
pub(crate) fn generated_frame(job_id: String, index: u32) -> Result<tauri::ipc::Response, String> {
    rendered::frame(&job_id, index)?
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| {
            format!("Frame {index} of {job_id} is not in memory. The render was released, dropped to make room, or never finished.")
        })
}

/// The render's soundtrack, interleaved little-endian f32 — one read, because
/// even fifteen seconds of stereo is a couple of megabytes.
// Off the main thread: a worker render fetches its frames over the network.
#[tauri::command(async)]
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
