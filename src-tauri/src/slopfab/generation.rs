use super::{
    events::{progress_sink, CallbackContext},
    ffi::{self, RequestHandle},
    h3::configure_request,
    planning::{scene_audio_offset, scene_frame_window, RequestPurpose},
    platform::detect_platform,
    runtime::QueueItem,
    types::OutputMetadata,
};
use crate::{diagnostics, rendered};
use std::sync::atomic::Ordering;

struct FrameSource {
    generation: ffi::FinishedGeneration,
    frame_offset: u32,
}
impl rendered::FrameSource for FrameSource {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let index = index
            .checked_add(self.frame_offset)
            .ok_or("Continuation frame index overflow.")?;
        self.generation.frame_rgba8(index, width, height)
    }
}

pub(super) fn run_generation(
    item: &QueueItem,
) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
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
    api.resolve(&request)?;
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
        planned_steps: (item.request.steps - 1).max(0),
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
    let (frame_offset, frames) = scene_frame_window(&item.request, output.frames)?;
    let source = Box::new(FrameSource {
        generation,
        frame_offset: frame_offset as u32,
    });
    let audio_offset = scene_audio_offset(
        frame_offset,
        output.fps,
        output.audio_channels,
        output.audio_sample_rate,
        output.audio.len(),
    )?;
    let mut audio = output.audio;
    audio.drain(..audio_offset);
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
        boundary: "Latents are saved in the project. Decoded buffers remain owned by slopfab; the webview encodes the new scene's frames on demand.",
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
