use crate::diagnostics;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WeightDownloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { request_id: String, downloaded: u64, total: Option<u64> }

#[derive(Serialize, Deserialize)]
struct CompletedFile { url: String, bytes: u64 }

fn download_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Enter an HTTP or HTTPS download URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("Enter an HTTP or HTTPS download URL without embedded credentials.".into());
    }
    if url.host_str() == Some("huggingface.co") {
        let path = url.path().replacen("/blob/", "/resolve/", 1);
        url.set_path(&path);
    }
    url.set_fragment(None);
    Ok(url)
}

fn destination_name(url: &Url) -> String {
    // A stable URL prefix prevents different repositories' model.safetensors
    // files from overwriting each other. Completion metadata also verifies URL identity.
    let hash = url.as_str().bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ byte as u64).wrapping_mul(0x100000001b3));
    let filename: String = url.path_segments().and_then(|mut parts| parts.next_back()).unwrap_or("weights.bin")
        .chars().take(150).map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    format!("{hash:016x}-{}", if filename.is_empty() { "weights.bin" } else { &filename })
}

fn writable_weights(directory: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let probe = directory.join(format!(".write-check-{:x}", u128::from_le_bytes(random)));
    let file = OpenOptions::new().write(true).create_new(true).open(&probe).map_err(|error| error.to_string())?;
    drop(file);
    fs::remove_file(probe).map_err(|error| error.to_string())?;
    Ok(directory.to_path_buf())
}

fn weight_roots(custom: &[PathBuf], primary: PathBuf, fallback: PathBuf) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for root in custom.iter().cloned().chain([primary, fallback]) {
        if !roots.contains(&root) { roots.push(root); }
    }
    roots
}

fn configured_weight_roots(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let data_directory = crate::app_paths::data_directory(app);
    let settings = crate::app_settings::load(&data_directory)?;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let primary = executable.parent().ok_or("Could not locate Slopus.exe.")?.join("weights");
    let fallback = diagnostics::log_info().ok().and_then(|info| Path::new(&info.path).parent().map(|parent| parent.join("weights")))
        .unwrap_or_else(|| data_directory.join("logs/weights"));
    Ok(weight_roots(&settings.weight_folders, primary, fallback))
}

fn weights_directory(roots: &[PathBuf]) -> Result<PathBuf, String> {
    let mut errors = Vec::new();
    for root in roots {
        match writable_weights(root) {
            Ok(directory) => return Ok(directory),
            Err(error) => errors.push(format!("{}: {error}", root.display())),
        }
    }
    Err(format!("Could not create a writable weights folder: {}", errors.join("; ")))
}

fn cached_file(path: &Path, url: &Url) -> bool {
    let metadata = fs::read(path.with_extension("complete.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<CompletedFile>(&bytes).ok());
    metadata.is_some_and(|info| info.url == url.as_str() && info.bytes > 0
        && fs::metadata(path).is_ok_and(|file| file.is_file() && file.len() == info.bytes))
}

fn transfer_from_roots(url: &Url, roots: &[PathBuf], cancelled: &AtomicBool, progress: impl FnMut(u64, Option<u64>)) -> Result<String, String> {
    if cancelled.load(Ordering::Relaxed) { return Err("Download cancelled.".into()); }
    // Search every location before choosing a destination, including read-only caches.
    if let Some(path) = find_cached_weight(url, roots) { return Ok(path); }
    transfer(url, &weights_directory(roots)?, cancelled, progress)
}

fn find_cached_weight(url: &Url, roots: &[PathBuf]) -> Option<String> {
    roots.iter().map(|root| root.join(destination_name(url)))
        .find(|path| cached_file(path, url)).map(|path| path.to_string_lossy().into_owned())
}

fn find_downloaded(urls: Vec<String>, roots: &[PathBuf]) -> HashMap<String, String> {
    urls.into_iter().filter_map(|original| {
        let url = download_url(&original).ok()?;
        find_cached_weight(&url, roots).map(|path| (original, path))
    }).collect()
}

#[tauri::command]
pub async fn find_downloaded_weights(app: AppHandle, urls: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(find_downloaded(urls, &configured_weight_roots(&app)?))
    }).await.map_err(|error| error.to_string())?
}

fn transfer(url: &Url, directory: &Path, cancelled: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<String, String> {
    let destination = directory.join(destination_name(url));
    if cached_file(&destination, url) { return Ok(destination.to_string_lossy().into_owned()); }
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let temporary = directory.join(format!(".download-{:x}.part", u128::from_le_bytes(random)));
    let result = (|| {
        let client = Client::builder().connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(24 * 60 * 60)).build().map_err(|error| error.to_string())?;
        let mut response = client.get(url.clone()).header("Accept-Encoding", "identity").send()
            .and_then(|response| response.error_for_status()).map_err(|error| format!("Download failed: {error}"))?;
        if response.status() != reqwest::StatusCode::OK { return Err("The server did not return a complete file.".into()); }
        if response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok())
            .is_some_and(|value| value.starts_with("text/html")) {
            return Err("The URL returned a web page instead of a weight file. Use a direct download link.".into());
        }
        let total = response.content_length();
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
        let mut downloaded = 0u64;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut last_progress = Instant::now();
        progress(0, total);
        loop {
            if cancelled.load(Ordering::Relaxed) { return Err("Download cancelled.".into()); }
            let count = response.read(&mut buffer).map_err(|error| format!("Download interrupted: {error}"))?;
            if count == 0 { break; }
            file.write_all(&buffer[..count]).map_err(|error| format!("Could not write weights: {error}"))?;
            downloaded += count as u64;
            if last_progress.elapsed() >= Duration::from_millis(200) {
                progress(downloaded, total);
                last_progress = Instant::now();
            }
        }
        if downloaded == 0 || total.is_some_and(|total| downloaded != total) {
            return Err("The download is incomplete. Try downloading again.".into());
        }
        if cancelled.load(Ordering::Relaxed) { return Err("Download cancelled.".into()); }
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        // Only a successful, complete transfer receives the final filename.
        if destination.exists() {
            if cached_file(&destination, url) { return Ok(destination.to_string_lossy().into_owned()); }
            fs::remove_file(&destination).map_err(|error| error.to_string())?;
        }
        fs::rename(&temporary, &destination).map_err(|error| error.to_string())?;
        let record = CompletedFile { url: url.to_string(), bytes: downloaded };
        fs::write(destination.with_extension("complete.json"), serde_json::to_vec(&record).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        progress(downloaded, Some(downloaded));
        Ok(destination.to_string_lossy().into_owned())
    })();
    let _ = fs::remove_file(&temporary);
    result
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

fn hardware_devices() -> Vec<crate::slopfab::GpuDevice> {
    #[cfg(windows)]
    {
        use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
        // DXGI reports dedicated VRAM for NVIDIA, AMD and Intel independently
        // of CUDA installation. COM interface wrappers release their references.
        let mut devices = Vec::new();
        unsafe {
            if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
                let mut index = 0;
                while let Ok(adapter) = factory.EnumAdapters1(index) {
                    index += 1;
                    if let Ok(description) = adapter.GetDesc1() {
                        if description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 { continue; }
                        let end = description.Description.iter().position(|value| *value == 0).unwrap_or(description.Description.len());
                        devices.push(crate::slopfab::GpuDevice {
                            name: String::from_utf16_lossy(&description.Description[..end]),
                            memory_bytes: description.DedicatedVideoMemory as u64,
                        });
                    }
                }
            }
        }
        if !devices.is_empty() { return devices; }
    }
    crate::slopfab::gpu_devices()
}

fn validate_removal(path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    let allowed = roots.iter().filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical.parent() == Some(root.as_path()));
    if !allowed { return Err("Only weights downloaded into Slopus's weights folders can be removed.".into()); }
    let record: CompletedFile = serde_json::from_slice(&fs::read(path.with_extension("complete.json"))
        .map_err(|_| "The downloaded weight's completion record is missing.".to_string())?)
        .map_err(|_| "The downloaded weight's completion record is invalid.".to_string())?;
    let url = download_url(&record.url)?;
    if path.file_name().and_then(|name| name.to_str()) != Some(destination_name(&url).as_str()) {
        return Err("The weight file does not match its download record.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn remove_downloaded_weights(app: AppHandle, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let roots = configured_weight_roots(&app)?;
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        for path in &paths { validate_removal(path, &roots)?; }
        for path in paths {
            if path.exists() {
                fs::remove_file(&path).map_err(|error| format!("Could not remove {}: {error}", path.display()))?;
                let _ = fs::remove_file(path.with_extension("complete.json"));
            }
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn hardware_probe_reads_device_descriptions_without_a_toolkit() {
        let devices = hardware_devices();
        for device in &devices { assert!(!device.name.trim().is_empty()); }
        println!("Detected weight-selection GPUs: {devices:?}");
    }

    fn server(response: &'static [u8]) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut connection, _) = listener.accept().unwrap();
            let mut request = [0u8; 8192];
            let _ = connection.read(&mut request);
            let _ = connection.write_all(response);
        });
        Url::parse(&format!("http://{address}/model.safetensors")).unwrap()
    }

    #[test]
    fn converts_hugging_face_pages_and_rejects_non_download_schemes() {
        assert_eq!(download_url("https://huggingface.co/org/repo/blob/main/vae/model.safetensors").unwrap().as_str(), "https://huggingface.co/org/repo/resolve/main/vae/model.safetensors");
        for url in ["file:///C:/secret", "ftp://example.com/model", "https://user:secret@example.com/model"] { assert!(download_url(url).is_err()); }
        let url = download_url("https://example.com/../../model?file=../../oops").unwrap();
        assert!(!destination_name(&url).contains('/'));
    }

    #[test]
    fn falls_back_when_the_executable_directory_is_not_writable() {
        let folder = tempfile::tempdir().unwrap();
        let blocked = folder.path().join("blocked");
        fs::write(&blocked, b"file, not a directory").unwrap();
        assert_eq!(weights_directory(&[blocked.join("weights"), folder.path().join("weights")]).unwrap(), folder.path().join("weights"));
    }

    #[test]
    fn custom_folders_are_used_directly_in_order_with_default_fallbacks() {
        let folder = tempfile::tempdir().unwrap();
        let blocked = folder.path().join("blocked");
        fs::write(&blocked, b"not a directory").unwrap();
        let custom = folder.path().join("custom models");
        let primary = folder.path().join("exe/weights");
        let fallback = folder.path().join("logs/weights");
        let roots = weight_roots(&[blocked.clone(), custom.clone(), custom.clone()], primary.clone(), fallback.clone());
        assert_eq!(roots, vec![blocked, custom.clone(), primary.clone(), fallback.clone()]);
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata");
        let downloaded = transfer_from_roots(&url, &roots, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(Path::new(&downloaded).parent(), Some(custom.as_path()));
        assert!(!custom.join("weights").exists());
        assert!(!primary.exists());
        assert!(validate_removal(Path::new(&downloaded), &roots).is_ok());
        assert!(validate_removal(Path::new(&downloaded), &[primary.clone(), fallback.clone()]).is_err());
        assert_eq!(weight_roots(&[], primary.clone(), fallback.clone()), vec![primary, fallback]);
    }

    #[test]
    fn searches_all_folders_for_completed_files_before_creating_a_download_destination() {
        let folder = tempfile::tempdir().unwrap();
        let custom = folder.path().join("custom");
        let primary = folder.path().join("exe/weights");
        let fallback = folder.path().join("logs/weights");
        fs::create_dir_all(&fallback).unwrap();
        let roots = weight_roots(&[custom.clone()], primary.clone(), fallback.clone());
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata");
        let downloaded = transfer(&url, &fallback, &AtomicBool::new(false), |_, _| {}).unwrap();
        // The server accepts only one request; reuse must work without network access.
        assert_eq!(transfer_from_roots(&url, &roots, &AtomicBool::new(false), |_, _| {}).unwrap(), downloaded);
        assert!(!custom.exists());
        assert!(!primary.exists());
        fs::create_dir_all(&custom).unwrap();
        let moved = custom.join(destination_name(&url));
        fs::rename(&downloaded, &moved).unwrap();
        fs::rename(Path::new(&downloaded).with_extension("complete.json"), moved.with_extension("complete.json")).unwrap();
        assert_eq!(transfer_from_roots(&url, &roots, &AtomicBool::new(false), |_, _| {}).unwrap(), moved.to_string_lossy());
        assert!(transfer_from_roots(&url, &roots, &AtomicBool::new(true), |_, _| {}).is_err());
    }

    #[test]
    fn discovery_normalizes_urls_and_ignores_missing_incomplete_or_unrecorded_files() {
        let folder = tempfile::tempdir().unwrap();
        let custom = folder.path().join("custom");
        let fallback = folder.path().join("fallback");
        fs::create_dir_all(&custom).unwrap();
        fs::create_dir_all(&fallback).unwrap();
        let blob = "https://huggingface.co/org/repo/blob/main/model.safetensors";
        let url = download_url(blob).unwrap();
        let destination = fallback.join(destination_name(&url));
        fs::write(&destination, b"data").unwrap();
        let roots = [custom.clone(), fallback];
        assert!(find_downloaded(vec![blob.into()], &roots).is_empty());
        let record = CompletedFile { url: url.to_string(), bytes: 4 };
        fs::write(destination.with_extension("complete.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        // A truncated copy in the preferred folder must not hide a complete fallback.
        let incomplete = custom.join(destination_name(&url));
        fs::write(&incomplete, b"bad").unwrap();
        fs::write(incomplete.with_extension("complete.json"), serde_json::to_vec(&record).unwrap()).unwrap();
        let found = find_downloaded(vec![blob.into(), url.to_string(), "https://".into()], &roots);
        assert_eq!(found.len(), 2);
        assert_eq!(found[blob], destination.to_string_lossy());
        assert_eq!(found[url.as_str()], destination.to_string_lossy());
        fs::remove_file(&destination).unwrap();
        assert!(find_downloaded(vec![blob.into()], &roots).is_empty());
    }

    #[test]
    fn publishes_only_complete_files_and_reuses_completed_downloads() {
        let folder = tempfile::tempdir().unwrap();
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata");
        let path = transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"data");
        assert!(cached_file(Path::new(&path), &url));
        assert_eq!(transfer(&url, folder.path(), &AtomicBool::new(false), |_, _| {}).unwrap(), path);
        fs::remove_file(&path).unwrap();
        assert!(!cached_file(Path::new(&path), &url));
    }

    #[test]
    fn rejects_truncated_html_failed_and_cancelled_downloads_without_publishing_files() {
        for (response, cancelled) in [
            (&b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\ndata"[..], false),
            (&b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata"[..], false),
            (&b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"[..], false),
            (&b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata"[..], true),
        ] {
            let folder = tempfile::tempdir().unwrap();
            let url = server(response);
            assert!(transfer(&url, folder.path(), &AtomicBool::new(cancelled), |_, _| {}).is_err());
            assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn removal_is_limited_to_files_created_by_the_downloader() {
        let folder = tempfile::tempdir().unwrap();
        let weights = folder.path().join("weights");
        fs::create_dir(&weights).unwrap();
        let external = folder.path().join("personal.safetensors");
        fs::write(&external, b"data").unwrap();
        assert!(validate_removal(&external, &[weights.clone()]).is_err());
        let url = server(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\ndata");
        let downloaded = transfer(&url, &weights, &AtomicBool::new(false), |_, _| {}).unwrap();
        assert!(validate_removal(Path::new(&downloaded), &[weights.clone()]).is_ok());
        let unmanaged = weights.join("personal.safetensors");
        fs::write(&unmanaged, b"data").unwrap();
        assert!(validate_removal(&unmanaged, &[weights]).is_err());
        assert!(external.is_file());
    }
}
