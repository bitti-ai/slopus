use super::{
    config::Configuration,
    ffi::{self, RequestHandle},
    h3::configure_request,
    planning::RequestPurpose,
    platform::*,
    references::ReferenceVideos,
    types::GenerationRequest,
};
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIconSpec {
    pub id: String,
    pub prompt: String,
    pub seed: u64,
    pub destination: PathBuf,
}

#[derive(Debug)]
pub struct ReferenceIconBatchConfig {
    pub dll_path: PathBuf,
    pub transformer: PathBuf,
    pub text_encoder: PathBuf,
    pub video_vae: PathBuf,
    pub backend: String,
}

pub(super) fn write_reference_icon(
    api: &ffi::Api,
    configuration: &Configuration,
    platform: ComputePlatform,
    spec: &ReferenceIconSpec,
) -> Result<(), String> {
    let request = GenerationRequest {
        job_id: spec.id.clone(),
        prompt: spec.prompt.clone(),
        frames: 1,
        still_image: true,
        steps: crate::reference_icons::STEPS,
        seed: i64::try_from(spec.seed)
            .map_err(|_| format!("Icon '{}' seed is too large.", spec.id))?,
        canvas_width: crate::reference_icons::RENDER_SIZE as i32,
        canvas_height: crate::reference_icons::RENDER_SIZE as i32,
        reference_paths: Vec::new(),
        refmods: Vec::new(),
        reference_video_ids: Vec::new(),
        ..Default::default()
    };
    let handle = RequestHandle::new(api)?;
    configure_request(
        api,
        &handle,
        &request,
        configuration,
        platform,
        RequestPurpose::Generate,
        &ReferenceVideos::default(),
    )?;
    api.resolve(&handle)?;
    let mut generation = handle.start(None)?;
    while !generation
        .wait(-1)
        .map_err(|error| format!("Icon '{}': {error}", spec.id))?
    {}
    let generation = generation.finish()?;
    let output = generation.output()?;
    let render_size = crate::reference_icons::RENDER_SIZE;
    if output.width != render_size as i32
        || output.height != render_size as i32
        || output.frames != 1
    {
        return Err(format!(
            "Icon '{}' returned {}x{} with {} frames.",
            spec.id, output.width, output.height, output.frames
        ));
    }
    let rgba = generation.frame_rgba8(0, render_size, render_size)?;
    let jpeg = crate::reference_icons::encode_jpeg(&rgba)?;
    if let Some(parent) = spec.destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create icon folder '{}': {error}",
                parent.display()
            )
        })?;
    }
    std::fs::write(&spec.destination, jpeg).map_err(|error| {
        format!(
            "Could not create icon '{}': {error}",
            spec.destination.display()
        )
    })
}

pub fn generate_reference_icon_batch(
    specs: &[ReferenceIconSpec],
    batch: &ReferenceIconBatchConfig,
) -> Result<(), String> {
    let backend = match batch.backend.as_str() {
        "cuda" => ComputePlatform::Cuda13,
        "vulkan" => ComputePlatform::Vulkan,
        value => return Err(format!("Unsupported icon generation backend '{value}'.")),
    };
    let configuration = Configuration {
        dll_path: batch.dll_path.clone(),
        loras: Ok(Vec::new()),
        step_override: Ok(None),
        vulkan: backend == ComputePlatform::Vulkan,
        attention: "sage2",
        motion_cache: false,
        animate: false,
        prompt_embedding: None,
        models: [
            (0, "transformer", Some(batch.transformer.clone())),
            (1, "textEncoder", Some(batch.text_encoder.clone())),
            (2, "tokenizer", None),
            (3, "videoVae", Some(batch.video_vae.clone())),
            // Icons keep one picture and need no decoded soundtrack.
            (4, "audioVae", None),
        ],
    };
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    let platform = if backend == ComputePlatform::Cuda13 {
        detect_platform(&api)
    } else {
        backend
    };
    let result = specs.iter().enumerate().try_for_each(|(index, spec)| {
        let started = std::time::Instant::now();
        write_reference_icon(&api, &configuration, platform, spec)?;
        println!(
            "[{}/{}] {}: generated in {:.1}s",
            index + 1,
            specs.len(),
            spec.id,
            started.elapsed().as_secs_f64()
        );
        Ok(())
    });
    let cleared = api.clear_reused_models();
    result.and(cleared)
}
