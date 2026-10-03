use super::{
    events::{progress_sink, CallbackContext},
    ffi::{self, RequestHandle},
    h3::configure_request,
    planning::{scene_frame_window, RequestPurpose},
    platform::detect_platform,
    runtime::QueueItem,
    types::OutputMetadata,
};
use crate::{diagnostics, rendered};
use std::sync::atomic::Ordering;

#[cfg(test)]
#[path = "generation_tests.rs"]
mod tests;

struct FrameSource {
    generation: ffi::FinishedGeneration,
}
impl rendered::FrameSource for FrameSource {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.generation.frame_rgba8(index, width, height)
    }
}

pub(super) fn run_generation(
    item: &QueueItem,
) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    run_edit_sequence(item, run_single_generation)
}

fn run_edit_sequence(
    item: &QueueItem,
    mut generate: impl FnMut(&QueueItem) -> Result<(OutputMetadata, rendered::RenderedVideo), String>,
) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    let Some(edit) = &item.request.image_edit else { return generate(item); };
    let count = edit.edits.len();
    let mut pixels = None;
    let mut elapsed = 0.0;
    let mut computed = 0;
    let mut skipped = 0;
    for (index, step) in edit.edits.iter().enumerate() {
        if item.cancel.load(Ordering::Acquire) { return Err("Image editing cancelled.".into()); }
        let mut request = item.request.clone();
        request.prompt = step.prompt.clone();
        if let Some(paths) = &step.reference_paths { request.reference_paths = paths.clone(); }
        if let Some(refmods) = &step.refmods { request.refmods = refmods.clone(); }
        request.image_edit.as_mut().unwrap().edits = vec![step.clone()];
        request.image_edit_pixels = pixels.take();
        let sink = item.events.clone();
        let offset = elapsed;
        let stage = QueueItem {
            request, configuration: item.configuration.clone(), references: item.references.clone(), cancel: item.cancel.clone(),
            events: std::sync::Arc::new(move |event| {
                let event = match event {
                    super::events::NativeEvent::Progress(mut progress) => {
                        let per_edit = progress.planned_steps.max(1);
                        progress.step = index as i32 * per_edit + progress.step.clamp(0, per_edit);
                        progress.total_steps = per_edit * count as i32;
                        progress.planned_steps = progress.total_steps;
                        progress.elapsed_seconds += offset;
                        progress.timing_profile.push_str(&format!("|imageEdits={count}"));
                        super::events::NativeEvent::Progress(progress)
                    }
                    event => event,
                };
                sink(event);
            }),
        };
        let (mut metadata, result) = generate(&stage)?;
        if item.cancel.load(Ordering::Acquire) { return Err("Image editing cancelled.".into()); }
        elapsed += metadata.seconds_total;
        computed += metadata.steps_computed;
        skipped += metadata.steps_skipped;
        if index + 1 == count {
            metadata.seconds_total = elapsed;
            metadata.steps_computed = computed;
            metadata.steps_skipped = skipped;
            metadata.timing_profile.push_str(&format!("|imageEdits={count}"));
            return Ok((metadata, result));
        }
        let rgba = result.frame(0)?.ok_or("Image edit returned no pixels.")?;
        // Copy only the completed still, then release its generation before
        // starting the next edit. No intermediate file or lossy encode.
        pixels = Some(std::sync::Arc::new(rgba.chunks_exact(4).flat_map(|pixel| pixel[..3].iter().copied()).collect()));
    }
    Err("Add an image edit before generating.".into())
}

fn run_single_generation(
    item: &QueueItem,
) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    let _models = super::MODEL_ACCESS
        .read()
        .map_err(|_| "Model access lock failed.")?;
    if item.cancel.load(Ordering::Acquire) {
        return Err("Generation was cancelled before it started.".into());
    }
    let api = ffi::Api::load(&item.configuration.dll_path)?;
    let version = api.version()?;
    let platform = item.configuration.platform(detect_platform(&api));
    let timing_profile = item.configuration.timing_profile(&version, platform);
    diagnostics::debug(
        "slopfab",
        "generation.runtime_ready",
        "slopfab runtime loaded.",
        serde_json::json!({
            "jobId": item.request.job_id, "version": version, "platform": platform.label(),
        }),
    );
    let request = RequestHandle::new(&api)?;
    configure_request(
        &api,
        &request,
        &item.request,
        &item.configuration,
        platform,
        RequestPurpose::Generate,
        &item.references,
    )?;
    let plan = api.resolve(&request)?;
    diagnostics::debug(
        "slopfab",
        "generation.request_resolved",
        "slopfab resolved the generation request.",
        serde_json::json!({ "jobId": item.request.job_id }),
    );
    let context = CallbackContext {
        events: item.events.clone(),
        job_id: item.request.job_id.clone(),
        frames: item.request.frames,
        canvas_width: item.request.canvas_width,
        canvas_height: item.request.canvas_height,
        reference_count: item.request.reference_count(),
        timing_profile: timing_profile.clone(),
        planned_steps: plan.num_model_evaluations,
    };
    let mut generation = request.start(Some(progress_sink(context)))?;
    diagnostics::debug(
        "slopfab",
        "generation.api_started",
        "slopfab accepted the generation request.",
        serde_json::json!({ "jobId": item.request.job_id }),
    );
    loop {
        if item.cancel.load(Ordering::Acquire) {
            generation.cancel();
        }
        if generation.wait(100)? {
            break;
        }
    }
    let generation = generation.finish()?;
    let output = generation.output()?;
    let source = Box::new(FrameSource { generation });
    collect_output(item, output, source, timing_profile)
}

fn collect_output(item: &QueueItem, output: ffi::Output, source: Box<dyn rendered::FrameSource>, timing_profile: String) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    let (_, frames) = scene_frame_window(&item.request, output.frames)?;
    // The VAE decoded both sides of the boundary together. Keep that complete
    // output, including the source-side pixels and soundtrack near the join.
    let audio = output.audio;
    let metadata = OutputMetadata {
        frames, width: output.width, height: output.height, fps: output.fps,
        audio_channels: output.audio_channels, audio_sample_rate: output.audio_sample_rate,
        audio_samples: audio.len(),
        reference_count: item.request.reference_count(),
        timing_profile,
        seconds_conditioning: output.seconds_conditioning,
        seconds_denoise: output.seconds_denoise,
        seconds_video_decode: output.seconds_video_decode,
        seconds_audio_decode: output.seconds_audio_decode,
        seconds_total: output.seconds_total,
        steps_computed: output.steps_computed,
        steps_skipped: output.steps_skipped,
        duration_seconds: if output.fps > 0.0 {
            frames as f64 / output.fps
        } else {
            0.0
        },
        boundary: "Latents are saved in the project. Decoded buffers remain owned by slopfab; the webview encodes the full joined video and audio on demand.",
    };
    let pictures = rendered::from_source(
        &item.request.job_id,
        source,
        audio,
        frames as u32,
        output.width.max(0) as u32,
        output.height.max(0) as u32,
        output.channels.max(0) as u32,
        output.video_float_count,
        output.fps,
        output.audio_channels.max(0) as u32,
        output.audio_sample_rate.max(0) as u32,
    )?;
    Ok((metadata, pictures))
}
