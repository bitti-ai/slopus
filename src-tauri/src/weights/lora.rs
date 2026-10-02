use std::path::PathBuf;

#[tauri::command]
pub async fn prepare_lora(path: String, allow_download: bool) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose an existing local LoRA file using its absolute path.".into());
    }
    // All current Slopus generator profiles use the H3 2688-wide adapter grid.
    tauri::async_runtime::spawn_blocking(move || {
        slopus_core::weights::lora::prepare(&path, 2688, allow_download, &crate::slopfab::MODEL_ACCESS)
    })
    .await
    .map_err(|error| error.to_string())?
}
