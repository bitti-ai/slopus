use super::{raw, Api, RequestHandle};
use std::{ffi::c_void, ptr::NonNull};

pub type ProgressSink = Box<dyn Fn(&super::Progress) + Send + Sync>;
pub struct Preview<'a> {
    pub rgb: &'a [u8], pub frames: i32, pub width: i32, pub height: i32,
    pub step: i32, pub fps: f64,
}
pub type PreviewSink = Box<dyn Fn(Preview<'_>) + Send + Sync>;
struct PreviewCallback(PreviewSink);
unsafe extern "C" fn preview_callback(preview: *const raw::Preview, userdata: *mut c_void) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if preview.is_null() || userdata.is_null() { return; }
        let p = unsafe { &*preview };
        if p.rgb.is_null() || !(1..=128).contains(&p.frames) || !(1..=256).contains(&p.width)
            || !(1..=256).contains(&p.height) || !p.fps.is_finite() || p.fps <= 0.0
            || p.byte_count != p.frames as usize * p.width as usize * p.height as usize * 3 { return; }
        let callback = unsafe { &*userdata.cast::<PreviewCallback>() };
        (callback.0)(Preview { rgb: unsafe { std::slice::from_raw_parts(p.rgb, p.byte_count) },
            frames: p.frames, width: p.width, height: p.height, step: p.step, fps: p.fps });
    }));
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    #[test]
    fn validates_preview_buffers_and_contains_callback_panics() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut callback = Box::new(PreviewCallback(Box::new(move |p| {
            assert_eq!(p.rgb.len(), 12);
            count.fetch_add(1, Ordering::SeqCst);
        })));
        let data = [128u8; 12];
        let mut p = raw::Preview { rgb: data.as_ptr(), byte_count: data.len(), frames: 1, width: 2, height: 2, step: 0, fps: 6.0 };
        let userdata = (&mut *callback as *mut PreviewCallback).cast();
        unsafe { preview_callback(&p, userdata); }
        p.byte_count = 11;
        unsafe { preview_callback(&p, userdata); }
        p.byte_count = 12; p.width = i32::MAX;
        unsafe { preview_callback(&p, userdata); preview_callback(std::ptr::null(), userdata); }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        callback.0 = Box::new(|_| panic!("callback panic must not unwind through C"));
        p.width = 2;
        unsafe { preview_callback(&p, userdata); }
    }
}

struct Callback(ProgressSink);
unsafe extern "C" fn progress_callback(progress: *const raw::Progress, userdata: *mut c_void) {
    // Native callbacks may arrive on worker threads. Never unwind through C.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if !progress.is_null() && !userdata.is_null() {
            let callback = unsafe { &*userdata.cast::<Callback>() };
            (callback.0)(unsafe { &*progress });
        }
    }));
}

/// Owns both the loaded library and callback until native workers have stopped.
pub struct GenerationHandle {
    api: Api,
    pointer: NonNull<raw::Generation>,
    _callback: Option<Box<Callback>>,
    _preview: Option<Box<PreviewCallback>>,
    terminal: bool,
    succeeded: bool,
}

impl GenerationHandle {
    pub fn upscale(api: &Api, source: &str, checkpoint: &std::path::Path, scale: f32, video: &std::path::Path, audio: &std::path::Path, backend: i32, sink: ProgressSink) -> Result<Self, String> {
        let mut callback = Box::new(Callback(sink));
        let userdata = (&mut *callback as *mut Callback).cast();
        let pointer = api.inner.upscale_decode(source, checkpoint, scale, video, audio, backend, Some(progress_callback), userdata)?;
        Ok(Self { api: api.clone(), pointer: NonNull::new(pointer).ok_or("SlopFab returned an empty upscale handle.")?, _callback: Some(callback), _preview: None, terminal: false, succeeded: false })
    }
    pub(super) fn start(
        request: RequestHandle,
        sink: Option<ProgressSink>,
        preview: Option<(std::path::PathBuf, PreviewSink)>,
    ) -> Result<Self, String> {
        let preview = preview.map(|(path, sink)| {
            let mut callback = Box::new(PreviewCallback(sink));
            let userdata = (&mut *callback as *mut PreviewCallback).cast();
            if let Err(reason) = request.api.inner.set_preview(request.pointer.as_ptr(), &path, preview_callback, userdata) {
                eprintln!("Generation previews unavailable: {reason}");
            }
            callback
        });
        let mut callback = sink.map(|sink| Box::new(Callback(sink)));
        let userdata = callback.as_mut().map_or(std::ptr::null_mut(), |value| {
            (&mut **value as *mut Callback).cast()
        });
        let pointer = request.api.inner.start(
            request.pointer.as_ptr(),
            callback
                .as_ref()
                .map(|_| progress_callback as unsafe extern "C" fn(_, _)),
            userdata,
        )?;
        let pointer =
            NonNull::new(pointer).ok_or("Slopfab returned an empty generation handle.")?;
        Ok(Self {
            api: request.api.clone(),
            pointer,
            _callback: callback,
            _preview: preview,
            // slopfab_generation_start snapshots the request. Let the caller's
            // copy (including image/reference samples) drop now instead of
            // retaining it through inference and the webview's encoding pass.
            terminal: false,
            succeeded: false,
        })
    }

    pub fn cancel(&self) {
        self.api.inner.cancel(self.pointer.as_ptr());
    }

    /// A false result means the wait timed out; all other statuses are terminal.
    pub fn wait(&mut self, timeout: i32) -> Result<bool, String> {
        let code = self.api.inner.wait(self.pointer.as_ptr(), timeout);
        if code == super::super::NOT_READY {
            return Ok(false);
        }
        self.terminal = true;
        self.succeeded = code == 0;
        if code == 0 {
            return Ok(true);
        }
        if code == super::super::CANCELLED {
            return Err("Generation cancelled at the next slopfab checkpoint.".into());
        }
        let detail = self.api.inner.generation_error(self.pointer.as_ptr());
        Err(if detail.is_empty() {
            format!("slopfab generation failed with status {code}.")
        } else {
            detail
        })
    }

    pub fn finish(self) -> Result<FinishedGeneration, String> {
        if !self.succeeded {
            return Err("Generation has not completed successfully.".into());
        }
        Ok(FinishedGeneration(self))
    }
}

impl Drop for GenerationHandle {
    fn drop(&mut self) {
        if !self.terminal {
            self.cancel();
            // Wait for completion before releasing samples. Native destroy
            // then joins before callback memory and the library are dropped.
            while self.api.inner.wait(self.pointer.as_ptr(), -1) == super::super::NOT_READY {}
        }
        self.api.inner.destroy_generation(self.pointer.as_ptr());
    }
}

pub struct FinishedGeneration(GenerationHandle);
// Only successfully completed generations cross threads. The render store serializes
// access and the native API exposes immutable output after wait completes.
unsafe impl Send for FinishedGeneration {}

/// Pointer-free snapshot; audio is copied once, video stays in the native handle.
pub struct Output {
    pub video_float_count: usize,
    pub channels: i32,
    pub frames: i32,
    pub width: i32,
    pub height: i32,
    pub audio: Vec<f32>,
    pub audio_channels: i32,
    pub audio_sample_rate: i32,
    pub fps: f64,
    pub seconds_conditioning: f64,
    pub seconds_denoise: f64,
    pub seconds_video_decode: f64,
    pub seconds_audio_decode: f64,
    pub seconds_total: f64,
    pub steps_computed: i32,
    pub steps_skipped: i32,
}

impl FinishedGeneration {
    pub fn save_latents(&self, path: &std::path::Path) -> Result<(), String> {
        self.0.api.inner.save_generation_latents(self.0.pointer.as_ptr(), path)
    }
    pub fn video_decode_timings(&self) -> Result<Option<super::VideoDecodeTimings>, String> {
        self.0.api.inner.video_decode_timings(self.0.pointer.as_ptr())
    }
    pub fn output(&self) -> Result<Output, String> {
        let value = self.0.api.inner.output(self.0.pointer.as_ptr())?;
        if value.audio_float_count > isize::MAX as usize / std::mem::size_of::<f32>()
            || (value.audio.is_null() && value.audio_float_count != 0)
        {
            return Err("Slopfab returned an invalid audio buffer.".into());
        }
        let audio = if value.audio_float_count == 0 {
            Vec::new()
        } else {
            // The successful generation owns this buffer for the whole borrow.
            unsafe { std::slice::from_raw_parts(value.audio, value.audio_float_count) }.to_vec()
        };
        Ok(Output {
            video_float_count: value.video_float_count,
            channels: value.channels,
            frames: value.frames,
            width: value.width,
            height: value.height,
            audio,
            audio_channels: value.audio_channels,
            audio_sample_rate: value.audio_sample_rate,
            fps: value.fps,
            seconds_conditioning: value.seconds_conditioning,
            seconds_denoise: value.seconds_denoise,
            seconds_video_decode: value.seconds_video_decode,
            seconds_audio_decode: value.seconds_audio_decode,
            seconds_total: value.seconds_total,
            steps_computed: value.steps_computed,
            steps_skipped: value.steps_skipped,
        })
    }

    pub fn frame_rgba8(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.0
            .api
            .inner
            .frame_rgba8(self.0.pointer.as_ptr(), index, width, height)
    }
}
