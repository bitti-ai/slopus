use super::{raw, Api, RequestHandle};
use std::{ffi::c_void, ptr::NonNull};

pub type ProgressSink = Box<dyn Fn(&super::Progress) + Send + Sync>;

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
    terminal: bool,
    succeeded: bool,
}

impl GenerationHandle {
    pub(super) fn start(request: &RequestHandle, sink: Option<ProgressSink>) -> Result<Self, String> {
        let mut callback = sink.map(|sink| Box::new(Callback(sink)));
        let userdata = callback.as_mut().map_or(std::ptr::null_mut(), |value| {
            (&mut **value as *mut Callback).cast()
        });
        let pointer = request.api.inner.start(
            request.pointer.as_ptr(),
            callback.as_ref().map(|_| progress_callback as unsafe extern "C" fn(_, _)),
            userdata,
        )?;
        let pointer = NonNull::new(pointer).ok_or("Slopfab returned an empty generation handle.")?;
        Ok(Self { api: request.api.clone(), pointer, _callback: callback, terminal: false, succeeded: false })
    }

    pub fn cancel(&self) { self.api.inner.cancel(self.pointer.as_ptr()); }

    /// A false result means the wait timed out; all other statuses are terminal.
    pub fn wait(&mut self, timeout: i32) -> Result<bool, String> {
        let code = self.api.inner.wait(self.pointer.as_ptr(), timeout);
        if code == super::super::NOT_READY { return Ok(false); }
        self.terminal = true;
        self.succeeded = code == 0;
        if code == 0 { return Ok(true); }
        if code == super::super::CANCELLED {
            return Err("Generation cancelled at the next slopfab checkpoint.".into());
        }
        let detail = self.api.inner.generation_error(self.pointer.as_ptr());
        Err(if detail.is_empty() { format!("slopfab generation failed with status {code}.") } else { detail })
    }

    pub fn finish(self) -> Result<FinishedGeneration, String> {
        if !self.succeeded { return Err("Generation has not completed successfully.".into()); }
        Ok(FinishedGeneration(self))
    }
}

impl Drop for GenerationHandle {
    fn drop(&mut self) {
        if !self.terminal {
            self.cancel();
            // Joining precedes destruction of callback memory and the library.
            while self.api.inner.wait(self.pointer.as_ptr(), -1) == super::super::NOT_READY {}
        }
        self.api.inner.destroy_generation(self.pointer.as_ptr());
    }
}

pub struct FinishedGeneration(GenerationHandle);
// Only successful, joined generations cross threads. The render store serializes
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
    pub fn output(&self) -> Result<Output, String> {
        let value = self.0.api.inner.output(self.0.pointer.as_ptr())?;
        if value.audio_float_count > isize::MAX as usize / std::mem::size_of::<f32>()
            || (value.audio.is_null() && value.audio_float_count != 0) {
            return Err("Slopfab returned an invalid audio buffer.".into());
        }
        let audio = if value.audio_float_count == 0 { Vec::new() } else {
            // The successful generation owns this buffer for the whole borrow.
            unsafe { std::slice::from_raw_parts(value.audio, value.audio_float_count) }.to_vec()
        };
        Ok(Output {
            video_float_count: value.video_float_count, channels: value.channels,
            frames: value.frames, width: value.width, height: value.height, audio,
            audio_channels: value.audio_channels, audio_sample_rate: value.audio_sample_rate,
            fps: value.fps, seconds_conditioning: value.seconds_conditioning,
            seconds_denoise: value.seconds_denoise, seconds_video_decode: value.seconds_video_decode,
            seconds_audio_decode: value.seconds_audio_decode, seconds_total: value.seconds_total,
            steps_computed: value.steps_computed, steps_skipped: value.steps_skipped,
        })
    }

    pub fn frame_rgba8(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.0.api.inner.frame_rgba8(self.0.pointer.as_ptr(), index, width, height)
    }
}
