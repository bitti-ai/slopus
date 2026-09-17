use super::*;

pub type EventSink = Arc<dyn Fn(NativeEvent) + Send + Sync>;
pub enum NativeEvent { Job(JobEvent), Progress(ProgressEvent) }

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
        (context.events)(NativeEvent::Progress(
            ProgressEvent {
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
            },
        ));

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
        _ => "unknown",
    }
}
