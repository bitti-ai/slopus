use crate::{slopfab::upscale::{self, UpscaleConfig, UpscaleMethod}, worker::Workers};
use slopus_core::{upscale_stream::Session, worker::protocol::StartUpscale};
use std::{collections::HashMap, sync::{atomic::AtomicBool, Arc, LazyLock, Mutex}};
use tauri::{ipc::{InvokeBody, Request, Response}, State};

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<Session>>>> = LazyLock::new(Default::default);
fn session(id: &str) -> Result<Arc<Session>, String> {
    SESSIONS.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("Upscale session has ended.".into())
}

pub(crate) fn run(workers: &Workers, id: &str, config: &UpscaleConfig,
    input: (u32, u32), output: (u32, u32), segment_frames: u32, stop: &AtomicBool,
    read: &mut (dyn FnMut() -> Result<Option<Vec<u8>>, String> + Send),
    write: &mut (dyn FnMut(Vec<u8>) -> Result<(), String> + Send)) -> Result<u64, String> {
    if config.method == UpscaleMethod::Seedvr2 {
        if let Some(worker) = workers.active()? {
            let [model, vae] = workers.prepare_upscale_files(&worker, id, config, stop)?;
            return worker.upscale(id, &StartUpscale { input_width: input.0, input_height: input.1, width: output.0, height: output.1, segment_frames,
                model: Some(model), vae: Some(vae) }, stop, read, write);
        }
    }
    upscale::run(config, input, output, segment_frames as i32, stop, read, write)
}

#[tauri::command]
pub(crate) fn start_export_upscale(workers: State<'_, Workers>, id: String, config: UpscaleConfig,
    input_width: u32, input_height: u32, width: u32, height: u32) -> Result<(), String> {
    let mut sessions = SESSIONS.lock().map_err(|e| e.to_string())?;
    if !sessions.is_empty() { return Err("Another upscale export is already running.".into()); }
    let workers = workers.inner().clone();
    let job_id = id.clone();
    let session = Session::start((input_width, input_height), (width, height), move |stop, read, write| {
        run(&workers, &job_id, &config, (input_width, input_height), (width, height), 5, stop, read, write)
    })?;
    sessions.insert(id, session);
    Ok(())
}

#[tauri::command]
pub(crate) async fn push_export_upscale(request: Request<'_>) -> Result<(), String> {
    let id = crate::commands::binary::decoded_header(&request, "x-upscale-id")?;
    let session = session(&id)?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("Expected raw RGBA pixels.".into()); };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || session.push(bytes)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn finish_export_upscale(id: String) -> Result<(), String> {
    let session = session(&id)?;
    tauri::async_runtime::spawn_blocking(move || session.finish()).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn read_export_upscale(id: String) -> Result<Response, String> {
    let session = session(&id)?;
    tauri::async_runtime::spawn_blocking(move || session.read().map(Response::new)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn cancel_export_upscale(id: String) -> Result<(), String> {
    if let Some(session) = SESSIONS.lock().map_err(|e| e.to_string())?.remove(&id) { session.cancel(); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn seedvr2_uses_local_runtime_when_no_worker_is_selected() {
        let model = tempfile::NamedTempFile::new().unwrap();
        let vae = tempfile::NamedTempFile::new().unwrap();
        let config = UpscaleConfig { method: UpscaleMethod::Seedvr2, model_path: model.path().to_string_lossy().into_owned(),
            vae_path: Some(vae.path().to_string_lossy().into_owned()) };
        // Cancellation is handled by the local runtime before loading weights or using the GPU.
        let result = run(&Workers::default(), "test", &config, (16, 16), (32, 32), 1,
            &AtomicBool::new(true), &mut || Ok(None), &mut |_| Ok(()));
        assert_eq!(result.unwrap_err(), "Upscaling cancelled.");
    }
}
