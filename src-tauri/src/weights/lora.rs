use super::*;

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
    // Slopfab owns format validation, asset selection and atomic embedding.
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
    crate::slopfab::prepare_lora_grid(path, width, allow_download)?;
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
        prepare(&path, 2, false, &model_access).unwrap();
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
