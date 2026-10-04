//! The wire contract between Slopus and a LAN worker. Both sides compile this
//! file, so a field renamed here is renamed for both.
use crate::{
    settings::{ProviderOption, ProviderSetting},
    slopfab::{GenerationRequest, GpuDevice},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SERVICE_TYPE: &str = "_slopus-worker._tcp.local.";
/// Bumped on any incompatible change to the routes or bodies below.
// v3 carries inverted image masks; older workers would silently edit the
// preserved original instead of the extension if they ignored this field.
pub const PROTOCOL_VERSION: u32 = 3;
pub const DEFAULT_PORT: u16 = 47321;
pub const TOKEN_HEADER: &str = "x-slopus-token";

/// A request can only name a worker file through one of these tokens. Raw
/// paths are refused, so a client cannot make the worker read its own disk.
const FILE_TOKEN: &str = "slopus-file:";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub protocol: u32,
    pub requires_token: bool,
    pub gpus: Vec<GpuDevice>,
    pub runtime: WorkerRuntime,
}

/// The worker's engine, without any model paths: those come from the client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRuntime {
    /// "ready" when the engine library loaded, else the engine's own state.
    pub state: String,
    pub version: Option<String>,
    pub platform: Option<String>,
    pub cuda_available: bool,
    pub cuda_device_names: Vec<String>,
    pub detail: String,
}

/// Where the worker gets one model file or folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileRef {
    /// Downloaded on the worker, into its weights folders, unless already there.
    #[serde(rename_all = "camelCase")]
    Url { url: String, lora: bool },
    /// Sent by the client. `key` identifies the content; entries are relative
    /// to the uploaded folder, or a single entry named like the file.
    #[serde(rename_all = "camelCase")]
    Upload { key: String, name: String, directory: bool, entries: Vec<UploadEntry>, lora: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadEntry {
    pub path: String,
    pub bytes: u64,
}

/// A generation with every path replaced by a token into `files`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteJob {
    pub request: GenerationRequest,
    pub settings: BTreeMap<String, ProviderSetting>,
    pub files: Vec<FileRef>,
    pub continuation: Option<usize>,
    pub image_edit_source: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartJob {
    pub job: RemoteJob,
    /// Video jobs save latents on the worker for the client to collect.
    pub save_latents: bool,
}

/// A refmod export. The job carries raw references and the VAEs only.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefmodExport {
    pub job: RemoteJob,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireEvent {
    pub seq: u64,
    /// "job" or "progress": the desktop event the payload is re-emitted as.
    pub kind: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreparation {
    /// "running", "done", "failed" or "cancelled".
    pub state: String,
    pub file: Option<String>,
    pub completed: usize,
    pub files: usize,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingUploads {
    /// (key, entry path) pairs the worker does not hold yet.
    pub missing: Vec<(String, String)>,
}

pub fn file_token(index: usize) -> String {
    format!("{FILE_TOKEN}{index}")
}

pub fn parse_file_token(value: &str) -> Option<usize> {
    value.strip_prefix(FILE_TOKEN)?.parse().ok()
}

/// What a path in a generation is for. Uploading a folder and preparing a
/// LoRA after download both depend on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    Model,
    Folder,
    Lora,
    Input,
}

const MODEL_OPTIONS: [&str; 5] = ["transformer", "textEncoder", "videoVae", "audioVae", "promptEmbedding"];

/// Visits every file path a generation names, in a fixed order. The client
/// swaps local paths for tokens with it, and the worker swaps tokens back
/// for its own paths. Anything not listed here never crosses the network.
pub fn visit_paths(
    request: &mut GenerationRequest,
    settings: &mut BTreeMap<String, ProviderSetting>,
    mut visit: impl FnMut(PathKind, &mut String) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(slopfab) = settings.get_mut("slopfab") {
        // The engine library always comes from the machine that runs it.
        slopfab.options.remove("dllPath");
        for name in MODEL_OPTIONS {
            if let Some(ProviderOption::String(value)) = slopfab.options.get_mut(name) {
                if !value.trim().is_empty() {
                    visit(PathKind::Model, value)?;
                }
            }
        }
        if let Some(ProviderOption::String(value)) = slopfab.options.get_mut("tokenizer") {
            if !value.trim().is_empty() {
                visit(PathKind::Folder, value)?;
            }
        }
        if let Some(ProviderOption::String(value)) = slopfab.options.get_mut("loras") {
            let mut loras: Vec<serde_json::Map<String, serde_json::Value>> = serde_json::from_str(value)
                .map_err(|error| format!("Invalid LoRA settings: {error}"))?;
            for lora in &mut loras {
                if let Some(serde_json::Value::String(path)) = lora.get_mut("path") {
                    visit(PathKind::Lora, path)?;
                }
            }
            *value = serde_json::to_string(&loras).map_err(|error| error.to_string())?;
        }
    }
    for path in &mut request.reference_paths {
        visit(PathKind::Input, path)?;
    }
    for refmod in &mut request.refmods {
        visit(PathKind::Input, &mut refmod.path)?;
    }
    if let Some(edit) = &mut request.image_edit {
        for step in &mut edit.edits {
            for path in step.reference_paths.iter_mut().flatten() {
                visit(PathKind::Input, path)?;
            }
            for refmod in step.refmods.iter_mut().flatten() {
                visit(PathKind::Input, &mut refmod.path)?;
            }
        }
    }
    Ok(())
}

/// A relative upload path that stays inside its folder on any platform.
pub fn safe_relative_path(path: &str) -> Result<std::path::PathBuf, String> {
    let mut safe = std::path::PathBuf::new();
    for part in path.split('/') {
        let valid = !part.is_empty()
            && part != "."
            && part != ".."
            && part.len() <= 200
            && !part.chars().any(|c| c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
        if !valid {
            return Err(format!("'{path}' is not a valid upload path."));
        }
        safe.push(part);
    }
    if safe.as_os_str().is_empty() {
        return Err("An upload path cannot be empty.".into());
    }
    Ok(safe)
}

/// Upload keys become folder names on the worker.
pub fn valid_key(key: &str) -> bool {
    (8..=64).contains(&key.len()) && key.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slopfab::RefmodInput;

    fn settings(options: &[(&str, &str)]) -> BTreeMap<String, ProviderSetting> {
        let options = options.iter().map(|(name, value)| (name.to_string(), ProviderOption::String(value.to_string()))).collect();
        BTreeMap::from([("slopfab".to_string(), ProviderSetting { enabled: true, model: None, options })])
    }

    #[test]
    fn visits_every_path_and_drops_the_engine_library() {
        let mut request = GenerationRequest {
            reference_paths: vec!["C:/project/a.png".into()],
            refmods: vec![RefmodInput { path: "C:/refmod.safetensors".into(), strength: 1.0, copies: 1 }],
            ..Default::default()
        };
        let mut settings = settings(&[
            ("transformer", "C:/w/t.safetensors"), ("tokenizer", "C:/w/tok"), ("dllPath", "C:/evil.dll"),
            ("loras", r#"[{"path":"https://example.com/l.safetensors","strength":0.5}]"#),
        ]);
        let mut seen = Vec::new();
        visit_paths(&mut request, &mut settings, |kind, path| {
            seen.push((kind, path.clone()));
            *path = file_token(seen.len() - 1);
            Ok(())
        }).unwrap();
        assert_eq!(seen.iter().map(|(kind, _)| *kind).collect::<Vec<_>>(),
            vec![PathKind::Model, PathKind::Folder, PathKind::Lora, PathKind::Input, PathKind::Input]);
        let options = &settings["slopfab"].options;
        assert!(!options.contains_key("dllPath"));
        assert_eq!(options["transformer"], ProviderOption::String(file_token(0)));
        assert_eq!(options["loras"], ProviderOption::String(r#"[{"path":"slopus-file:2","strength":0.5}]"#.into()));
        assert_eq!(request.refmods[0].path, file_token(4));
        assert_eq!(parse_file_token(&request.reference_paths[0]), Some(3));
        assert_eq!(parse_file_token("C:/project/a.png"), None);
    }

    #[test]
    fn upload_paths_cannot_leave_their_folder() {
        assert_eq!(safe_relative_path("tokenizer/vocab.json").unwrap(), std::path::Path::new("tokenizer").join("vocab.json"));
        for path in ["", "../x", "a/../../x", "/abs", "C:/x", "a\\..\\b", "a//b", "./a"] {
            assert!(safe_relative_path(path).is_err(), "{path}");
        }
        assert!(valid_key("0123456789abcdef"));
        assert!(!valid_key("../../etc"));
    }
}
