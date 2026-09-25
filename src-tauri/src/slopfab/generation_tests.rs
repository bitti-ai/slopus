use super::*;
use crate::slopfab::{config::Configuration, events::NativeEvent, references::ReferenceVideos, types::{GenerationRequest, ProgressEvent}};
use std::sync::{Arc, Mutex, atomic::AtomicBool};

struct Pixels(u8);
impl rendered::FrameSource for Pixels {
    fn frame_rgba(&self, _: u32, _: u32, _: u32) -> Result<Vec<u8>, String> { Ok(vec![self.0, 20, 30, 255]) }
}
fn result(value: u8) -> (OutputMetadata, rendered::RenderedVideo) {
    let metadata = OutputMetadata { frames: 1, width: 1, height: 1, fps: 1.0, audio_channels: 0, audio_sample_rate: 0, audio_samples: 0,
        reference_count: 0, timing_profile: "test".into(), seconds_conditioning: 0.0, seconds_denoise: 1.0, seconds_video_decode: 0.0,
        seconds_audio_decode: 0.0, seconds_total: 1.0, steps_computed: 2, steps_skipped: 0, duration_seconds: 1.0, boundary: "test" };
    (metadata, rendered::from_source("edit", Box::new(Pixels(value)), vec![], 1, 1, 1, 3, 3, 1.0, 0, 0).unwrap())
}
fn item() -> QueueItem {
    let request: GenerationRequest = serde_json::from_value(serde_json::json!({
        "jobId":"edit", "prompt":"first", "frames":1, "stillImage":true, "steps":2, "seed":1, "canvasWidth":1, "canvasHeight":1,
        "imageEdit":{"sourceRelativePath":"media/source.png","edits":[
            {"prompt":"first","x":0,"y":0,"width":1,"height":1},
            {"prompt":"second","x":0,"y":0,"width":1,"height":1}
        ]}
    })).unwrap();
    QueueItem { request, configuration: Configuration::from_settings(&Default::default()), references: ReferenceVideos::default(),
        events: Arc::new(|_| {}), cancel: Arc::new(AtomicBool::new(false)) }
}

#[test]
fn sequential_image_edits_feed_previous_pixels_and_report_combined_progress() {
    let mut item = item();
    let progress = Arc::new(Mutex::new(Vec::new()));
    let sink = progress.clone();
    item.events = Arc::new(move |event| { if let NativeEvent::Progress(event) = event { sink.lock().unwrap().push(event); } });
    let mut calls = 0;
    let (metadata, output) = run_edit_sequence(&item, |stage| {
        calls += 1;
        assert_eq!(stage.request.image_edit.as_ref().unwrap().edits.len(), 1);
        if calls == 1 {
            assert_eq!(stage.request.prompt, "first");
            assert!(stage.request.image_edit_pixels.is_none());
        } else {
            assert_eq!(stage.request.prompt, "second");
            assert_eq!(stage.request.image_edit_pixels.as_ref().unwrap().as_slice(), &[1, 20, 30]);
        }
        (stage.events)(NativeEvent::Progress(ProgressEvent { job_id: "edit".into(), stage: "denoising", step: 2, total_steps: 2,
            planned_steps: 2, elapsed_seconds: 1.0, frames: 1, canvas_width: 1, canvas_height: 1, reference_count: 0, timing_profile: "test".into() }));
        Ok(result(calls))
    }).unwrap();
    assert_eq!(calls, 2);
    assert_eq!(output.frame(0).unwrap().unwrap(), [2, 20, 30, 255]);
    assert_eq!(metadata.seconds_total, 2.0);
    assert_eq!(metadata.steps_computed, 4);
    let progress = progress.lock().unwrap();
    assert_eq!((progress[0].step, progress[1].step, progress[1].total_steps), (2, 4, 4));
    assert_eq!(progress[1].elapsed_seconds, 2.0);
}

#[test]
fn cancellation_and_failures_do_not_publish_partial_image_edits() {
    for cancel in [false, true] {
        let item = item();
        let mut calls = 0;
        let result = run_edit_sequence(&item, |_| {
            calls += 1;
            if cancel { item.cancel.store(true, Ordering::Release); Ok(result(1)) }
            else { Err("inpainting failed".into()) }
        });
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }
}
