use super::*;
use crate::slopfab::{config::Configuration, events::NativeEvent, references::ReferenceVideos, types::{GenerationRequest, ProgressEvent}};
use std::sync::{Arc, Mutex, atomic::AtomicBool};

struct Pixels(u8);
impl rendered::FrameSource for Pixels {
    fn frame_rgba(&self, _: u32, _: u32, _: u32) -> Result<Vec<u8>, String> { Ok(vec![self.0, 20, 30, 255]) }
}

#[test]
fn continuation_handoff_keeps_every_joined_frame_and_audio_sample() {
    struct IndexedFrames;
    impl rendered::FrameSource for IndexedFrames {
        fn frame_rgba(&self, index: u32, _: u32, _: u32) -> Result<Vec<u8>, String> { Ok(vec![index as u8, 0, 0, 255]) }
    }
    let mut item = item();
    item.request.frames = 119;
    item.request.continuation_path = Some("source.safetensors".into());
    item.request.image_edit = None;
    let audio: Vec<f32> = (0..486).map(|n| n as f32).collect();
    let expected_audio: Vec<u8> = audio.iter().flat_map(|n| n.to_le_bytes()).collect();
    let output = ffi::Output { frames: 243, video_float_count: 243 * 3, width: 1, height: 1, channels: 3,
        fps: 24.0, audio, audio_channels: 2, audio_sample_rate: 24, seconds_conditioning: 0.0, seconds_denoise: 0.0,
        seconds_video_decode: 0.0, seconds_audio_decode: 0.0, seconds_total: 0.0, steps_computed: 2, steps_skipped: 0 };
    let (metadata, video) = collect_output(&item, output, Box::new(IndexedFrames), "test".into()).unwrap();
    assert_eq!(metadata.frames, 243);
    assert_eq!(metadata.audio_samples, 486);
    assert_eq!(video.frame_count, 243);
    for index in [0, 123, 124, 242] { assert_eq!(video.frame(index).unwrap().unwrap()[0], index as u8); }
    assert_eq!(video.audio_bytes(), expected_audio);
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
fn image_edits_use_their_own_reference_pictures_and_refmods() {
    let mut item = item();
    item.request.reference_paths = vec!["legacy.png".into()];
    item.request.refmods = vec![serde_json::from_value(serde_json::json!({"path":"legacy.safetensors","strength":1.0,"copies":1})).unwrap()];
    let steps = &mut item.request.image_edit.as_mut().unwrap().edits;
    steps[0].reference_paths = Some(vec!["source.png".into(), "balloon.png".into()]);
    steps[0].refmods = Some(vec![serde_json::from_value(serde_json::json!({"path":"balloon.safetensors","strength":0.75,"copies":2})).unwrap()]);
    steps[1].reference_paths = Some(vec!["source.png".into()]);
    steps[1].refmods = Some(vec![]);
    let mut calls = 0;
    run_edit_sequence(&item, |stage| {
        calls += 1;
        if calls == 1 {
            assert_eq!(stage.request.reference_paths, ["source.png", "balloon.png"]);
            assert_eq!(stage.request.refmods[0].path, "balloon.safetensors");
            assert_eq!(stage.request.refmods[0].strength, 0.75);
            assert_eq!(stage.request.refmods[0].copies, 2);
        } else {
            assert_eq!(stage.request.reference_paths, ["source.png"]);
            assert!(stage.request.refmods.is_empty());
            assert!(stage.request.image_edit_pixels.is_some());
        }
        Ok(result(calls))
    }).unwrap();
    assert_eq!(calls, 2);
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
