use super::*;
use std::io::Read;
use sha2::{Digest, Sha256};

const GRID_URL: &str = "https://huggingface.co/deAPI-ai/minimax-h3-33b-int8/resolve/ee696877efb4553214cb8d920d5617fd3309b910/loras/h3_silu_temb_grid.safetensors";
const GRID_SIZE: u64 = 5_510_600;

fn adapter_header(path: &Path) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut length = [0u8; 8];
    file.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u64::from_le_bytes(length);
    if length == 0 || length > 16 * 1024 * 1024 || length + 8 > file.metadata().map_err(|e| e.to_string())?.len() {
        return Err("Invalid LoRA SafeTensors header length.".into());
    }
    let mut header = vec![0u8; length as usize];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    serde_json::from_slice(&header).map_err(|e| format!("Invalid LoRA SafeTensors header: {e}"))
}

fn download_legacy_grid(directory: &Path) -> Result<(), String> {
    let url = download_url(GRID_URL)?;
    let cached = transfer(&url, directory, &AtomicBool::new(false), |_, _| {})?;
    if fs::metadata(&cached).map_err(|e| e.to_string())?.len() != GRID_SIZE {
        return Err("Downloaded timestep grid has an unexpected size.".into());
    }
    let bytes = fs::read(&cached).map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&bytes)) != "30eb3c2cc7fb6b470d9717ff840d359313ac27cd64b705e32da1baa10f72d6a8" {
        return Err("Downloaded timestep grid failed SHA-256 verification.".into());
    }
    // A hard link publishes the verified file without overwriting a local companion.
    fs::hard_link(cached, directory.join("h3_silu_temb_grid.safetensors")).map_err(|e| e.to_string())
}

/// Runs before inference, while no model reader can hold the adapter open.
fn prepare(
    path: &Path,
    width: i32,
    allow_download: bool,
    model_access: &std::sync::RwLock<()>,
) -> Result<(), String> {
    let _models = model_access
        .try_write()
        .map_err(|_| "Model files are in use. Prepare the LoRA after generation finishes.")?;
    let header = adapter_header(path)?;
    // DMAD only targets attention/MLP projections. The explicit grid API always
    // expects a grid, even for adapters whose inference never needs one.
    if !header.keys().any(|key| key.contains("adaln_proj"))
        && header.keys().any(|key| key.contains(".lora.") || key.contains(".lora_")) {
        return Ok(());
    }
    // Slopfab owns grid validation, asset selection and atomic embedding.
    // Preserve the URL record even on an idempotent retry after a record-write error.
    let record_path = path.with_extension("complete.json");
    let record = fs::read(&record_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CompletedFile>(&bytes).ok())
        .filter(|record| {
            download_url(&record.url).is_ok_and(|url| {
                path.file_name().and_then(|name| name.to_str())
                    == Some(destination_name(&url).as_str())
            })
        });
    if let Err(error) = crate::slopfab::prepare_lora_grid(path, width, false) {
        let directory = path.parent().ok_or("LoRA has no parent directory.")?;
        let custom_grid = header.get("__metadata__").and_then(|m| m.get("slopfab.lora_grid")).is_some();
        if !allow_download || width != 2688 || custom_grid
            || directory.join("h3_silu_temb_grid.safetensors").exists()
            || !(error.contains("local companion file:") || error.contains("no matching embedded AdaLN grid")) {
            return Err(error);
        }
        download_legacy_grid(directory)?;
        crate::slopfab::prepare_lora_grid(path, width, false)?;
    }
    if let Some(mut record) = record {
        record.bytes = fs::metadata(path).map_err(|error| error.to_string())?.len();
        fs::write(
            record_path,
            serde_json::to_vec(&record).map_err(|error| error.to_string())?,
        )
        .map_err(|error| {
            format!("LoRA prepared, but its download record could not be updated: {error}")
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_lora(path: String, allow_download: bool) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err("Choose an existing local LoRA file using its absolute path.".into());
    }
    // All current Slopus generator profiles use the H3 2688-wide adapter grid.
    tauri::async_runtime::spawn_blocking(move || {
        prepare(&path, 2688, allow_download, &crate::slopfab::MODEL_ACCESS)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(path: &Path, tensor: &str, shape: &[usize]) {
        let bytes = shape.iter().product::<usize>() * 4;
        let header = serde_json::json!({ tensor: { "dtype": "F32", "shape": shape, "data_offsets": [0, bytes] } }).to_string();
        let mut data = (header.len() as u64).to_le_bytes().to_vec();
        data.extend_from_slice(header.as_bytes());
        data.resize(data.len() + bytes, 0);
        fs::write(path, data).unwrap();
    }

    #[test]
    fn dmad_projections_need_no_companion_or_rewrite() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("dmad.safetensors");
        fixture(&path, "transformer_blocks.0.attn.to_q.lora.down.weight", &[2, 2]);
        let original = fs::read(&path).unwrap();
        for allow_download in [false, true] {
            prepare(&path, 2688, allow_download, &std::sync::RwLock::new(())).unwrap();
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(fs::read_dir(folder.path()).unwrap().count(), 1);
        }
    }

    #[test]
    fn malformed_adapter_headers_fail_without_allocating_from_untrusted_length() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("bad.safetensors");
        fs::write(&path, u64::MAX.to_le_bytes()).unwrap();
        assert!(adapter_header(&path).unwrap_err().contains("header length"));
    }

    #[test]
    fn cached_grid_must_match_pinned_bytes_before_publication() {
        let folder = tempfile::tempdir().unwrap();
        let url = download_url(GRID_URL).unwrap();
        let cached = folder.path().join(destination_name(&url));
        fs::write(&cached, vec![0u8; GRID_SIZE as usize]).unwrap();
        fs::write(cached.with_extension("complete.json"), serde_json::to_vec(&CompletedFile {
            url: url.to_string(), bytes: GRID_SIZE,
        }).unwrap()).unwrap();
        assert!(download_legacy_grid(folder.path()).unwrap_err().contains("SHA-256"));
        assert!(!folder.path().join("h3_silu_temb_grid.safetensors").exists());
    }

    #[test]
    fn preparation_preserves_download_discovery_and_is_idempotent() {
        let model_access = std::sync::RwLock::new(());
        let folder = tempfile::tempdir().unwrap();
        let url = download_url("https://example.com/adapter.safetensors").unwrap();
        let path = folder.path().join(destination_name(&url));
        fixture(&path, "weight", &[1]);
        let record = CompletedFile {
            url: url.to_string(),
            bytes: fs::metadata(&path).unwrap().len(),
        };
        fs::write(
            path.with_extension("complete.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        let original = fs::read(&path).unwrap();
        assert!(prepare(&path, 2, false, &model_access).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(cached_file(&path, &url));
        let companion = folder.path().join("h3_silu_temb_grid.safetensors");
        fixture(&companion, "silu_t_emb_grid", &[1025, 2]);
        prepare(&path, 2, true, &model_access).unwrap();
        let embedded = fs::read(&path).unwrap();
        assert!(embedded.len() > original.len());
        assert!(cached_file(&path, &url));
        assert_eq!(
            find_cached_weight(&url, &[folder.path().to_owned()]),
            Some(path.to_string_lossy().into_owned())
        );
        fs::remove_file(companion).unwrap();
        prepare(&path, 2, false, &model_access).unwrap();
        assert_eq!(fs::read(&path).unwrap(), embedded);
        assert!(validate_removal(&path, &[folder.path().to_owned()]).is_ok());
    }

    #[test]
    fn preparation_rejects_busy_model_files() {
        let model_access = std::sync::RwLock::new(());
        let _models = model_access.read().unwrap();
        assert!(prepare(Path::new("unused"), 2, false, &model_access)
            .unwrap_err()
            .contains("in use"));
    }
}
