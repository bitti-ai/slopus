use super::ffi;
use super::types::{JobEvent, ProgressEvent};
use crate::diagnostics;
use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};

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
    let throttle = Mutex::new(ProgressThrottle::default());
    Box::new(move |progress| {
        // Music polls between model blocks for cancellation, often thousands of
        // times per second. Bound logging and IPC before they reach the UI; the
        // native callbacks and the separate cancellation checks still run.
        if !throttle.lock().unwrap_or_else(|error| error.into_inner()).accept(progress, Instant::now()) {
            return;
        }
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

#[derive(Default)]
struct ProgressThrottle {
    last: Option<(Instant, i32, i32, i32)>,
}

impl ProgressThrottle {
    fn accept(&mut self, progress: &ffi::Progress, now: Instant) -> bool {
        if let Some((sent, stage, step, total)) = self.last {
            // Native step indices are zero-based. Forward a newly completed
            // stage immediately, but do not let its repeated heartbeats bypass
            // the limit. Stage transitions also remain immediate.
            let completed = progress.total_steps > 0 && progress.step >= progress.total_steps - 1
                && (progress.step != step || progress.total_steps != total);
            if progress.stage == stage && !completed && now.duration_since(sent) < Duration::from_millis(100) {
                return false;
            }
        }
        self.last = Some((now, progress.stage, progress.step, progress.total_steps));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(stage: i32, step: i32, total_steps: i32) -> ffi::Progress {
        ffi::Progress { stage, step, total_steps, elapsed_seconds: 0.0 }
    }

    #[test]
    fn bounds_heartbeats_and_advancing_tokens_using_wall_time() {
        let mut throttle = ProgressThrottle::default();
        let start = Instant::now();
        let mut sent = Vec::new();
        for tick in 0..10_000 {
            let mut event = progress(2, tick / 3, 4096);
            // Native elapsed time is metadata, not the rate-limit clock.
            event.elapsed_seconds = tick as f64;
            if throttle.accept(&event, start + Duration::from_micros(tick as u64 * 100)) {
                sent.push(event.step);
            }
        }
        assert_eq!(sent.len(), 10);
        assert_eq!(sent[0], 0);
        assert_eq!(sent[9], 3000);
    }

    #[test]
    fn forwards_stage_changes_and_completion_without_replaying_final_heartbeats() {
        let mut throttle = ProgressThrottle::default();
        let now = Instant::now();
        assert!(throttle.accept(&progress(2, -1, 4096), now));
        assert!(!throttle.accept(&progress(2, 8, 4096), now));
        // EOS can revise the total before the last token is reported.
        assert!(throttle.accept(&progress(2, 8, 9), now));
        assert!(!throttle.accept(&progress(2, 8, 9), now));
        assert!(throttle.accept(&progress(4, -1, 32), now));
        assert!(!throttle.accept(&progress(4, 0, 32), now));
        assert!(throttle.accept(&progress(4, 31, 32), now));
        assert!(!throttle.accept(&progress(4, 31, 32), now));
        assert!(throttle.accept(&progress(6, 0, 0), now));
        assert!(throttle.accept(&progress(7, 0, 0), now));
        assert!(throttle.accept(&progress(8, 0, 0), now));
    }

    #[test]
    fn sinks_preserve_metadata_and_do_not_throttle_other_generations() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let capture = received.clone();
        let events: EventSink = Arc::new(move |event| {
            if let NativeEvent::Progress(event) = event { capture.lock().unwrap().push(event); }
        });
        let make_sink = |job_id: &str| progress_sink(CallbackContext {
            events: events.clone(), job_id: job_id.into(), frames: 0,
            canvas_width: 0, canvas_height: 0, reference_count: 0,
            timing_profile: "music".into(), planned_steps: 32,
        });
        let first = make_sink("first");
        let second = make_sink("second");
        first(&progress(2, -1, 4096));
        second(&progress(2, -1, 4096));
        first(&progress(8, 0, 0));
        let received = received.lock().unwrap();
        assert_eq!(received.len(), 3);
        assert_eq!(received[0].job_id, "first");
        assert_eq!(received[1].job_id, "second");
        assert_eq!(received[2].stage, "finished");
        assert_eq!(received[0].planned_steps, 32);
        assert_eq!(received[0].timing_profile, "music");
    }
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
