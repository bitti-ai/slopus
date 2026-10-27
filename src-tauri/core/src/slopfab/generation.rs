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
    if item.request.single_shot.is_some() {
        ffi::Api::load(&item.configuration.dll_path)?.require_end_anchor()?;
        return run_single_shot(item, run_single_generation);
    }
    run_edit_sequence(item, run_single_generation)
}

fn run_single_shot(
    item: &QueueItem,
    mut generate: impl FnMut(&QueueItem) -> Result<(OutputMetadata, rendered::RenderedVideo), String>,
) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    let single = item.request.single_shot.as_ref().ok_or("Missing Single Shot settings.")?;
    if item.cancel.load(Ordering::Acquire) { return Err("Single Shot generation cancelled.".into()); }
    let temporary = tempfile::tempdir().map_err(|error| format!("Could not prepare ending latents: {error}"))?;
    let ending_path = temporary.path().join("ending.safetensors");
    // Condition the ending on the same source as the full shot. An independent
    // ending can force a cut to an unrelated subject/scene despite a locked start.
    // Only its tail is needed here; avoid decoding the entire previous chain.
    let starting_tail = item.request.continuation_path.as_deref()
        .map(|path| super::continuation::tail_archive(path, 22)).transpose()?;
    let mut ending_tail = None;
    let mut elapsed = 0.0;
    let mut timings = [0.0; 4];
    let mut computed = 0;
    let mut skipped = 0;
    for index in 0..2 {
        if item.cancel.load(Ordering::Acquire) { return Err("Single Shot generation cancelled.".into()); }
        let mut request = item.request.clone();
        // Clear legacy source initialization before removing single_shot for
        // the ending pass. Both passes use fresh noise between fixed anchors.
        request.continuation_source_noise = None;
        if index == 0 {
            request.single_shot = None;
            request.prompt = single.ending_prompt.clone();
            request.frames = 22;
            request.continuation_relative_path = None;
            request.continuation_path = starting_tail.as_ref().map(|path| path.to_path_buf());
            request.continuation_source_frames = starting_tail.as_ref().map(|_| 22);
            request.continuation_overlap_frames = starting_tail.as_ref().map(|_| 22);
            request.continuation_from = starting_tail.as_ref().map(|_| "end".into());
            request.continuation_lock_overlap = starting_tail.is_some();
            request.save_latents_path = Some(ending_path.clone());
        } else {
            request.single_shot.as_mut().unwrap().ending_path = Some(ending_tail.as_ref()
                .map_or_else(|| ending_path.clone(), |path: &tempfile::TempPath| path.to_path_buf()));
        }
        let sink = item.events.clone();
        let offset = elapsed;
        let stage = QueueItem { request, configuration: item.configuration.clone(), references: item.references.clone(), cancel: item.cancel.clone(),
            events: std::sync::Arc::new(move |event| {
                let event = match event {
                    super::events::NativeEvent::Progress(mut progress) => {
                        let steps = progress.planned_steps.max(1);
                        progress.step = index * steps + progress.step.clamp(0, steps);
                        progress.total_steps = steps * 2;
                        progress.planned_steps = progress.total_steps;
                        progress.elapsed_seconds += offset;
                        progress.stage = if index == 0 { "singleShotEnding" } else { "singleShotFull" };
                        progress.timing_profile.push_str("|singleShot=2");
                        super::events::NativeEvent::Progress(progress)
                    }
                    event => event,
                };
                sink(event);
            }),
        };
        let (mut metadata, result) = generate(&stage)?;
        if item.cancel.load(Ordering::Acquire) { return Err("Single Shot generation cancelled.".into()); }
        elapsed += metadata.seconds_total;
        timings[0] += metadata.seconds_conditioning;
        timings[1] += metadata.seconds_denoise;
        timings[2] += metadata.seconds_video_decode;
        timings[3] += metadata.seconds_audio_decode;
        computed += metadata.steps_computed;
        skipped += metadata.steps_skipped;
        if index == 1 {
            metadata.seconds_total = elapsed;
            metadata.seconds_conditioning = timings[0]; metadata.seconds_denoise = timings[1];
            metadata.seconds_video_decode = timings[2]; metadata.seconds_audio_decode = timings[3];
            metadata.steps_computed = computed; metadata.steps_skipped = skipped;
            metadata.timing_profile.push_str("|singleShot=2");
            return Ok((metadata, result));
        }
        // The ending is only an anchor, never a separate scene/history result.
        // Release its decoded buffers before allocating the full generation.
        drop(result);
        if !ending_path.is_file() { return Err("The ending generation did not save its latents.".into()); }
        if starting_tail.is_some() {
            // Continuation saves the joined source + generated clip. Anchor only
            // its generated ending, never the retained source at its beginning.
            ending_tail = Some(super::continuation::tail_archive(&ending_path, 22)?);
        }
    }
    unreachable!()
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
                    super::events::NativeEvent::Progress(mut progress) if progress.stage != "calibrating" => {
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
    let effects_active = super::lcs::prepare(&api, &request, item, platform)?;
    let plan = api.resolve(&request)?;
    if effects_active {
        if let Some(mask) = item.request.generation_effects.as_ref().unwrap().mask(plan.latent_width / 2, plan.latent_height / 2)? {
            api.set_lcs_mask(&request, &mask)?;
        }
    }
    if item.cancel.load(Ordering::Acquire) { return Err("Generation cancelled.".into()); }
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
    // Diagnostics must never turn a successfully generated image into a failure.
    match generation.video_decode_timings() {
        Ok(Some(timings)) => diagnostics::info("slopfab", "generation.video_decode", "VAE decode timing breakdown.", serde_json::json!({
            "jobId": item.request.job_id, "backend": platform.label(), "runtimeVersion": version,
            "stillImage": item.request.still_image, "width": output.width, "height": output.height, "frames": output.frames,
            "secondsTotal": output.seconds_video_decode, "timings": timings,
        })),
        Ok(None) => {}, // Older runtimes keep their aggregate decode timing.
        Err(error) => diagnostics::warn("slopfab", "generation.decode_timing_unavailable", &error, serde_json::json!({ "jobId": item.request.job_id })),
    }
    let source = Box::new(FrameSource { generation });
    collect_output(item, output, source, timing_profile)
}

fn collect_output(item: &QueueItem, output: ffi::Output, source: Box<dyn rendered::FrameSource>, timing_profile: String) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    let frames = if item.request.music.is_some() { 0 } else { scene_frame_window(&item.request, output.frames)?.1 };
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
        duration_seconds: if item.request.music.is_some() && output.audio_channels > 0 && output.audio_sample_rate > 0 {
            audio.len() as f64 / output.audio_channels as f64 / output.audio_sample_rate as f64
        } else if output.fps > 0.0 {
            frames as f64 / output.fps
        } else {
            0.0
        },
        boundary: if item.request.music.is_some() { "Music samples are ready to save as WAV." } else { "Latents are saved in the project. Decoded buffers remain owned by slopfab; the webview encodes the full joined video and audio on demand." },
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
