use super::ffi;
use super::types::{JobEvent, ProgressEvent};
use crate::diagnostics;
use std::sync::Arc;

pub type EventSink = Arc<dyn Fn(NativeEvent) + Send + Sync>;
pub enum NativeEvent {
    Job(JobEvent),
    Progress(ProgressEvent),
    Preview(super::types::PreviewEvent),
}

pub(super) fn preview_sink(events: EventSink, job_id: String) -> ffi::PreviewSink {
    Box::new(move |preview| {
        use base64::Engine;
        let mut frames = Vec::with_capacity(preview.frames as usize);
        for rgb in preview.rgb.chunks_exact(preview.width as usize * preview.height as usize * 3) {
            let mut jpeg = Vec::new();
            if jpeg_encoder::Encoder::new(&mut jpeg, 75).encode(rgb, preview.width as u16, preview.height as u16, jpeg_encoder::ColorType::Rgb).is_err() { return; }
            frames.push(base64::engine::general_purpose::STANDARD.encode(jpeg));
        }
        events(NativeEvent::Preview(super::types::PreviewEvent {
            job_id: job_id.clone(), step: preview.step, width: preview.width, height: preview.height,
            fps: preview.fps, frames,
        }));
    })
}

pub(super) struct CallbackContext {
    pub(super) events: EventSink,
    pub(super) job_id: String,
    pub(super) frames: i32,
    pub(super) canvas_width: i32,
    pub(super) canvas_height: i32,
    pub(super) reference_count: usize,
    pub(super) timing_profile: String,
    pub(super) planned_steps: i32,
}

pub(super) fn progress_sink(context: CallbackContext) -> ffi::ProgressSink {
    Box::new(move |progress| {
        diagnostics::debug(
            "slopfab",
            "generation.progress",
            "slopfab reported progress.",
            serde_json::json!({
                "jobId": context.job_id,
                "stage": stage_name(progress.stage),
                "step": progress.step,
                "totalSteps": progress.total_steps,
                "plannedSteps": context.planned_steps,
                "elapsedSeconds": progress.elapsed_seconds,
            }),
        );
        (context.events)(NativeEvent::Progress(ProgressEvent {
            job_id: context.job_id.clone(),
            stage: stage_name(progress.stage),
            step: progress.step,
            total_steps: progress.total_steps,
            planned_steps: context.planned_steps,
            elapsed_seconds: progress.elapsed_seconds,
            frames: context.frames,
            canvas_width: context.canvas_width,
            canvas_height: context.canvas_height,
            reference_count: context.reference_count,
            timing_profile: context.timing_profile.clone(),
        }));
    })
}
pub(super) fn stage_name(stage: i32) -> &'static str {
    match stage {
        0 => "starting",
        1 => "references",
        2 => "conditioning",
        3 => "transformerLoad",
        4 => "denoising",
        5 => "videoDecode",
        6 => "audioDecode",
        7 => "delivering",
        8 => "finished",
        9 => "upscaling",
        _ => "unknown",
    }
}
