use crate::{diagnostics, slopfab};
use crate::project::{*, validation::validate_and_normalize_config};
use crate::media::artifacts::*;
use tauri::{AppHandle, Emitter};
#[tauri::command]
pub(crate) fn create_reference_video(state: tauri::State<'_, slopfab::SlopfabRuntime>, duration_seconds: f64, config: ProjectConfig) -> Result<String, String> {
    let config = validate_and_normalize_config(config)?;
    state.references.create_reference_video(duration_seconds, &config.provider_settings)
}

pub(crate) fn reference_video_header<'a>(request: &'a tauri::ipc::Request<'_>, name: &str) -> Result<&'a str, String> {
    request.headers().get(name).and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("Missing or invalid {name} header."))
}

#[tauri::command]
pub(crate) fn append_reference_video(state: tauri::State<'_, slopfab::SlopfabRuntime>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Reference frames require a binary body.".into()); };
    let id = reference_video_header(&request, "x-reference-id")?;
    let width = reference_video_header(&request, "x-reference-width")?.parse().map_err(|_| "Invalid frame width.")?;
    let height = reference_video_header(&request, "x-reference-height")?.parse().map_err(|_| "Invalid frame height.")?;
    let timestamp = reference_video_header(&request, "x-reference-time")?.parse().map_err(|_| "Invalid frame timestamp.")?;
    state.references.append_reference_video(id, bytes, width, height, timestamp)
}

#[tauri::command]
pub(crate) fn set_reference_video_audio(state: tauri::State<'_, slopfab::SlopfabRuntime>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Reference audio requires a binary body.".into()); };
    let id = reference_video_header(&request, "x-reference-id")?;
    let channels = reference_video_header(&request, "x-reference-channels")?.parse().map_err(|_| "Invalid audio channels.")?;
    let rate = reference_video_header(&request, "x-reference-rate")?.parse().map_err(|_| "Invalid sample rate.")?;
    state.references.set_reference_video_audio(id, bytes, channels, rate)
}

#[tauri::command]
pub(crate) fn release_reference_videos(state: tauri::State<'_, slopfab::SlopfabRuntime>, ids: Vec<String>) -> Result<(), String> {
    state.references.release_reference_videos(&ids)
}

#[tauri::command]
pub(crate) fn resolve_slopfab_plan(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    mut request: slopfab::GenerationRequest,
    config: ProjectConfig,
    folder_path: Option<String>,
) -> Result<slopfab::ResolvedPlan, String> {
    prepare_continuation_path(&mut request, folder_path.as_deref())?;
    let context = serde_json::json!({
        "jobId": request.job_id, "frames": request.frames, "steps": request.steps,
        "canvasWidth": request.canvas_width, "canvasHeight": request.canvas_height,
        "referenceCount": request.reference_count(), "inputChars": request.prompt.chars().count(),
    });
    diagnostics::info(
        "slopfab",
        "plan.requested",
        "Generation plan requested.",
        context.clone(),
    );
    let result = validate_and_normalize_config(config)
        .and_then(|config| slopfab::resolve_plan(&request, &config.provider_settings, &state.references));
    match &result {
        Ok(plan) => diagnostics::info(
            "slopfab",
            "plan.resolved",
            "Generation plan resolved.",
            serde_json::json!({
                "jobId": request.job_id, "frames": plan.aligned_frames,
                "canvasWidth": plan.canvas_width, "canvasHeight": plan.canvas_height,
                "durationSeconds": plan.duration_seconds, "modelEvaluations": plan.model_evaluations,
            }),
        ),
        Err(error) => diagnostics::error("slopfab", "plan.failed", error, context),
    }
    result
}

#[tauri::command]
pub(crate) fn enqueue_slopfab_generation(
    app: AppHandle,
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    mut request: slopfab::GenerationRequest,
    config: ProjectConfig,
    folder_path: String,
) -> Result<(), String> {
    prepare_continuation_path(&mut request, Some(&folder_path))?;
    request.save_latents_path = Some(generated_latent_destination(&folder_path, &request.job_id)?);
    let job_id = request.job_id.clone();
    let result = validate_and_normalize_config(config)
        .and_then(|config| state.enqueue(std::sync::Arc::new(move |event| {
            match event {
                slopfab::NativeEvent::Job(value) => { let _ = app.emit("slopfab-job", value); }
                slopfab::NativeEvent::Progress(value) => { let _ = app.emit("slopfab-progress", value); }
            }
        }), request, &config.provider_settings));
    if let Err(error) = &result {
        diagnostics::error(
            "slopfab",
            "generation.enqueue_failed",
            error,
            serde_json::json!({ "jobId": job_id }),
        );
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_slopfab_generation(
    state: tauri::State<'_, slopfab::SlopfabRuntime>,
    job_id: String,
) -> bool {
    state.cancel(&job_id)
}
