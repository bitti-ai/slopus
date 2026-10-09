//! Exercise the Rust owners through a small C ABI fixture, without model inference.
use super::*;
use super::super::{Api as OwnedApi, RequestHandle};
use std::{cell::RefCell, sync::{Arc, Mutex}};

#[derive(Default)]
struct Trace {
    events: Vec<&'static str>,
    wait_status: i32,
    release_status: i32,
}
type SharedTrace = Arc<Mutex<Trace>>;
thread_local! {
    static TRACE: RefCell<Option<SharedTrace>> = const { RefCell::new(None) };
}
struct NativeGeneration {
    trace: SharedTrace,
    terminal: bool,
    samples: Vec<f32>,
}
unsafe extern "C" fn create_request() -> *mut Request {
    TRACE.with(|trace| Box::into_raw(Box::new(trace.borrow().as_ref().unwrap().clone())).cast())
}
unsafe extern "C" fn destroy_request(request: *mut Request) {
    let trace = unsafe { Box::from_raw(request.cast::<SharedTrace>()) };
    trace.lock().unwrap().events.push("request_destroy");
}
unsafe extern "C" fn start(request: *const Request, _: ProgressFn, _: *mut c_void, out: *mut *mut Generation) -> i32 {
    let trace = unsafe { &*request.cast::<SharedTrace>() }.clone();
    trace.lock().unwrap().events.push("start");
    unsafe { *out = Box::into_raw(Box::new(NativeGeneration { trace, terminal: false, samples: vec![0.5; 3] })).cast(); }
    0
}
unsafe extern "C" fn cancel(generation: *mut Generation) {
    let generation = unsafe { &mut *generation.cast::<NativeGeneration>() };
    generation.trace.lock().unwrap().events.push("cancel");
}
unsafe extern "C" fn wait(generation: *mut Generation, _: i32) -> i32 {
    let generation = unsafe { &mut *generation.cast::<NativeGeneration>() };
    let mut trace = generation.trace.lock().unwrap();
    trace.events.push("wait");
    generation.terminal = trace.wait_status != crate::slopfab::NOT_READY;
    trace.wait_status
}
unsafe extern "C" fn output(generation: *const Generation, out: *mut Output) -> i32 {
    let generation = unsafe { &*generation.cast::<NativeGeneration>() };
    generation.trace.lock().unwrap().events.push("output");
    let out = unsafe { &mut *out };
    out.video = generation.samples.as_ptr();
    out.video_float_count = generation.samples.len();
    out.channels = 3;
    out.width = 1;
    out.height = 1;
    out.frames = 1;
    0
}
unsafe extern "C" fn frame(generation: *const Generation, _: i32, dst: *mut u8, size: usize) -> i32 {
    let generation = unsafe { &*generation.cast::<NativeGeneration>() };
    generation.trace.lock().unwrap().events.push("frame");
    if generation.samples.is_empty() || size != 4 { return -1; }
    unsafe { std::ptr::copy_nonoverlapping([128, 128, 128, 255].as_ptr(), dst, 4); }
    0
}
unsafe extern "C" fn release(generation: *mut Generation) -> i32 {
    let generation = unsafe { &mut *generation.cast::<NativeGeneration>() };
    let mut trace = generation.trace.lock().unwrap();
    trace.events.push(if generation.terminal { "release" } else { "release_while_running" });
    if trace.release_status == 0 { generation.samples = Vec::new(); }
    trace.release_status
}
unsafe extern "C" fn destroy(generation: *mut Generation) {
    let generation = unsafe { Box::from_raw(generation.cast::<NativeGeneration>()) };
    generation.trace.lock().unwrap().events.push("destroy");
}
unsafe extern "C" fn error(_: *const Generation) -> *const c_char { c"fixture failure".as_ptr() }

fn fixture(release_supported: bool) -> (OwnedApi, SharedTrace) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lib/slopfab").join(crate::slopfab::DLL_FILE_NAME);
    let mut raw = Api::load(&path).unwrap();
    raw.request_create = create_request;
    raw.request_destroy = destroy_request;
    raw.generation_start = start;
    raw.generation_wait = wait;
    raw.generation_cancel = cancel;
    raw.generation_output = output;
    raw.generation_video_decode_timings = None;
    raw.generation_frame_rgba8 = frame;
    raw.generation_error = error;
    raw.generation_release_samples = release_supported.then_some(release);
    raw.generation_destroy = destroy;
    let trace = SharedTrace::default();
    TRACE.with(|slot| *slot.borrow_mut() = Some(trace.clone()));
    (OwnedApi { inner: Arc::new(raw), path }, trace)
}

#[test]
fn completed_generations_keep_samples_until_consumed_then_release_and_destroy() {
    let (api, trace) = fixture(true);
    // Repeated generations must have matching destruction, with no request
    // snapshot or sample buffer retained by the Rust wrapper between runs.
    for _ in 0..20 {
        let mut generation = RequestHandle::new(&api).unwrap().start(None).unwrap();
        assert_eq!(trace.lock().unwrap().events, ["start", "request_destroy"]);
        generation.wait(-1).unwrap();
        let generation = generation.finish().unwrap();
        assert_eq!(generation.output().unwrap().video_float_count, 3);
        assert_eq!(generation.frame_rgba8(0, 1, 1).unwrap(), [128, 128, 128, 255]);
        drop(generation);
        assert_eq!(trace.lock().unwrap().events, ["start", "request_destroy", "wait", "output", "frame", "release", "destroy"]);
        trace.lock().unwrap().events.clear();
    }
}

#[test]
fn abandoned_generation_stops_before_releasing_samples_or_callback() {
    struct CallbackOwner(SharedTrace);
    impl Drop for CallbackOwner {
        fn drop(&mut self) { self.0.lock().unwrap().events.push("callback_drop"); }
    }
    let (api, trace) = fixture(true);
    trace.lock().unwrap().wait_status = crate::slopfab::CANCELLED;
    let owner = CallbackOwner(trace.clone());
    let sink = Box::new(move |_: &Progress| { let _ = &owner; });
    let generation = RequestHandle::new(&api).unwrap().start(Some(sink)).unwrap();
    drop(api); // The generation must retain the DLL through native destruction.
    drop(generation);
    assert_eq!(trace.lock().unwrap().events, ["start", "request_destroy", "cancel", "wait", "release", "destroy", "callback_drop"]);
}

#[test]
fn failed_generation_releases_without_finishing() {
    let (api, trace) = fixture(true);
    trace.lock().unwrap().wait_status = -1;
    let mut generation = RequestHandle::new(&api).unwrap().start(None).unwrap();
    assert!(generation.wait(-1).is_err());
    assert!(generation.finish().is_err());
    assert_eq!(trace.lock().unwrap().events, ["start", "request_destroy", "wait", "release", "destroy"]);
}

#[test]
fn destruction_is_unconditional_when_release_is_missing_or_fails() {
    for supported in [false, true] {
        let (api, trace) = fixture(supported);
        trace.lock().unwrap().release_status = -1;
        let mut generation = RequestHandle::new(&api).unwrap().start(None).unwrap();
        generation.wait(-1).unwrap();
        drop(generation.finish().unwrap());
        let trace = trace.lock().unwrap();
        assert_eq!(trace.events.last(), Some(&"destroy"));
        assert_eq!(trace.events.contains(&"release"), supported);
    }
}

#[test]
fn decode_timing_accessor_preserves_fields_and_supports_older_runtimes() {
    unsafe extern "C" fn timing(_: *const Generation, out: *mut VideoDecodeTimings) -> i32 {
        unsafe { *out = VideoDecodeTimings { seconds_prepare: 1.0, seconds_upscale: 2.0, seconds_model_open: 3.0,
            seconds_weight_load: 4.0, seconds_compute: 5.0, seconds_cleanup: 6.0 }; }
        0
    }
    for supported in [false, true] {
        let (mut api, _) = fixture(true);
        Arc::get_mut(&mut api.inner).unwrap().generation_video_decode_timings = supported.then_some(timing);
        let mut generation = RequestHandle::new(&api).unwrap().start(None).unwrap();
        generation.wait(-1).unwrap();
        let generation = generation.finish().unwrap();
        let timings = generation.video_decode_timings().unwrap();
        assert_eq!(timings.is_some(), supported);
        if let Some(timings) = timings {
            assert_eq!(serde_json::to_value(timings).unwrap(), serde_json::json!({
                "secondsPrepare": 1.0, "secondsUpscale": 2.0, "secondsModelOpen": 3.0,
                "secondsWeightLoad": 4.0, "secondsCompute": 5.0, "secondsCleanup": 6.0,
            }));
        }
    }
}

#[test]
fn bundled_runtime_exports_sample_release() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lib/slopfab").join(crate::slopfab::DLL_FILE_NAME);
    let api = Api::load(&path).unwrap();
    assert!(api.generation_release_samples.is_some());
    assert!(api.generation_video_decode_timings.is_some());
}
