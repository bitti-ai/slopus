use crate::media::artifacts::*;
use crate::project::{validation::validate_and_normalize_config, *};
use crate::{diagnostics, slopfab, worker::Workers};
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::DialogExt;
/// Generation commands run on the native queue here, or on the LAN worker
/// selected in Settings → Workers. The webview cannot tell the difference.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn create_reference_video(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    duration_seconds: f64,
    config: ProjectConfig,
) -> Result<String, String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || {
        let config = validate_and_normalize_config(config)?;
        match workers.active()? {
            Some(worker) => worker.post(
                "/v1/reference-videos",
                &serde_json::json!({ "durationSeconds": duration_seconds }),
            ),
            None => runtime
                .references
                .create_reference_video(duration_seconds, &config.provider_settings),
        }
    })
    .await
}

pub(crate) fn reference_video_header<'a>(
    request: &'a tauri::ipc::Request<'_>,
    name: &str,
) -> Result<&'a str, String> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("Missing or invalid {name} header."))
}

#[tauri::command]
pub(crate) async fn append_reference_video(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Reference frames require a binary body.".into());
    };
    let id = reference_video_header(&request, "x-reference-id")?.to_string();
    let width: i32 = reference_video_header(&request, "x-reference-width")?
        .parse()
        .map_err(|_| "Invalid frame width.")?;
    let height: i32 = reference_video_header(&request, "x-reference-height")?
        .parse()
        .map_err(|_| "Invalid frame height.")?;
    let timestamp: f64 = reference_video_header(&request, "x-reference-time")?
        .parse()
        .map_err(|_| "Invalid frame timestamp.")?;
    let bytes = bytes.clone();
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || match workers.active()? {
        Some(worker) => worker
            .post_bytes::<bool>(
                &format!("/v1/reference-videos/{id}/frames"),
                &[
                    ("x-reference-width", width.to_string()),
                    ("x-reference-height", height.to_string()),
                    ("x-reference-time", timestamp.to_string()),
                ],
                bytes,
            )
            .map(|_| ()),
        None => runtime
            .references
            .append_reference_video(&id, &bytes, width, height, timestamp),
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_reference_video_audio(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Reference audio requires a binary body.".into());
    };
    let id = reference_video_header(&request, "x-reference-id")?.to_string();
    let channels: i32 = reference_video_header(&request, "x-reference-channels")?
        .parse()
        .map_err(|_| "Invalid audio channels.")?;
    let rate: i32 = reference_video_header(&request, "x-reference-rate")?
        .parse()
        .map_err(|_| "Invalid sample rate.")?;
    let bytes = bytes.clone();
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || match workers.active()? {
        Some(worker) => worker
            .post_bytes::<bool>(
                &format!("/v1/reference-videos/{id}/audio"),
                &[
                    ("x-reference-channels", channels.to_string()),
                    ("x-reference-rate", rate.to_string()),
                ],
                bytes,
            )
            .map(|_| ()),
        None => runtime
            .references
            .set_reference_video_audio(&id, &bytes, channels, rate),
    })
    .await
}

#[tauri::command]
pub(crate) async fn release_reference_videos(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    ids: Vec<String>,
) -> Result<(), String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || match workers.active()? {
        Some(worker) => worker
            .post::<bool>("/v1/reference-videos/release", &ids)
            .map(|_| ()),
        None => runtime.references.release_reference_videos(&ids),
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_reference_audio(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Reference audio requires a binary body.".into());
    };
    let channels: i32 = reference_video_header(&request, "x-reference-channels")?
        .parse()
        .map_err(|_| "Invalid audio channels.")?;
    let rate: i32 = reference_video_header(&request, "x-reference-rate")?
        .parse()
        .map_err(|_| "Invalid sample rate.")?;
    let bytes = bytes.clone();
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || match workers.active()? {
        Some(worker) => worker.post_bytes(
            "/v1/reference-audios",
            &[
                ("x-reference-channels", channels.to_string()),
                ("x-reference-rate", rate.to_string()),
            ],
            bytes,
        ),
        None => runtime
            .references
            .create_reference_audio(&bytes, channels, rate),
    })
    .await
}

#[tauri::command]
pub(crate) async fn release_reference_audios(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    ids: Vec<String>,
) -> Result<(), String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || match workers.active()? {
        Some(worker) => worker
            .post::<bool>("/v1/reference-audios/release", &ids)
            .map(|_| ()),
        None => runtime.references.release_reference_audios(&ids),
    })
    .await
}

#[tauri::command]
pub(crate) async fn resolve_slopfab_plan(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    mut request: slopfab::GenerationRequest,
    config: ProjectConfig,
    folder_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || {
        prepare_continuation_path(&mut request, folder_path.as_deref())?;
        prepare_image_edit_path(&mut request, folder_path.as_deref())?;
        let context = serde_json::json!({
            "jobId": request.job_id, "frames": request.frames, "steps": request.steps,
            "canvasWidth": request.canvas_width, "canvasHeight": request.canvas_height,
            "referenceCount": request.reference_count(), "refmodCount": request.refmod_count(), "inputChars": request.prompt.chars().count(),
        });
        diagnostics::info(
            "slopfab",
            "plan.requested",
            "Generation plan requested.",
            context.clone(),
        );
        let result = validate_and_normalize_config(config).and_then(|config| {
            match workers.active()? {
                Some(worker) => workers.plan(&worker, &request, &config.provider_settings),
                None => slopfab::resolve_plan(&request, &config.provider_settings, &runtime.references)
                    .and_then(|plan| serde_json::to_value(plan).map_err(|error| error.to_string())),
            }
        });
        match &result {
            Ok(plan) => diagnostics::info(
                "slopfab",
                "plan.resolved",
                "Generation plan resolved.",
                serde_json::json!({
                    "jobId": request.job_id, "frames": plan["alignedFrames"],
                    "canvasWidth": plan["canvasWidth"], "canvasHeight": plan["canvasHeight"],
                    "durationSeconds": plan["durationSeconds"], "modelEvaluations": plan["modelEvaluations"],
                }),
            ),
            Err(error) => diagnostics::error("slopfab", "plan.failed", error, context),
        }
        result
    })
    .await
}

#[tauri::command]
pub(crate) async fn enqueue_slopfab_generation(
    app: AppHandle,
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    mut request: slopfab::GenerationRequest,
    config: ProjectConfig,
    folder_path: String,
) -> Result<(), String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    blocking(move || {
        prepare_continuation_path(&mut request, Some(&folder_path))?;
        prepare_image_edit_path(&mut request, Some(&folder_path))?;
        if !request.still_image {
            request.save_latents_path = Some(generated_latent_destination(&folder_path, &request.job_id)?);
        }
        let job_id = request.job_id.clone();
        let result = validate_and_normalize_config(config).and_then(|config| {
            match workers.active()? {
                Some(worker) => workers.enqueue(worker, request, &config.provider_settings),
                None => runtime.enqueue(
                    std::sync::Arc::new(move |event| match event {
                        slopfab::NativeEvent::Job(value) => {
                            let _ = app.emit("slopfab-job", value);
                        }
                        slopfab::NativeEvent::Progress(value) => {
                            let _ = app.emit("slopfab-progress", value);
                        }
                    }),
                    request,
                    &config.provider_settings,
                ),
            }
        });
        if let Err(error) = &result {
            diagnostics::error(
                "slopfab",
                "generation.enqueue_failed",
                error,
                serde_json::json!({ "jobId": job_id }),
            );
        }
        result
    })
    .await
}

/// Refmod destinations picked in the save dialog during this run. An export
/// writes only to one of these, so the webview cannot name its own target.
#[derive(Clone, Default)]
pub(crate) struct RefmodExportTargets(std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>);

#[tauri::command]
pub(crate) async fn choose_refmod_export_path(
    app: AppHandle,
    targets: tauri::State<'_, RefmodExportTargets>,
    name: String,
) -> Result<Option<String>, String> {
    let targets = targets.inner().clone();
    blocking(move || {
        let Some(destination) = app.dialog().file()
            .set_title("Export refmod")
            .add_filter("Refmod", &["safetensors"])
            .set_file_name(format!("{}.safetensors", paths::safe_folder_name(&name)))
            .blocking_save_file() else {
            return Ok(None);
        };
        let destination = destination.into_path().map_err(|_| "Choose a local refmod destination.")?;
        let destination = if destination.extension().is_some_and(|value| value.eq_ignore_ascii_case("safetensors")) {
            destination
        } else {
            destination.with_extension("safetensors")
        };
        let destination = paths::display_path(&destination);
        targets.0.lock().map_err(|_| "Refmod export lock failed.")?.insert(destination.clone());
        Ok(Some(destination))
    })
    .await
}

/// Encodes a reference's prepared images, video and sound into a refmod file.
#[tauri::command]
pub(crate) async fn export_reference_refmod(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    targets: tauri::State<'_, RefmodExportTargets>,
    request: slopfab::GenerationRequest,
    config: ProjectConfig,
    output_path: String,
    name: String,
    description: String,
) -> Result<(), String> {
    let (runtime, workers, targets) = (state.inner().clone(), workers.inner().clone(), targets.inner().clone());
    blocking(move || {
        if !targets.0.lock().map_err(|_| "Refmod export lock failed.")?.remove(&output_path) {
            return Err("Choose where to save the refmod before exporting it.".into());
        }
        let output = std::path::Path::new(&output_path);
        let context = serde_json::json!({ "jobId": request.job_id, "referenceCount": request.reference_count() });
        let result = validate_and_normalize_config(config).and_then(|config| match workers.active()? {
            Some(worker) => workers.export_refmod(&worker, &request, &config.provider_settings, &name, &description, output),
            None => slopfab::export_refmod(&request, &config.provider_settings, &runtime.references, output, &name, &description),
        });
        match &result {
            Ok(()) => diagnostics::info("slopfab", "refmod.exported", "Reference exported as a refmod.", context),
            Err(error) => diagnostics::error("slopfab", "refmod.export_failed", error, context),
        }
        result
    })
    .await
}

fn prepare_image_edit_path(request: &mut slopfab::GenerationRequest, folder_path: Option<&str>) -> Result<(), String> {
    if let Some(edit) = &request.image_edit {
        let root = crate::project::paths::ProjectRoot::open(folder_path.ok_or("Image edits require a project folder.")?)?;
        let path = root.existing(&edit.source_relative_path)?;
        let (width, height) = ::image::image_dimensions(&path).map_err(|error| format!("Could not read source image: {error}"))?;
        if width != request.canvas_width as u32 || height != request.canvas_height as u32 {
            return Err("Image edit dimensions do not match the source file.".into());
        }
        request.image_edit_path = Some(path);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn cancel_slopfab_generation(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    workers: tauri::State<'_, Workers>,
    job_id: String,
) -> Result<bool, String> {
    let (runtime, workers) = (state.inner().clone(), workers.inner().clone());
    // A job sent to a worker is cancelled there, whichever worker is selected now.
    blocking(move || Ok(workers.cancel(&job_id) || runtime.cancel(&job_id))).await
}
