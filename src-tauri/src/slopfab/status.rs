use super::{config::Configuration, ffi, platform::*, types::*};
use crate::project::ProviderSetting;
use std::{collections::BTreeMap, path::Path};

fn model_statuses(configuration: &Configuration, available: impl Fn(&Path) -> bool) -> Vec<ModelStatus> {
    let mut models = configuration
        .models
        .iter()
        .filter(|(id, _, _)| !configuration.animate || (*id != 1 && *id != 2))
        .map(|(_, id, path)| ModelStatus {
            id,
            configured: path.is_some(),
            available: path.as_deref().is_some_and(&available),
            path: path
                .as_ref()
                .map(|value| value.to_string_lossy().into_owned()),
        })
        .collect::<Vec<_>>();
    if configuration.animate {
        models.push(ModelStatus {
            id: "promptEmbedding",
            configured: configuration.prompt_embedding.is_some(),
            available: configuration
                .prompt_embedding
                .as_deref()
                .is_some_and(&available),
            path: configuration
                .prompt_embedding
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
        });
    }
    models
}

pub fn status(settings: &BTreeMap<String, ProviderSetting>) -> SlopfabStatus {
    let configuration = Configuration::from_settings(settings);
    let models = model_statuses(&configuration, Path::is_file);
    let dll_path = configuration.dll_path.to_string_lossy().into_owned();
    match ffi::Api::load(&configuration.dll_path) {
        Ok(api) => match api.version() {
            Ok(version) => {
                let detected = detect_platform(&api);
                let platform = configuration.platform(detected);
                let missing = models
                    .iter()
                    .filter(|model| !model.available && model.id != "tokenizer")
                    .count();
                SlopfabStatus {
                    state: if missing == 0 {
                        "ready"
                    } else {
                        "modelsMissing"
                    },
                    dll_path,
                    version: Some(version),
                    platform: Some(platform.label()),
                    cuda_available: detected != ComputePlatform::Vulkan,
                    cuda_device_names: ffi::cuda_device_names(),
                    detail: if missing == 0 {
                        "Runtime and required model paths are available.".into()
                    } else {
                        format!("Runtime loaded; {missing} required model paths are missing. Editing remains available.")
                    },
                    models,
                }
            }
            Err(error) => SlopfabStatus {
                state: "incompatible",
                dll_path,
                version: None,
                platform: None,
                cuda_available: false,
                cuda_device_names: Vec::new(),
                detail: error,
                models,
            },
        },
        Err(error) => SlopfabStatus {
            state: "runtimeMissing",
            dll_path,
            version: None,
            platform: None,
            cuda_available: false,
            cuda_device_names: Vec::new(),
            detail: format!("slopfab is unavailable: {error}. Editing remains available."),
            models,
        },
    }
}

/// Status for generation on a LAN worker. The worker reports its own engine;
/// a model counts as available when this computer can upload it or the
/// worker can download it.
pub fn worker_status(
    settings: &BTreeMap<String, ProviderSetting>,
    runtime: &crate::worker::WorkerRuntime,
    location: String,
) -> SlopfabStatus {
    let configuration = Configuration::from_settings(settings);
    let models = model_statuses(&configuration, |path| {
        let value = path.to_string_lossy();
        value.starts_with("https://") || value.starts_with("http://") || path.exists()
    });
    let missing = models.iter().filter(|model| !model.available && model.id != "tokenizer").count();
    let state = match runtime.state.as_str() {
        "ready" if missing == 0 => "ready",
        "ready" => "modelsMissing",
        "incompatible" => "incompatible",
        _ => "runtimeMissing",
    };
    SlopfabStatus {
        state,
        dll_path: location,
        version: runtime.version.clone(),
        platform: ["CUDA 13", "CUDA 12", "Vulkan"].into_iter().find(|label| runtime.platform.as_deref() == Some(*label)),
        cuda_available: runtime.cuda_available,
        cuda_device_names: runtime.cuda_device_names.clone(),
        detail: match state {
            "ready" => "The worker is ready. Missing weights download on the worker; local files are sent to it.".into(),
            "modelsMissing" => format!("The worker is ready; {missing} required model paths are not set or not found."),
            _ => runtime.detail.clone(),
        },
        models,
    }
}
