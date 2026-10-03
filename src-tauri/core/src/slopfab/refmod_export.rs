//! Encodes a reference's raw images, video and sound into a RefMod file.
use super::{
    config::Configuration,
    ffi::{self, RequestHandle},
    h3::attach_references,
    platform::detect_platform,
    references::ReferenceVideos,
    types::GenerationRequest,
};
use crate::settings::ProviderSetting;
use std::{collections::BTreeMap, path::Path};

pub fn export_refmod(
    request: &GenerationRequest,
    settings: &BTreeMap<String, ProviderSetting>,
    references: &ReferenceVideos,
    output: &Path,
    name: &str,
    description: &str,
) -> Result<(), String> {
    if request.reference_count() == 0 {
        return Err("Add an image, video or sound to export a refmod.".into());
    }
    let _models = super::MODEL_ACCESS
        .read()
        .map_err(|_| "Model access lock failed.")?;
    let configuration = Configuration::from_settings(settings);
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    export_with(&api, request, &configuration, references, output, name, description)
}

pub(super) fn export_with(
    api: &ffi::Api,
    request: &GenerationRequest,
    configuration: &Configuration,
    references: &ReferenceVideos,
    output: &Path,
    name: &str,
    description: &str,
) -> Result<(), String> {
    let platform = configuration.platform(detect_platform(api));
    let handle = RequestHandle::new(api)?;
    api.set_inference_backend(&handle, platform.backend())?;
    // Only the video and audio VAEs encode references.
    for (id, _, path) in &configuration.models[3..] {
        if let Some(path) = path {
            api.set_model(&handle, *id, path)?;
        }
    }
    attach_references(api, &handle, request, configuration, references)?;
    api.export_refmod(&handle, output, name, description)
}
