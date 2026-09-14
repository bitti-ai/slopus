use serde::{Deserialize, Serialize};
use std::{fs::{self, OpenOptions}, io::{self, Write}, path::{Path, PathBuf}};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub weight_folders: Vec<PathBuf>,
}

pub fn ensure_file(data_directory: &Path) -> io::Result<()> {
    fs::create_dir_all(data_directory)?;
    match OpenOptions::new().write(true).create_new(true).open(data_directory.join("settings.json")) {
        Ok(mut file) => file.write_all(b"{\n  \"weightFolders\": []\n}\n"),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error),
    }
}

/// Read on each weight operation so edits take effect without restarting.
pub fn load(data_directory: &Path) -> Result<AppSettings, String> {
    let path = data_directory.join("settings.json");
    ensure_file(data_directory).map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    let bytes = fs::read(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let settings: AppSettings = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))?;
    for folder in &settings.weight_folders {
        if !folder.is_absolute() || folder.to_string_lossy().contains('\0') {
            return Err(format!("Invalid {}: weightFolders must contain absolute folder paths.", path.display()));
        }
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_defaults_and_preserves_and_reloads_user_settings() {
        let directory = tempfile::tempdir().unwrap();
        assert!(load(directory.path()).unwrap().weight_folders.is_empty());
        let path = directory.path().join("settings.json");
        let custom = directory.path().join("custom models");
        let content = serde_json::to_vec(&serde_json::json!({ "weightFolders": [custom], "futureSetting": true })).unwrap();
        fs::write(&path, &content).unwrap();
        ensure_file(directory.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), content);
        assert_eq!(load(directory.path()).unwrap().weight_folders, vec![custom]);
        fs::write(&path, b"{}").unwrap();
        assert!(load(directory.path()).unwrap().weight_folders.is_empty());
    }

    #[test]
    fn reports_invalid_settings_without_overwriting_them() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        for content in [r#"{"weightFolders": ["relative/path"]}"#, r#"{"weightFolders": [""]}"#, r#"{"weightFolders": "wrong"}"#, "{"] {
            fs::write(&path, content).unwrap();
            assert!(load(directory.path()).err().unwrap().contains("settings.json"));
            assert_eq!(fs::read_to_string(&path).unwrap(), content);
        }
    }
}
