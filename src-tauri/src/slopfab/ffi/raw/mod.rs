use libloading::Library;
use std::{
    ffi::{c_char, c_void, CStr, CString},
    path::Path,
    ptr,
};

pub enum Request {}
mod device;
mod reference_video;
pub use device::{cuda_device_names, gpu_devices, has_cuda_device};
pub use reference_video::ReferenceVideoHandle;
pub enum Generation {}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Plan {
    pub canvas_width: i32,
    pub canvas_height: i32,
    pub aligned_frames: i32,
    pub duration_seconds: f64,
    pub num_model_evaluations: i32,
    pub sequence_rows_without_text: i32,
    pub latent_frames: i32,
    pub latent_height: i32,
    pub latent_width: i32,
    pub num_video_rows: i32,
    pub num_audio_rows: i32,
    pub num_audio_latents: i32,
}
#[repr(C)]
pub struct Progress {
    pub stage: i32,
    pub step: i32,
    pub total_steps: i32,
    pub elapsed_seconds: f64,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Output {
    pub video: *const f32,
    pub video_float_count: usize,
    pub channels: i32,
    pub frames: i32,
    pub width: i32,
    pub height: i32,
    pub audio: *const f32,
    pub audio_float_count: usize,
    pub audio_channels: i32,
    pub audio_sample_rate: i32,
    pub audio_frames: i64,
    pub fps: f64,
    pub seconds_conditioning: f64,
    pub seconds_denoise: f64,
    pub seconds_video_decode: f64,
    pub seconds_audio_decode: f64,
    pub seconds_total: f64,
    pub steps_computed: i32,
    pub steps_skipped: i32,
}
pub type ProgressFn = Option<unsafe extern "C" fn(*const Progress, *mut c_void)>;
type SetMotionCache =
    unsafe extern "C" fn(*mut Request, i32, f32, f32, i32, i32, f32, f32, i32, i32) -> i32;

pub struct Api {
    _library: Library,
    capi_version: unsafe extern "C" fn() -> u32,
    version_string: unsafe extern "C" fn() -> *const c_char,
    last_error: unsafe extern "C" fn() -> *const c_char,
    free_string: unsafe extern "C" fn(*mut c_char),
    cuda_set_version: unsafe extern "C" fn(*const c_char) -> i32,
    cuda_loaded_major: unsafe extern "C" fn(*mut i32) -> i32,
    request_create: unsafe extern "C" fn() -> *mut Request,
    request_destroy: unsafe extern "C" fn(*mut Request),
    set_prompt: unsafe extern "C" fn(*mut Request, *const c_char) -> i32,
    set_animate: Option<unsafe extern "C" fn(*mut Request, i32, i32) -> i32>,
    set_prompt_embedding: Option<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>,
    set_resolution: unsafe extern "C" fn(*mut Request, i32, i32) -> i32,
    set_frames: unsafe extern "C" fn(*mut Request, i32) -> i32,
    set_still_image: Option<unsafe extern "C" fn(*mut Request, i32) -> i32>,
    set_save_latents: Option<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>,
    set_continuation_file: Option<unsafe extern "C" fn(*mut Request, *const c_char, i32) -> i32>,
    set_steps: unsafe extern "C" fn(*mut Request, i32) -> i32,
    set_seed: unsafe extern "C" fn(*mut Request, u64) -> i32,
    set_model: unsafe extern "C" fn(*mut Request, i32, *const c_char) -> i32,
    add_lora: Option<unsafe extern "C" fn(*mut Request, *const c_char, f32) -> i32>,
    prepare_lora_grid: Option<unsafe extern "C" fn(*const c_char, i32, i32) -> i32>,
    add_refmod: Option<unsafe extern "C" fn(*mut Request, *const c_char, f32, i32) -> i32>,
    add_reference: unsafe extern "C" fn(*mut Request, *const c_char) -> i32,
    set_attention: unsafe extern "C" fn(*mut Request, *const c_char) -> i32,
    set_motion_cache: Option<SetMotionCache>,
    set_inference_backend: unsafe extern "C" fn(*mut Request, i32) -> i32,
    set_verbose: unsafe extern "C" fn(*mut Request, i32) -> i32,
    set_reuse_models: unsafe extern "C" fn(*mut Request, i32) -> i32,
    reused_models_clear: unsafe extern "C" fn() -> i32,
    resolve_plan: unsafe extern "C" fn(*const Request, *mut Plan) -> i32,
    describe_plan: unsafe extern "C" fn(*const Request, *mut *mut c_char) -> i32,
    generation_start:
        unsafe extern "C" fn(*const Request, ProgressFn, *mut c_void, *mut *mut Generation) -> i32,
    generation_cancel: unsafe extern "C" fn(*mut Generation),
    generation_wait: unsafe extern "C" fn(*mut Generation, i32) -> i32,
    generation_error: unsafe extern "C" fn(*const Generation) -> *const c_char,
    generation_output: unsafe extern "C" fn(*const Generation, *mut Output) -> i32,
    generation_frame_rgba8: unsafe extern "C" fn(*const Generation, i32, *mut u8, usize) -> i32,
    generation_destroy: unsafe extern "C" fn(*mut Generation),
}

impl Api {
    pub fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: symbols are copied function pointers with signatures from capi.h.
        // The Library is retained in Api, so no pointer outlives the loaded module.
        unsafe {
            let library = load_library(path)
                .map_err(|error| format!("could not load {}: {error}", path.display()))?;
            macro_rules! symbol {
                ($name:literal, $ty:ty) => {
                    *library
                        .get::<$ty>(concat!($name, "\0").as_bytes())
                        .map_err(|error| format!("missing {}: {error}", $name))?
                };
            }
            Ok(Self {
                capi_version: symbol!("slopfab_capi_version", unsafe extern "C" fn() -> u32),
                version_string: symbol!(
                    "slopfab_capi_version_string",
                    unsafe extern "C" fn() -> *const c_char
                ),
                last_error: symbol!(
                    "slopfab_last_error",
                    unsafe extern "C" fn() -> *const c_char
                ),
                free_string: symbol!("slopfab_free_string", unsafe extern "C" fn(*mut c_char)),
                cuda_set_version: symbol!(
                    "slopfab_cuda_set_version",
                    unsafe extern "C" fn(*const c_char) -> i32
                ),
                cuda_loaded_major: symbol!(
                    "slopfab_cuda_loaded_major",
                    unsafe extern "C" fn(*mut i32) -> i32
                ),
                request_create: symbol!(
                    "slopfab_request_create",
                    unsafe extern "C" fn() -> *mut Request
                ),
                prepare_lora_grid: library
                    .get::<unsafe extern "C" fn(*const c_char, i32, i32) -> i32>(
                        b"slopfab_prepare_lora_grid\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                request_destroy: symbol!(
                    "slopfab_request_destroy",
                    unsafe extern "C" fn(*mut Request)
                ),
                set_prompt: symbol!(
                    "slopfab_request_set_prompt",
                    unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                ),
                set_animate: library
                    .get::<unsafe extern "C" fn(*mut Request, i32, i32) -> i32>(
                        b"slopfab_request_set_animate\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_prompt_embedding: library
                    .get::<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>(
                        b"slopfab_request_set_prompt_embedding_path\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_resolution: symbol!(
                    "slopfab_request_set_resolution",
                    unsafe extern "C" fn(*mut Request, i32, i32) -> i32
                ),
                set_frames: symbol!(
                    "slopfab_request_set_frames",
                    unsafe extern "C" fn(*mut Request, i32) -> i32
                ),
                set_still_image: library
                    .get::<unsafe extern "C" fn(*mut Request, i32) -> i32>(
                        b"slopfab_request_set_still_image\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_steps: symbol!(
                    "slopfab_request_set_steps",
                    unsafe extern "C" fn(*mut Request, i32) -> i32
                ),
                set_seed: symbol!(
                    "slopfab_request_set_seed",
                    unsafe extern "C" fn(*mut Request, u64) -> i32
                ),
                set_model: symbol!(
                    "slopfab_request_set_model_path",
                    unsafe extern "C" fn(*mut Request, i32, *const c_char) -> i32
                ),
                add_reference: symbol!(
                    "slopfab_request_add_reference_image",
                    unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                ),
                add_lora: library
                    .get::<unsafe extern "C" fn(*mut Request, *const c_char, f32) -> i32>(
                        b"slopfab_request_add_lora\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_save_latents: library
                    .get::<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>(
                        b"slopfab_request_set_save_latents\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_continuation_file: library
                    .get::<unsafe extern "C" fn(*mut Request, *const c_char, i32) -> i32>(
                        b"slopfab_request_set_continuation_file\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                add_refmod: library
                    .get::<unsafe extern "C" fn(*mut Request, *const c_char, f32, i32) -> i32>(
                        b"slopfab_request_add_refmod\0",
                    )
                    .ok()
                    .map(|symbol| *symbol),
                set_attention: symbol!(
                    "slopfab_request_set_attention",
                    unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                ),
                set_motion_cache: library
                    .get::<SetMotionCache>(b"slopfab_request_set_motion_cache\0")
                    .ok()
                    .map(|symbol| *symbol),
                set_inference_backend: symbol!(
                    "slopfab_request_set_inference_backend",
                    unsafe extern "C" fn(*mut Request, i32) -> i32
                ),
                set_verbose: symbol!(
                    "slopfab_request_set_verbose",
                    unsafe extern "C" fn(*mut Request, i32) -> i32
                ),
                set_reuse_models: symbol!(
                    "slopfab_request_set_reuse_models",
                    unsafe extern "C" fn(*mut Request, i32) -> i32
                ),
                reused_models_clear: symbol!(
                    "slopfab_reused_models_clear",
                    unsafe extern "C" fn() -> i32
                ),
                resolve_plan: symbol!(
                    "slopfab_resolve_plan",
                    unsafe extern "C" fn(*const Request, *mut Plan) -> i32
                ),
                describe_plan: symbol!(
                    "slopfab_describe_plan",
                    unsafe extern "C" fn(*const Request, *mut *mut c_char) -> i32
                ),
                generation_start: symbol!(
                    "slopfab_generation_start",
                    unsafe extern "C" fn(
                        *const Request,
                        ProgressFn,
                        *mut c_void,
                        *mut *mut Generation,
                    ) -> i32
                ),
                generation_cancel: symbol!(
                    "slopfab_generation_cancel",
                    unsafe extern "C" fn(*mut Generation)
                ),
                generation_wait: symbol!(
                    "slopfab_generation_wait",
                    unsafe extern "C" fn(*mut Generation, i32) -> i32
                ),
                generation_error: symbol!(
                    "slopfab_generation_error",
                    unsafe extern "C" fn(*const Generation) -> *const c_char
                ),
                generation_output: symbol!(
                    "slopfab_generation_output",
                    unsafe extern "C" fn(*const Generation, *mut Output) -> i32
                ),
                generation_frame_rgba8: symbol!(
                    "slopfab_generation_frame_rgba8",
                    unsafe extern "C" fn(*const Generation, i32, *mut u8, usize) -> i32
                ),
                generation_destroy: symbol!(
                    "slopfab_generation_destroy",
                    unsafe extern "C" fn(*mut Generation)
                ),
                _library: library,
            })
        }
    }
    pub fn version(&self) -> Result<String, String> {
        unsafe {
            let packed = (self.capi_version)();
            let major = packed >> 24;
            if major != crate::slopfab::EXPECTED_CAPI_MAJOR {
                return Err(format!(
                    "Incompatible slopfab C API major {major}; expected {}.",
                    crate::slopfab::EXPECTED_CAPI_MAJOR
                ));
            }
            Ok(c_string((self.version_string)()))
        }
    }
    fn error(&self, code: i32) -> Result<(), String> {
        if code == 0 {
            Ok(())
        } else {
            let message = unsafe { c_string((self.last_error)()) };
            Err(if message.is_empty() {
                format!("slopfab returned status {code}.")
            } else {
                message
            })
        }
    }
    pub fn create_request(&self) -> Result<*mut Request, String> {
        let value = unsafe { (self.request_create)() };
        if value.is_null() {
            Err(unsafe { c_string((self.last_error)()) })
        } else {
            Ok(value)
        }
    }
    pub fn destroy_request(&self, request: *mut Request) {
        unsafe { (self.request_destroy)(request) }
    }
    pub fn set_cuda_version(&self, value: &str) -> Result<(), String> {
        let value =
            CString::new(value).map_err(|_| "CUDA version contains a null byte.".to_string())?;
        self.error(unsafe { (self.cuda_set_version)(value.as_ptr()) })
    }
    pub fn cuda_loaded_major(&self) -> Result<i32, String> {
        let mut major = 0;
        self.error(unsafe { (self.cuda_loaded_major)(&mut major) })?;
        Ok(major)
    }
    pub fn set_prompt(&self, r: *mut Request, v: &str) -> Result<(), String> {
        let v = CString::new(v).map_err(|_| "Prompt contains a null byte.".to_string())?;
        self.error(unsafe { (self.set_prompt)(r, v.as_ptr()) })
    }
    #[cfg(test)]
    pub fn disable_animate_for_test(&mut self) {
        self.set_animate = None;
    }
    pub fn set_animate(&self, r: *mut Request, preserve_audio: bool) -> Result<(), String> {
        let set = self
            .set_animate
            .ok_or("Animate requires slopfab.dll API 1.10 or later. Update the runtime.")?;
        self.error(unsafe { set(r, 1, preserve_audio as i32) })
    }
    pub fn set_prompt_embedding(&self, r: *mut Request, path: &Path) -> Result<(), String> {
        let set = self
            .set_prompt_embedding
            .ok_or("This slopfab.dll does not support frozen conditioning. Update the runtime.")?;
        let path = path_cstring(path)?;
        self.error(unsafe { set(r, path.as_ptr()) })
    }
    pub fn set_resolution(&self, r: *mut Request, w: i32, h: i32) -> Result<(), String> {
        self.error(unsafe { (self.set_resolution)(r, w, h) })
    }
    pub fn set_frames(&self, r: *mut Request, v: i32) -> Result<(), String> {
        self.error(unsafe { (self.set_frames)(r, v) })
    }
    pub fn set_still_image(&self, r: *mut Request) -> Result<(), String> {
        let set = self.set_still_image.ok_or("This slopfab.dll does not support still-image generation. Update the runtime to generate reference icons.")?;
        self.error(unsafe { set(r, 1) })
    }
    pub fn set_save_latents(&self, r: *mut Request, path: &Path) -> Result<(), String> {
        let set = self.set_save_latents.ok_or(
            "Saving generation latents requires slopfab.dll API 1.9 or later. Update the runtime.",
        )?;
        let path = path_cstring(path)?;
        self.error(unsafe { set(r, path.as_ptr()) })
    }
    pub fn set_continuation_file(
        &self,
        r: *mut Request,
        path: &Path,
        overlap: i32,
    ) -> Result<(), String> {
        let set = self.set_continuation_file.ok_or(
            "Scene continuation requires slopfab.dll API 1.9 or later. Update the runtime.",
        )?;
        let path = path_cstring(path)?;
        self.error(unsafe { set(r, path.as_ptr(), overlap) })
    }
    pub fn set_steps(&self, r: *mut Request, v: i32) -> Result<(), String> {
        self.error(unsafe { (self.set_steps)(r, v) })
    }
    pub fn set_seed(&self, r: *mut Request, v: u64) -> Result<(), String> {
        self.error(unsafe { (self.set_seed)(r, v) })
    }
    pub fn set_verbose(&self, r: *mut Request, v: bool) -> Result<(), String> {
        self.error(unsafe { (self.set_verbose)(r, v as i32) })
    }
    pub fn set_reuse_models(&self, r: *mut Request, v: bool) -> Result<(), String> {
        self.error(unsafe { (self.set_reuse_models)(r, v as i32) })
    }
    pub fn clear_reused_models(&self) -> Result<(), String> {
        self.error(unsafe { (self.reused_models_clear)() })
    }
    pub fn set_attention(&self, r: *mut Request, v: &str) -> Result<(), String> {
        let v = CString::new(v).map_err(|_| "Attention mode contains a null byte.".to_string())?;
        self.error(unsafe { (self.set_attention)(r, v.as_ptr()) })
    }
    pub fn set_motion_cache(&self, r: *mut Request, enabled: bool) -> Result<(), String> {
        let Some(set) = self.set_motion_cache else {
            return if enabled {
                Err("This slopfab.dll does not support MotionCache. Update the runtime or disable MotionCache in the generator template.".into())
            } else {
                Ok(())
            };
        };
        // Defaults from slopfab/capi.h; the UI exposes only the enable switch.
        self.error(unsafe { set(r, enabled as i32, 0.15, 1.0, 4, 2, 0.15, 0.95, 8, 0) })
    }
    #[cfg(test)]
    pub fn disable_motion_cache_for_test(&mut self) {
        self.set_motion_cache = None;
    }
    pub fn set_inference_backend(&self, r: *mut Request, backend: i32) -> Result<(), String> {
        self.error(unsafe { (self.set_inference_backend)(r, backend) })
    }
    pub fn set_model(&self, r: *mut Request, id: i32, path: &Path) -> Result<(), String> {
        let v = path_cstring(path)?;
        self.error(unsafe { (self.set_model)(r, id, v.as_ptr()) })
    }
    pub fn add_reference(&self, r: *mut Request, path: &Path) -> Result<(), String> {
        let v = path_cstring(path)?;
        self.error(unsafe { (self.add_reference)(r, v.as_ptr()) })
    }
    pub fn add_lora(&self, r: *mut Request, path: &Path, strength: f32) -> Result<(), String> {
        let add = self.add_lora.ok_or("This slopfab.dll does not support LoRAs. Update the DLL or disable the selected LoRAs.")?;
        let path = path_cstring(path)?;
        self.error(unsafe { add(r, path.as_ptr(), strength) })
    }
    pub fn prepare_lora_grid(
        &self,
        path: &Path,
        width: i32,
        allow_download: bool,
    ) -> Result<(), String> {
        let prepare = self.prepare_lora_grid.ok_or(
            "LoRA preparation requires slopfab.dll API 1.13 or later. Update the runtime.",
        )?;
        let path = path_cstring(path)?;
        self.error(unsafe { prepare(path.as_ptr(), width, allow_download as i32) })
    }
    #[cfg(test)]
    pub fn disable_lora_preparation_for_test(&mut self) {
        self.prepare_lora_grid = None;
    }
    pub fn add_refmod(
        &self,
        r: *mut Request,
        path: &Path,
        strength: f32,
        copies: i32,
    ) -> Result<(), String> {
        let add = self.add_refmod.ok_or("This slopfab.dll does not support refmods. Install a build with the refmod API (1.8 or later).")?;
        let path = path_cstring(path)?;
        self.error(unsafe { add(r, path.as_ptr(), strength, copies) })
    }
    pub fn resolve(&self, request: *mut Request) -> Result<Plan, String> {
        let mut value = Plan {
            canvas_width: 0,
            canvas_height: 0,
            aligned_frames: 0,
            duration_seconds: 0.0,
            num_model_evaluations: 0,
            sequence_rows_without_text: 0,
            latent_frames: 0,
            latent_height: 0,
            latent_width: 0,
            num_video_rows: 0,
            num_audio_rows: 0,
            num_audio_latents: 0,
        };
        self.error(unsafe { (self.resolve_plan)(request, &mut value) })?;
        Ok(value)
    }
    pub fn describe(&self, request: *mut Request) -> Result<String, String> {
        let mut value = ptr::null_mut();
        self.error(unsafe { (self.describe_plan)(request, &mut value) })?;
        let text = unsafe { c_string(value) };
        unsafe { (self.free_string)(value) };
        Ok(text)
    }
    pub fn start(
        &self,
        request: *mut Request,
        callback: ProgressFn,
        userdata: *mut c_void,
    ) -> Result<*mut Generation, String> {
        let mut value = ptr::null_mut();
        self.error(unsafe { (self.generation_start)(request, callback, userdata, &mut value) })?;
        Ok(value)
    }
    pub fn cancel(&self, generation: *mut Generation) {
        unsafe { (self.generation_cancel)(generation) }
    }
    pub fn wait(&self, generation: *mut Generation, timeout: i32) -> i32 {
        unsafe { (self.generation_wait)(generation, timeout) }
    }
    pub fn generation_error(&self, generation: *mut Generation) -> String {
        unsafe { c_string((self.generation_error)(generation)) }
    }
    pub fn output(&self, generation: *mut Generation) -> Result<Output, String> {
        let mut value = Output {
            video: ptr::null(),
            video_float_count: 0,
            channels: 0,
            frames: 0,
            width: 0,
            height: 0,
            audio: ptr::null(),
            audio_float_count: 0,
            audio_channels: 0,
            audio_sample_rate: 0,
            audio_frames: 0,
            fps: 0.0,
            seconds_conditioning: 0.0,
            seconds_denoise: 0.0,
            seconds_video_decode: 0.0,
            seconds_audio_decode: 0.0,
            seconds_total: 0.0,
            steps_computed: 0,
            steps_skipped: 0,
        };
        self.error(unsafe { (self.generation_output)(generation, &mut value) })?;
        Ok(value)
    }
    pub fn frame_rgba8(
        &self,
        generation: *mut Generation,
        index: u32,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, String> {
        let index = i32::try_from(index)
            .map_err(|_| "Frame index does not fit the slopfab API.".to_string())?;
        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| "Frame dimensions do not fit in memory.".to_string())?;
        let mut rgba = vec![0_u8; bytes];
        self.error(unsafe {
            (self.generation_frame_rgba8)(generation, index, rgba.as_mut_ptr(), rgba.len())
        })?;
        Ok(rgba)
    }
    pub fn destroy_generation(&self, generation: *mut Generation) {
        unsafe { (self.generation_destroy)(generation) }
    }
}
fn path_cstring(path: &Path) -> Result<CString, String> {
    CString::new(path.to_string_lossy().as_bytes())
        .map_err(|_| "A slopfab path contains a null byte.".into())
}

#[cfg(windows)]
unsafe fn load_library(path: &Path) -> Result<Library, libloading::Error> {
    // LOAD_WITH_ALTERED_SEARCH_PATH makes Windows resolve the runtime's
    // dynamic dependencies relative to this absolute path instead of the host exe.
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x0000_0008;
    unsafe {
        libloading::os::windows::Library::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH)
            .map(Into::into)
    }
}

#[cfg(not(windows))]
unsafe fn load_library(path: &Path) -> Result<Library, libloading::Error> {
    unsafe { Library::new(path) }
}
unsafe fn c_string(value: *const c_char) -> String {
    if value.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    }
}
