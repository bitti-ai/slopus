use super::{events::NativeEvent, ffi::{Api, RequestHandle}, platform::ComputePlatform, runtime::QueueItem, types::ProgressEvent};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}, time::Instant};

fn calibration_path(directory: &Path, vae: &Path, cancel: &AtomicBool) -> Result<PathBuf, String> {
    let mut source = File::open(vae).map_err(|e| format!("Cannot read the VAE for generation effects: {e}"))?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) { return Err("Generation effects preparation cancelled.".into()); }
        let count = source.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(directory.join(format!("h3-v1-64-256-{:x}.safetensors", hash.finalize())))
}

pub(super) fn prepare(api: &Api, request: &RequestHandle, item: &QueueItem, platform: ComputePlatform) -> Result<bool, String> {
    let Some(settings) = item.request.generation_effects.as_ref().map(|e| e.native_settings()).transpose()?.flatten() else { return Ok(false); };
    api.require_lcs()?;
    let started = Instant::now();
    let report = |completed, total| {
        (item.events)(NativeEvent::Progress(ProgressEvent {
            job_id: item.request.job_id.clone(), stage: "calibrating", step: completed, total_steps: total, planned_steps: 0,
            elapsed_seconds: started.elapsed().as_secs_f64(), frames: item.request.frames,
            canvas_width: item.request.canvas_width, canvas_height: item.request.canvas_height,
            reference_count: item.request.reference_count(), timing_profile: String::new(),
        }));
        !item.cancel.load(Ordering::Acquire)
    };
    if !report(0, 0) { return Err("Generation effects preparation cancelled.".into()); }
    let vae = item.configuration.models.iter().find(|(id, _, _)| *id == 3).and_then(|(_, _, path)| path.as_deref()).ok_or("Generation effects require a video VAE.")?;
    let log_path = PathBuf::from(crate::diagnostics::log_info()?.path);
    let directory = log_path.parent().ok_or("Cannot locate the generation effects cache.")?.join("lcs");
    std::fs::create_dir_all(&directory).map_err(|e| format!("Cannot create the generation effects cache: {e}"))?;
    let path = calibration_path(&directory, vae, &item.cancel)?;
    let settings = settings.to_string();
    // set_lcs snapshots the archive, so a valid cache needs no GPU calibration.
    if path.is_file() && api.set_lcs(request, &path, &settings).is_ok() { return Ok(true); }
    let calibration = RequestHandle::new(api)?;
    api.set_model(&calibration, 3, vae)?;
    api.set_inference_backend(&calibration, platform.backend())?;
    api.calibrate_lcs(&calibration, &path, &mut { report })?;
    if item.cancel.load(Ordering::Acquire) { return Err("Generation effects preparation cancelled.".into()); }
    api.set_lcs(request, &path, &settings)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calibration_cache_tracks_vae_contents_and_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let vae = directory.path().join("vae");
        let cancel = AtomicBool::new(false);
        std::fs::write(&vae, b"first").unwrap();
        let first = calibration_path(directory.path(), &vae, &cancel).unwrap();
        assert_eq!(first, calibration_path(directory.path(), &vae, &cancel).unwrap());
        std::fs::write(&vae, b"other").unwrap();
        assert_ne!(first, calibration_path(directory.path(), &vae, &cancel).unwrap());
        cancel.store(true, Ordering::Release);
        assert!(calibration_path(directory.path(), &vae, &cancel).unwrap_err().contains("cancelled"));
    }
}
