//! File transport for portable, versioned Slopus bundles. Payload schemas live
//! with their importers; these commands only access user-selected .slop files.
use std::{fs::File, io::Read, path::Path};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

const MAX_SLOP_BYTES: usize = 4 * 1024 * 1024;

fn validate_contents(contents: &str) -> Result<(), String> {
    if contents.len() > MAX_SLOP_BYTES {
        return Err("The .slop file exceeds 4 MB.".into());
    }
    let value: serde_json::Value = serde_json::from_str(contents.trim_start_matches('\u{feff}'))
        .map_err(|_| "This .slop file is not valid JSON.")?;
    if value.get("format").and_then(|v| v.as_str()) != Some("slop") {
        return Err("This is not a Slopus .slop bundle.".into());
    }
    Ok(())
}

fn read_slop(path: &Path) -> Result<String, String> {
    if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("slop")) {
        return Err("Choose a .slop file.".into());
    }
    let file = File::open(path).map_err(|error| format!("Could not open .slop file: {error}"))?;
    if !file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Choose a regular .slop file.".into());
    }
    let mut contents = String::new();
    file.take((MAX_SLOP_BYTES + 1) as u64).read_to_string(&mut contents)
        .map_err(|error| format!("Could not read .slop file as UTF-8: {error}"))?;
    validate_contents(&contents)?;
    Ok(contents)
}

#[tauri::command]
pub(crate) async fn import_slop_file(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().set_title("Import generator templates")
            .add_filter("Slopus bundle", &["slop"]).blocking_pick_file() else { return Ok(None); };
        let path = file.into_path().map_err(|_| "Choose a local .slop file.")?;
        read_slop(&path).map(Some)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn export_slop_file(app: AppHandle, contents: String, filename: String) -> Result<bool, String> {
    validate_contents(&contents)?;
    // This is a suggested basename, never a path supplied by the webview.
    let filename = if filename.ends_with(".slop") && !filename.contains(['/', '\\', ':']) {
        filename
    } else { "generators.slop".into() };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().set_title("Export generator templates")
            .add_filter("Slopus bundle", &["slop"]).set_file_name(&filename).blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|_| "Choose a local .slop destination.")?;
        let destination = path.with_extension("slop");
        if path != destination && destination.exists() {
            return Err("That .slop file already exists. Select it in the Save dialog to confirm replacement.".into());
        }
        crate::storage::atomic::write_atomically(&destination, contents.as_bytes())?;
        Ok(true)
    }).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_utf8_bundles_and_rejects_invalid_files() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("templates.SLOP");
        let contents = "\u{feff}{\"format\":\"slop\",\"version\":1,\"items\":[]}";
        std::fs::write(&file, contents).unwrap();
        assert_eq!(read_slop(&file).unwrap(), contents);
        std::fs::write(&file, "not JSON").unwrap();
        assert!(read_slop(&file).unwrap_err().contains("JSON"));
        std::fs::write(&file, "{\"format\":\"other\"}").unwrap();
        assert!(read_slop(&file).is_err());
        std::fs::write(&file, [0xff, 0xfe]).unwrap();
        assert!(read_slop(&file).unwrap_err().contains("UTF-8"));
        std::fs::write(&file, " ".repeat(MAX_SLOP_BYTES + 1)).unwrap();
        assert!(read_slop(&file).unwrap_err().contains("4 MB"));
        assert!(read_slop(&directory.path().join("templates.json")).unwrap_err().contains("Choose a .slop"));
    }
}
