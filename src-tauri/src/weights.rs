//! Weight download commands. The downloader itself lives in slopus-core,
//! shared with the LAN worker; this adds the app's folders and progress events.
use crate::diagnostics;
use serde::Serialize;
use slopus_core::weights::*;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WeightDownloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { request_id: String, downloaded: u64, total: Option<u64> }

pub(crate) mod lora;

fn configured_weight_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let data_directory = crate::app_paths::data_directory(app);
    let settings = crate::app_settings::load(&data_directory)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let primary = executable.parent().ok_or("Could not locate Slopus.exe.")?.join("weights");
    let fallback = diagnostics::log_info().ok().and_then(|info| Path::new(&info.path).parent().map(|parent| parent.join("weights")))
        .unwrap_or_else(|| data_directory.join("logs/weights"));
    Ok(weight_roots(&settings.weight_folders, primary, fallback))
}

#[tauri::command]
pub async fn find_downloaded_weights(app: AppHandle, urls: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(find_downloaded(urls, &configured_weight_roots(&app)?))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn download_weight(app: AppHandle, downloads: State<'_, WeightDownloads>, request_id: String, url: String) -> Result<String, String> {
    let url = download_url(&url)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = downloads.0.lock().map_err(|_| "Download lock failed.")?;
        if !active.is_empty() { return Err("Another weight download is already running.".into()); }
        active.insert(request_id.clone(), cancelled.clone());
    }
    let event_id = request_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _models = crate::slopfab::MODEL_ACCESS.try_read()
            .map_err(|_| "Wait for LoRA preparation to finish before downloading weights.")?;
        let roots = configured_weight_roots(&app)?;
        transfer_from_roots(&url, &roots, &cancelled, |downloaded, total| {
            let _ = app.emit("weight-download-progress", Progress { request_id: event_id.clone(), downloaded, total });
        })
    }).await.map_err(|error| error.to_string()).and_then(|result| result);
    if let Ok(mut active) = downloads.0.lock() { active.remove(&request_id); }
    result
}

#[tauri::command]
pub fn cancel_weight_download(downloads: State<'_, WeightDownloads>, request_id: String) {
    if let Ok(active) = downloads.0.lock() {
        if let Some(cancelled) = active.get(&request_id) { cancelled.store(true, Ordering::Relaxed); }
    }
}

#[tauri::command]
pub async fn check_weight_files(paths: Vec<String>) -> Result<HashMap<String, bool>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|path| {
        let exists = fs::metadata(&path).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0);
        (path, exists)
    }).collect()).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn weight_download_hardware() -> Result<Vec<crate::slopfab::GpuDevice>, String> {
    tauri::async_runtime::spawn_blocking(hardware_devices).await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn remove_downloaded_weights(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _models = crate::slopfab::MODEL_ACCESS.try_write()
            .map_err(|_| "Model files are in use. Wait for generation, downloads or preparation to finish.")?;
        let roots = configured_weight_roots(&app)?;
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        for path in &paths { validate_removal(path, &roots)?; }
        for path in paths {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
                let _ = fs::remove_file(path.with_extension("complete.json"));
                let _ = fs::remove_file(crate::conditioning::cached_path(&path));
            }
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}
