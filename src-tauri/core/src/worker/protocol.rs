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
// v17 enforces per-template editing capability and enables masked Fibo Zoom.
// v16 enables Fibo text-to-image; older workers require source images.
// v15 carries image negative prompts; older workers would silently discard them.
// v14 adds Fibo model routing, validation and image-only weights.
// v13 carries compound lasso masks; older workers would discard holes and splits.
// v12 carries lasso image masks; older workers would silently edit the box.
// v11 carries image CFG; older workers would silently discard the scale.
// v10 carries generation effects; older workers would silently discard them.
// v8 carries latent upscaling and its model weights.
// v9 carries retained latent bridges and both anchor archives.
// v7 carries separate audio steps; older workers would silently ignore them.
// v6 added custom upscale weights.
// v5 added overlap locking.
// v4 added SeedVR2 export streams. v3 added inverted image masks.
// v19 carries Single Shot ending-first generation; older workers would ignore it.
// v20 carries source-initialized continuation; older workers would ignore it.
// v21 keeps Single Shot's middle fresh; v20 workers default to a repeated source prior.
pub const PROTOCOL_VERSION: u32 = 21;

/// Streaming SeedVR2 restoration; model paths are resolved on the worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartUpscale {
    pub input_width: u32,
    pub input_height: u32,
    pub width: u32,
    pub height: u32,
    pub segment_frames: u32,
    #[serde(default)]
    pub model: Option<FileRef>,
    #[serde(default)]
    pub vae: Option<FileRef>,
}
pub const SEEDVR2_MODEL: &str = "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_fp16.safetensors";
pub const SEEDVR2_VAE: &str = "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors";
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
    pub bridge_left: Option<usize>,
    pub bridge_right: Option<usize>,
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

const MODEL_OPTIONS: [&str; 6] = ["transformer", "textEncoder", "videoVae", "audioVae", "promptEmbedding", "latentUpscaler"];

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
        if !request.latent_upscale { slopfab.options.remove("latentUpscaler"); }
        for name in MODEL_OPTIONS {
            if let Some(ProviderOption::String(value)) = slopfab.options.get_mut(name) {
                if !value.trim().is_empty() {
                    visit(PathKind::Model, value)?;
                }
            }
        }
        let tokenizer_kind = if matches!(slopfab.options.get("modelType"), Some(ProviderOption::String(model)) if model == "moss") {
            PathKind::Model
        } else { PathKind::Folder };
        if let Some(ProviderOption::String(value)) = slopfab.options.get_mut("tokenizer") {
            if !value.trim().is_empty() {
                visit(tokenizer_kind, value)?;
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
    fn latent_upscale_weights_are_transferred_only_for_enabled_jobs() {
        for enabled in [false, true] {
            let mut request = GenerationRequest { latent_upscale: enabled, ..Default::default() };
            let mut settings = settings(&[("latentUpscaler", "C:/weights/upscaler.safetensors")]);
            let mut count = 0;
            visit_paths(&mut request, &mut settings, |kind, path| {
                assert_eq!(kind, PathKind::Model);
                *path = file_token(0);
                count += 1;
                Ok(())
            }).unwrap();
            assert_eq!(count, usize::from(enabled));
            let wire = serde_json::to_vec(&request).unwrap();
            let restored: GenerationRequest = serde_json::from_slice(&wire).unwrap();
            assert_eq!(restored.latent_upscale, enabled);
            visit_paths(&mut request, &mut settings, |_, path| {
                assert_eq!(parse_file_token(path), Some(0));
                *path = "/worker/upscaler.safetensors".into();
                Ok(())
            }).unwrap();
            if enabled {
                assert_eq!(settings["slopfab"].options["latentUpscaler"], ProviderOption::String("/worker/upscaler.safetensors".into()));
            }
        }
    }

    #[test]
    fn generation_effects_roundtrip_without_machine_specific_paths() {
        let effects = serde_json::from_str(include_str!("../../../../fixtures/generation-effects.json")).unwrap();
        let mut request = GenerationRequest { negative_prompt: Some("watermark".into()), generation_effects: Some(effects), guidance_scale: Some(4.5), ..Default::default() };
        let mut settings = settings(&[]);
        visit_paths(&mut request, &mut settings, |_, _| panic!("Effects must not transfer calibration files")).unwrap();
        let restored: GenerationRequest = serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(restored.generation_effects, request.generation_effects);
        assert_eq!(restored.guidance_scale, Some(4.5));
        assert_eq!(restored.negative_prompt.as_deref(), Some("watermark"));
    }

    #[test]
    fn single_shot_roundtrip_keeps_ending_prompt_but_never_host_temporary_paths() {
        let request = GenerationRequest { single_shot: Some(crate::slopfab::SingleShotRequest {
            ending_prompt: "The subject waves goodbye".into(), ending_path: Some("C:/host/temporary.safetensors".into()),
        }), continuation_source_noise: Some(0.35), ..Default::default() };
        let wire = serde_json::to_string(&request).unwrap();
        assert!(!wire.contains("temporary.safetensors"));
        let restored: GenerationRequest = serde_json::from_str(&wire).unwrap();
        assert_eq!(restored.continuation_source_noise, Some(0.35));
        let single = restored.single_shot.unwrap();
        assert_eq!(single.ending_prompt, "The subject waves goodbye");
        assert!(single.ending_path.is_none());
        assert_eq!(PROTOCOL_VERSION, 21);
    }

    #[test]
    fn moss_tokenizer_is_transferred_as_a_file_instead_of_a_folder() {
        let mut settings = settings(&[("modelType", "moss"), ("tokenizer", "C:/weights/tokenizer.json")]);
        let mut request = GenerationRequest::default();
        visit_paths(&mut request, &mut settings, |kind, path| {
            assert_eq!(kind, PathKind::Model);
            assert_eq!(path, "C:/weights/tokenizer.json");
            *path = file_token(0);
            Ok(())
        }).unwrap();
        assert_eq!(settings["slopfab"].options["modelType"], ProviderOption::String("moss".into()));
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
