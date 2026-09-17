use super::*;
enum ReferenceVideo {}
type VideoCreate = unsafe extern "C" fn(f64, *mut *mut ReferenceVideo) -> i32;
type VideoDestroy = unsafe extern "C" fn(*mut ReferenceVideo);
type VideoAppend =
    unsafe extern "C" fn(*mut ReferenceVideo, *const u8, usize, i32, i32, usize, f64) -> i32;
type VideoAudio =
    unsafe extern "C" fn(*mut ReferenceVideo, *const f32, usize, i32, i32, f64) -> i32;
type VideoAttach = unsafe extern "C" fn(*mut Request, *const ReferenceVideo) -> i32;

pub struct ReferenceVideoHandle {
    api: std::sync::Arc<Api>,
    handle: *mut ReferenceVideo,
    destroy: VideoDestroy,
    append_rgba: VideoAppend,
    audio: VideoAudio,
    attach_video: VideoAttach,
    dll_path: std::path::PathBuf,
    frames: usize,
    has_audio: bool,
}

// The registry mutex serializes access. The DLL handle and all copied input
// buffers outlive every call, and attached snapshots own their references.
unsafe impl Send for ReferenceVideoHandle {}

impl ReferenceVideoHandle {
    pub fn new(
        api: std::sync::Arc<Api>,
        duration: f64,
        dll_path: std::path::PathBuf,
    ) -> Result<Self, String> {
        unsafe {
            let missing = |error| {
                format!("This slopfab.dll does not support video references. Update the runtime: {error}")
            };
            let create = *api
                ._library
                .get::<VideoCreate>(b"slopfab_reference_video_create\0")
                .map_err(missing)?;
            let destroy = *api
                ._library
                .get::<VideoDestroy>(b"slopfab_reference_video_destroy\0")
                .map_err(missing)?;
            let append_rgba = *api
                ._library
                .get::<VideoAppend>(b"slopfab_reference_video_append_rgba8\0")
                .map_err(missing)?;
            let audio = *api
                ._library
                .get::<VideoAudio>(b"slopfab_reference_video_set_audio_f32\0")
                .map_err(missing)?;
            let attach_video = *api
                ._library
                .get::<VideoAttach>(b"slopfab_request_add_reference_video\0")
                .map_err(missing)?;
            let mut handle = std::ptr::null_mut();
            api.error(create(duration, &mut handle))?;
            if handle.is_null() {
                return Err("slopfab returned an empty reference video handle.".into());
            }
            Ok(Self {
                api,
                handle,
                destroy,
                append_rgba,
                audio,
                attach_video,
                dll_path,
                frames: 0,
                has_audio: false,
            })
        }
    }
    pub fn append(
        &mut self,
        bytes: &[u8],
        width: i32,
        height: i32,
        timestamp: f64,
    ) -> Result<(), String> {
        if width <= 0 || height <= 0 || width > 1024 || height > 1024 || self.frames >= 361 {
            return Err("Reference video preparation exceeds the frame or dimension limit.".into());
        }
        self.api.error(unsafe {
            (self.append_rgba)(
                self.handle,
                bytes.as_ptr(),
                bytes.len(),
                width,
                height,
                width as usize * 4,
                timestamp,
            )
        })?;
        self.frames += 1;
        Ok(())
    }
    pub fn set_audio(
        &mut self,
        samples: &[f32],
        channels: i32,
        sample_rate: i32,
    ) -> Result<(), String> {
        self.api.error(unsafe {
            (self.audio)(
                self.handle,
                samples.as_ptr(),
                samples.len(),
                channels,
                sample_rate,
                0.0,
            )
        })?;
        self.has_audio = !samples.is_empty();
        Ok(())
    }
    pub fn has_audio(&self) -> bool {
        self.has_audio
    }
    pub fn attach(&self, request: *mut Request, dll_path: &Path) -> Result<(), String> {
        if dll_path != self.dll_path {
            return Err("Reference video and generation must use the same slopfab runtime.".into());
        }
        self.api
            .error(unsafe { (self.attach_video)(request, self.handle) })
    }
}
impl Drop for ReferenceVideoHandle {
    fn drop(&mut self) {
        unsafe { (self.destroy)(self.handle) };
    }
}
