use super::*;

pub fn status(settings: &BTreeMap<String, ProviderSetting>) -> SlopfabStatus {
    let configuration = Configuration::from_settings(settings);
    let mut models = configuration
        .models
        .iter()
        .filter(|(id, _, _)| !configuration.animate || (*id != 1 && *id != 2))
        .map(|(_, id, path)| ModelStatus {
            id,
            configured: path.is_some(),
            available: path.as_deref().is_some_and(Path::is_file),
            path: path
                .as_ref()
                .map(|value| value.to_string_lossy().into_owned()),
        })
        .collect::<Vec<_>>();
    if configuration.animate {
        models.push(ModelStatus {
            id: "promptEmbedding", configured: configuration.prompt_embedding.is_some(),
            available: configuration.prompt_embedding.as_deref().is_some_and(Path::is_file),
            path: configuration.prompt_embedding.as_ref().map(|path| path.to_string_lossy().into_owned()),
        });
    }
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
