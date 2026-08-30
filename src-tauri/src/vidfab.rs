//! Safe host-side boundary for the dynamically loaded vidfab C API.
//!
//! All ABI declarations and `unsafe` calls live in `ffi`; the rest of the
//! application only handles owned Rust status, plan, progress, and metadata.
use crate::{rendered, ProviderOption, ProviderSetting};
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter};

const DLL_FILE_NAME: &str = "vidfab.dll";
/// Where the packaged build puts the runtime while it is being developed. Used
/// only when the DLL is NOT beside the executable, so a `cargo run` out of the
/// source tree still finds it.
const DEVELOPMENT_DLL_PATH: &str = r"D:\Projects\vidfab\build\Release\vidfab.dll";

/// The runtime ships beside PolStudio.exe and is loaded from there — there is
/// no path for anyone to configure and no way for one to go stale. vidfab.dll
/// is loaded with LOAD_WITH_ALTERED_SEARCH_PATH, so its own dependencies sit in
/// that folder too, which is the same reason a subfolder never bought anything.
pub fn default_dll_path() -> PathBuf {
    if let Some(beside_exe) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(DLL_FILE_NAME)))
        .filter(|path| path.is_file())
    {
        return beside_exe;
    }
    DEVELOPMENT_DLL_PATH.into()
}
const EXPECTED_CAPI_MAJOR: u32 = 1;
const NOT_READY: i32 = -7;
const CANCELLED: i32 = -8;
const CUDA_ATTENTION: &str = "sage2";
const VULKAN_ATTENTION: &str = "exact";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComputePlatform {
    Cuda13,
    Cuda12,
    Vulkan,
}

impl ComputePlatform {
    fn label(self) -> &'static str {
        match self {
            Self::Cuda13 => "CUDA 13",
            Self::Cuda12 => "CUDA 12",
            Self::Vulkan => "Vulkan",
        }
    }

    fn backend(self) -> i32 {
        match self {
            Self::Cuda13 | Self::Cuda12 => 0,
            Self::Vulkan => 1,
        }
    }

    fn attention(self) -> &'static str {
        match self {
            Self::Cuda13 | Self::Cuda12 => CUDA_ATTENTION,
            Self::Vulkan => VULKAN_ATTENTION,
        }
    }
}

fn platform_from_cuda_probe(result: Result<i32, String>) -> ComputePlatform {
    match result {
        Ok(13) => ComputePlatform::Cuda13,
        Ok(12) => ComputePlatform::Cuda12,
        _ => ComputePlatform::Vulkan,
    }
}

fn detect_platform(api: &ffi::Api) -> ComputePlatform {
    // Explicit "auto" makes PolStudio's order deterministic even if the host
    // process carries VIDFAB_CUDA_VERSION. If this DLL instance was already
    // initialized, the setter is expected to refuse the change and the loaded
    // major below remains the authority.
    let _ = api.set_cuda_version("auto");
    platform_from_cuda_probe(api.cuda_loaded_major())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VidfabStatus {
    pub state: &'static str,
    pub dll_path: String,
    pub version: Option<String>,
    pub platform: Option<&'static str>,
    pub detail: String,
    pub models: Vec<ModelStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub configured: bool,
    pub available: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRequest {
    pub job_id: String,
    pub prompt: String,
    pub frames: i32,
    pub steps: i32,
    /// -1 asks the host to draw a fresh seed for this generation.
    pub seed: i64,
    pub canvas_width: i32,
    pub canvas_height: i32,
    #[serde(default)]
    pub reference_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPlan {
    pub canvas_width: i32,
    pub canvas_height: i32,
    pub aligned_frames: i32,
    pub duration_seconds: f64,
    pub model_evaluations: i32,
    pub sequence_rows_without_text: i32,
    pub latent_frames: i32,
    pub latent_width: i32,
    pub latent_height: i32,
    pub description: String,
    pub boundary: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    job_id: String,
    stage: &'static str,
    step: i32,
    total_steps: i32,
    elapsed_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    job_id: String,
    state: &'static str,
    detail: String,
    output: Option<OutputMetadata>,
}

/// What came back, and what the webview needs in order to encode it: the
/// shape of the pictures now waiting in [`crate::rendered`], and how much sound
/// came with them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputMetadata {
    frames: i32,
    width: i32,
    height: i32,
    fps: f64,
    audio_channels: i32,
    audio_sample_rate: i32,
    /// Interleaved samples across every channel, so the webview can tell an
    /// empty soundtrack from one it has not read yet.
    audio_samples: usize,
    duration_seconds: f64,
    boundary: &'static str,
}

#[derive(Clone)]
pub struct VidfabRuntime {
    sender: mpsc::Sender<QueueItem>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for VidfabRuntime {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<QueueItem>();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let worker_flags = cancellations.clone();
        thread::Builder::new().name("vidfab-serial-queue".into()).spawn(move || {
            while let Ok(item) = receiver.recv() {
                let result = run_generation(&item);
                let (state, detail, output) = match result {
                    Ok((metadata, pictures)) => {
                        /* The pictures wait in memory for the webview, which
                           encodes them and asks Rust to write the file. What
                           had to be dropped to make room is said out loud —
                           an abandoned render is a scene that has to be run
                           again, and the user is owed that sentence. */
                        let evicted = rendered::keep(pictures);
                        let detail = match evicted {
                            Some(job) if job != item.request.job_id => format!(
                                "Frames and audio are ready to be encoded. The frames of {job} were dropped to make room and that scene would have to be rendered again."
                            ),
                            _ => "Frames and audio are ready to be encoded.".to_string(),
                        };
                        ("framesReady", detail, Some(metadata))
                    }
                    Err(error) if item.cancel.load(Ordering::Acquire) => ("cancelled", error, None),
                    Err(error) => ("failed", error, None),
                };
                let _ = item.app.emit("vidfab-job", JobEvent { job_id: item.request.job_id.clone(), state, detail, output });
                let queue_empty = if let Ok(mut flags) = worker_flags.lock() {
                    flags.remove(&item.request.job_id);
                    flags.is_empty()
                } else {
                    false
                };
                // Reuse is scoped to one contiguous batch. Keeping it while a
                // queued scene exists avoids repeating conditioning and
                // reference preparation; clearing at the drain boundary gives
                // the otherwise multi-gigabyte cache a deterministic lifetime.
                if queue_empty {
                    if let Err(error) = clear_reused_models(&item.configuration) {
                        eprintln!("Could not clear vidfab's reused models: {error}");
                    }
                }
            }
        }).expect("could not start vidfab queue worker");
        Self {
            sender,
            cancellations,
        }
    }
}

fn clear_reused_models(configuration: &Configuration) -> Result<(), String> {
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    api.clear_reused_models()
}

impl VidfabRuntime {
    pub fn enqueue(
        &self,
        app: AppHandle,
        request: GenerationRequest,
        settings: &BTreeMap<String, ProviderSetting>,
    ) -> Result<(), String> {
        if request.job_id.trim().is_empty() || request.prompt.trim().is_empty() {
            return Err("Generation job id and prompt cannot be empty.".into());
        }
        validate_generation_controls(&request)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let mut flags = self
            .cancellations
            .lock()
            .map_err(|_| "Generation queue lock failed.")?;
        if flags.contains_key(&request.job_id) {
            return Err("This generation job is already queued.".into());
        }
        flags.insert(request.job_id.clone(), cancel.clone());
        drop(flags);
        let configuration = Configuration::from_settings(settings);
        let queued_id = request.job_id.clone();
        if self
            .sender
            .send(QueueItem {
                app: app.clone(),
                request,
                configuration,
                cancel,
            })
            .is_err()
        {
            self.cancellations
                .lock()
                .map_err(|_| "Generation queue lock failed.")?
                .remove(&queued_id);
            return Err("Generation queue is unavailable.".into());
        }
        let _ = app.emit(
            "vidfab-job",
            JobEvent {
                job_id: queued_id,
                state: "queued",
                detail: "Queued behind any active vidfab generation.".into(),
                output: None,
            },
        );
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        self.cancellations
            .lock()
            .ok()
            .and_then(|flags| flags.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Release);
                true
            })
    }
}

struct QueueItem {
    app: AppHandle,
    request: GenerationRequest,
    configuration: Configuration,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone)]
struct Configuration {
    dll_path: PathBuf,
    models: [(i32, &'static str, Option<PathBuf>); 5],
}

impl Configuration {
    fn from_settings(settings: &BTreeMap<String, ProviderSetting>) -> Self {
        let vidfab = settings.get("vidfab");
        let option = |name: &str| {
            vidfab.and_then(|setting| match setting.options.get(name) {
                Some(ProviderOption::String(value)) if !value.trim().is_empty() => {
                    Some(PathBuf::from(value))
                }
                _ => None,
            })
        };
        Self {
            // `dllPath` is no longer written by the app and has no settings UI.
            // It is still READ so a project or a test that carries one keeps
            // working; with none, the runtime is found beside the executable.
            dll_path: option("dllPath").unwrap_or_else(default_dll_path),
            models: [
                (0, "transformer", option("transformer")),
                (1, "textEncoder", option("textEncoder")),
                (2, "tokenizer", option("tokenizer")),
                (3, "videoVae", option("videoVae")),
                (4, "audioVae", option("audioVae")),
            ],
        }
    }
}

pub fn status(settings: &BTreeMap<String, ProviderSetting>) -> VidfabStatus {
    let configuration = Configuration::from_settings(settings);
    let models = configuration
        .models
        .iter()
        .map(|(_, id, path)| ModelStatus {
            id,
            configured: path.is_some(),
            available: path.as_deref().is_some_and(Path::is_file),
            path: path
                .as_ref()
                .map(|value| value.to_string_lossy().into_owned()),
        })
        .collect::<Vec<_>>();
    let dll_path = configuration.dll_path.to_string_lossy().into_owned();
    match ffi::Api::load(&configuration.dll_path) {
        Ok(api) => match api.version() {
            Ok(version) => {
                let platform = detect_platform(&api);
                let missing = models
                    .iter()
                    .filter(|model| !model.available && model.id != "tokenizer")
                    .count();
                VidfabStatus {
                    state: if missing == 0 {
                        "ready"
                    } else {
                        "modelsMissing"
                    },
                    dll_path,
                    version: Some(version),
                    platform: Some(platform.label()),
                    detail: if missing == 0 {
                        "Runtime and required model paths are available.".into()
                    } else {
                        format!("Runtime loaded; {missing} required model paths are missing. Editing remains available.")
                    },
                    models,
                }
            }
            Err(error) => VidfabStatus {
                state: "incompatible",
                dll_path,
                version: None,
                platform: None,
                detail: error,
                models,
            },
        },
        Err(error) => VidfabStatus {
            state: "runtimeMissing",
            dll_path,
            version: None,
            platform: None,
            detail: format!("vidfab is unavailable: {error}. Editing remains available."),
            models,
        },
    }
}

pub fn resolve_plan(
    request: &GenerationRequest,
    settings: &BTreeMap<String, ProviderSetting>,
) -> Result<ResolvedPlan, String> {
    validate_generation_controls(request)?;
    let configuration = Configuration::from_settings(settings);
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    let platform = detect_platform(&api);
    let handle = RequestHandle::new(&api)?;
    configure_request(&api, handle.0, request, &configuration, platform, false)?;
    let plan = api.resolve(handle.0)?;
    let description = api.describe(handle.0)?;
    Ok(ResolvedPlan {
        canvas_width: plan.canvas_width,
        canvas_height: plan.canvas_height,
        aligned_frames: plan.aligned_frames,
        duration_seconds: plan.duration_seconds,
        model_evaluations: plan.num_model_evaluations,
        sequence_rows_without_text: plan.sequence_rows_without_text,
        latent_frames: plan.latent_frames,
        latent_width: plan.latent_width,
        latent_height: plan.latent_height,
        description,
        boundary: "Plan only. No weights were opened and no media file was created.",
    })
}

fn validate_generation_controls(request: &GenerationRequest) -> Result<(), String> {
    if request.steps < 2 {
        return Err("Generation step count must be at least 2.".into());
    }
    if request.seed < -1 {
        return Err("Generation seed must be -1 or greater.".into());
    }
    if request.canvas_width <= 0 || request.canvas_height <= 0 {
        return Err("Generation canvas dimensions must be positive.".into());
    }
    Ok(())
}

fn generation_seed(value: i64) -> Result<u64, String> {
    if value == -1 {
        let mut bytes = [0_u8; 8];
        fill_random(&mut bytes)
            .map_err(|error| format!("Could not create a random generation seed: {error}"))?;
        Ok(u64::from_ne_bytes(bytes))
    } else {
        u64::try_from(value).map_err(|_| "Generation seed must be -1 or greater.".to_string())
    }
}

fn configure_request(
    api: &ffi::Api,
    handle: *mut ffi::Request,
    request: &GenerationRequest,
    configuration: &Configuration,
    platform: ComputePlatform,
    include_models: bool,
) -> Result<(), String> {
    api.set_prompt(handle, &request.prompt)?;
    api.set_frames(handle, request.frames)?;
    api.set_steps(handle, request.steps)?;
    api.set_seed(handle, generation_seed(request.seed)?)?;
    api.set_resolution(handle, request.canvas_width, request.canvas_height)?;
    api.set_inference_backend(handle, platform.backend())?;
    api.set_attention(handle, platform.attention())?;
    api.set_verbose(handle, false)?;
    if include_models {
        api.set_reuse_models(handle, true)?;
        for (id, _, path) in &configuration.models {
            if let Some(path) = path {
                api.set_model(handle, *id, path)?;
            }
        }
        for path in &request.reference_paths {
            api.add_reference(handle, Path::new(path))?;
        }
    }
    Ok(())
}

/// Runs one generation and retains its terminal handle for frame streaming.
/// Audio is copied once; video stays owned by vidfab until encoding completes.
struct FinishedGeneration {
    api: ffi::Api,
    generation: *mut ffi::Generation,
}

// Created by the serial worker and moved into a mutex-protected render store
// only after reaching a terminal state. Finished output is read-only.
unsafe impl Send for FinishedGeneration {}

impl rendered::FrameSource for FinishedGeneration {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        self.api.frame_rgba8(self.generation, index, width, height)
    }
}

impl Drop for FinishedGeneration {
    fn drop(&mut self) {
        self.api.destroy_generation(self.generation);
    }
}

fn run_generation(item: &QueueItem) -> Result<(OutputMetadata, rendered::RenderedVideo), String> {
    if item.cancel.load(Ordering::Acquire) {
        return Err("Generation was cancelled before it started.".into());
    }
    let api = ffi::Api::load(&item.configuration.dll_path)?;
    api.version()?;
    let platform = detect_platform(&api);
    let request = RequestHandle::new(&api)?;
    configure_request(
        &api,
        request.0,
        &item.request,
        &item.configuration,
        platform,
        true,
    )?;
    api.resolve(request.0)?;
    let context = Box::new(CallbackContext {
        app: item.app.clone(),
        job_id: item.request.job_id.clone(),
    });
    let context_ptr = Box::into_raw(context);
    let generation = match api.start(request.0, Some(progress_callback), context_ptr.cast()) {
        Ok(value) => value,
        Err(error) => {
            unsafe {
                drop(Box::from_raw(context_ptr));
            }
            return Err(error);
        }
    };
    loop {
        if item.cancel.load(Ordering::Acquire) {
            api.cancel(generation);
        }
        let code = api.wait(generation, 100);
        if code == NOT_READY {
            continue;
        }
        if code == CANCELLED {
            api.destroy_generation(generation);
            unsafe {
                drop(Box::from_raw(context_ptr));
            }
            return Err("Generation cancelled at the next vidfab checkpoint.".into());
        }
        if code != 0 {
            let error = api.generation_error(generation);
            api.destroy_generation(generation);
            unsafe {
                drop(Box::from_raw(context_ptr));
            }
            return Err(if error.is_empty() {
                format!("vidfab generation failed with status {code}.")
            } else {
                error
            });
        }
        break;
    }
    let output = match api.output(generation) {
        Ok(output) => output,
        Err(error) => {
            api.destroy_generation(generation);
            unsafe { drop(Box::from_raw(context_ptr)) };
            return Err(error);
        }
    };
    if output.audio.is_null() && output.audio_float_count != 0 {
        api.destroy_generation(generation);
        unsafe { drop(Box::from_raw(context_ptr)) };
        return Err("Vidfab returned a null audio buffer with a non-zero size.".into());
    }
    // Audio is small enough to own directly. Video remains in the generation
    // and is converted through frame_rgba8 only as WebCodecs asks for it.
    let audio = if output.audio.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.audio, output.audio_float_count) }.to_vec()
    };
    let metadata = OutputMetadata {
        frames: output.frames, width: output.width, height: output.height, fps: output.fps,
        audio_channels: output.audio_channels, audio_sample_rate: output.audio_sample_rate,
        audio_samples: output.audio_float_count,
        duration_seconds: if output.fps > 0.0 {
            output.frames as f64 / output.fps
        } else {
            0.0
        },
        boundary: "Decoded buffers remain owned by vidfab and frames are converted on demand. The webview encodes them; vidfab wrote no file.",
    };
    unsafe {
        drop(Box::from_raw(context_ptr));
    }
    drop(request);
    let source = Box::new(FinishedGeneration { api, generation });
    let pictures = rendered::from_source(
        &item.request.job_id,
        source,
        &audio,
        output.frames.max(0) as u32,
        output.width.max(0) as u32,
        output.height.max(0) as u32,
        output.channels.max(0) as u32,
        output.video_float_count,
        output.fps,
        output.audio_channels.max(0) as u32,
        output.audio_sample_rate.max(0) as u32,
    )?;
    Ok((metadata, pictures))
}

struct RequestHandle<'a>(*mut ffi::Request, &'a ffi::Api);
impl<'a> RequestHandle<'a> {
    fn new(api: &'a ffi::Api) -> Result<Self, String> {
        api.create_request().map(|value| Self(value, api))
    }
}
impl Drop for RequestHandle<'_> {
    fn drop(&mut self) {
        self.1.destroy_request(self.0);
    }
}

struct CallbackContext {
    app: AppHandle,
    job_id: String,
}
unsafe extern "C" fn progress_callback(
    progress: *const ffi::Progress,
    userdata: *mut std::ffi::c_void,
) {
    let _ = std::panic::catch_unwind(|| {
        if progress.is_null() || userdata.is_null() {
            return;
        }
        let progress = unsafe { &*progress };
        let context = unsafe { &*(userdata.cast::<CallbackContext>()) };
        let _ = context.app.emit(
            "vidfab-progress",
            ProgressEvent {
                job_id: context.job_id.clone(),
                stage: stage_name(progress.stage),
                step: progress.step,
                total_steps: progress.total_steps,
                elapsed_seconds: progress.elapsed_seconds,
            },
        );
    });
}

fn stage_name(stage: i32) -> &'static str {
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

mod ffi {
    use libloading::Library;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        path::Path,
        ptr,
    };

    pub enum Request {}
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
        set_resolution: unsafe extern "C" fn(*mut Request, i32, i32) -> i32,
        set_frames: unsafe extern "C" fn(*mut Request, i32) -> i32,
        set_steps: unsafe extern "C" fn(*mut Request, i32) -> i32,
        set_seed: unsafe extern "C" fn(*mut Request, u64) -> i32,
        set_model: unsafe extern "C" fn(*mut Request, i32, *const c_char) -> i32,
        add_reference: unsafe extern "C" fn(*mut Request, *const c_char) -> i32,
        set_attention: unsafe extern "C" fn(*mut Request, *const c_char) -> i32,
        set_inference_backend: unsafe extern "C" fn(*mut Request, i32) -> i32,
        set_verbose: unsafe extern "C" fn(*mut Request, i32) -> i32,
        set_reuse_models: unsafe extern "C" fn(*mut Request, i32) -> i32,
        reused_models_clear: unsafe extern "C" fn() -> i32,
        resolve_plan: unsafe extern "C" fn(*const Request, *mut Plan) -> i32,
        describe_plan: unsafe extern "C" fn(*const Request, *mut *mut c_char) -> i32,
        generation_start: unsafe extern "C" fn(
            *const Request,
            ProgressFn,
            *mut c_void,
            *mut *mut Generation,
        ) -> i32,
        generation_cancel: unsafe extern "C" fn(*mut Generation),
        generation_wait: unsafe extern "C" fn(*mut Generation, i32) -> i32,
        generation_error: unsafe extern "C" fn(*const Generation) -> *const c_char,
        generation_output: unsafe extern "C" fn(*const Generation, *mut Output) -> i32,
        generation_frame_rgba8:
            unsafe extern "C" fn(*const Generation, i32, *mut u8, usize) -> i32,
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
                    capi_version: symbol!("vidfab_capi_version", unsafe extern "C" fn() -> u32),
                    version_string: symbol!(
                        "vidfab_capi_version_string",
                        unsafe extern "C" fn() -> *const c_char
                    ),
                    last_error: symbol!(
                        "vidfab_last_error",
                        unsafe extern "C" fn() -> *const c_char
                    ),
                    free_string: symbol!("vidfab_free_string", unsafe extern "C" fn(*mut c_char)),
                    cuda_set_version: symbol!(
                        "vidfab_cuda_set_version",
                        unsafe extern "C" fn(*const c_char) -> i32
                    ),
                    cuda_loaded_major: symbol!(
                        "vidfab_cuda_loaded_major",
                        unsafe extern "C" fn(*mut i32) -> i32
                    ),
                    request_create: symbol!(
                        "vidfab_request_create",
                        unsafe extern "C" fn() -> *mut Request
                    ),
                    request_destroy: symbol!(
                        "vidfab_request_destroy",
                        unsafe extern "C" fn(*mut Request)
                    ),
                    set_prompt: symbol!(
                        "vidfab_request_set_prompt",
                        unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                    ),
                    set_resolution: symbol!(
                        "vidfab_request_set_resolution",
                        unsafe extern "C" fn(*mut Request, i32, i32) -> i32
                    ),
                    set_frames: symbol!(
                        "vidfab_request_set_frames",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    set_steps: symbol!(
                        "vidfab_request_set_steps",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    set_seed: symbol!(
                        "vidfab_request_set_seed",
                        unsafe extern "C" fn(*mut Request, u64) -> i32
                    ),
                    set_model: symbol!(
                        "vidfab_request_set_model_path",
                        unsafe extern "C" fn(*mut Request, i32, *const c_char) -> i32
                    ),
                    add_reference: symbol!(
                        "vidfab_request_add_reference_image",
                        unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                    ),
                    set_attention: symbol!(
                        "vidfab_request_set_attention",
                        unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                    ),
                    set_inference_backend: symbol!(
                        "vidfab_request_set_inference_backend",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    set_verbose: symbol!(
                        "vidfab_request_set_verbose",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    set_reuse_models: symbol!(
                        "vidfab_request_set_reuse_models",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    reused_models_clear: symbol!(
                        "vidfab_reused_models_clear",
                        unsafe extern "C" fn() -> i32
                    ),
                    resolve_plan: symbol!(
                        "vidfab_resolve_plan",
                        unsafe extern "C" fn(*const Request, *mut Plan) -> i32
                    ),
                    describe_plan: symbol!(
                        "vidfab_describe_plan",
                        unsafe extern "C" fn(*const Request, *mut *mut c_char) -> i32
                    ),
                    generation_start: symbol!(
                        "vidfab_generation_start",
                        unsafe extern "C" fn(
                            *const Request,
                            ProgressFn,
                            *mut c_void,
                            *mut *mut Generation,
                        ) -> i32
                    ),
                    generation_cancel: symbol!(
                        "vidfab_generation_cancel",
                        unsafe extern "C" fn(*mut Generation)
                    ),
                    generation_wait: symbol!(
                        "vidfab_generation_wait",
                        unsafe extern "C" fn(*mut Generation, i32) -> i32
                    ),
                    generation_error: symbol!(
                        "vidfab_generation_error",
                        unsafe extern "C" fn(*const Generation) -> *const c_char
                    ),
                    generation_output: symbol!(
                        "vidfab_generation_output",
                        unsafe extern "C" fn(*const Generation, *mut Output) -> i32
                    ),
                    generation_frame_rgba8: symbol!(
                        "vidfab_generation_frame_rgba8",
                        unsafe extern "C" fn(*const Generation, i32, *mut u8, usize) -> i32
                    ),
                    generation_destroy: symbol!(
                        "vidfab_generation_destroy",
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
                if major != super::EXPECTED_CAPI_MAJOR {
                    return Err(format!(
                        "Incompatible vidfab C API major {major}; expected {}.",
                        super::EXPECTED_CAPI_MAJOR
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
                    format!("vidfab returned status {code}.")
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
            let value = CString::new(value)
                .map_err(|_| "CUDA version contains a null byte.".to_string())?;
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
        pub fn set_resolution(&self, r: *mut Request, w: i32, h: i32) -> Result<(), String> {
            self.error(unsafe { (self.set_resolution)(r, w, h) })
        }
        pub fn set_frames(&self, r: *mut Request, v: i32) -> Result<(), String> {
            self.error(unsafe { (self.set_frames)(r, v) })
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
            let v = CString::new(v)
                .map_err(|_| "Attention mode contains a null byte.".to_string())?;
            self.error(unsafe { (self.set_attention)(r, v.as_ptr()) })
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
            self.error(unsafe {
                (self.generation_start)(request, callback, userdata, &mut value)
            })?;
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
                .map_err(|_| "Frame index does not fit the vidfab API.".to_string())?;
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
            .map_err(|_| "A vidfab path contains a null byte.".into())
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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_dll_is_an_explicit_disabled_state() {
        let mut settings = BTreeMap::new();
        settings.insert(
            "vidfab".into(),
            ProviderSetting {
                enabled: true,
                model: None,
                options: BTreeMap::from([(
                    "dllPath".into(),
                    ProviderOption::String("Z:/definitely-absent/vidfab.dll".into()),
                )]),
            },
        );
        let status = status(&settings);
        assert_eq!(status.state, "runtimeMissing");
    }
    #[test]
    fn compatible_major_version_decodes_from_packed_value() {
        let packed = (1_u32 << 24) | (37 << 12) | 5;
        assert_eq!(packed >> 24, EXPECTED_CAPI_MAJOR);
    }
    #[test]
    fn platform_selection_prefers_supported_cuda_majors_and_falls_back_to_vulkan() {
        assert_eq!(platform_from_cuda_probe(Ok(13)), ComputePlatform::Cuda13);
        assert_eq!(platform_from_cuda_probe(Ok(12)), ComputePlatform::Cuda12);
        assert_eq!(platform_from_cuda_probe(Ok(11)), ComputePlatform::Vulkan);
        assert_eq!(
            platform_from_cuda_probe(Err("no CUDA toolkit".into())),
            ComputePlatform::Vulkan
        );
        assert_eq!(ComputePlatform::Cuda13.backend(), 0);
        assert_eq!(ComputePlatform::Vulkan.backend(), 1);
        assert_eq!(ComputePlatform::Vulkan.attention(), "exact");
    }

    /// Under `cargo test` the executable is a test harness in target/debug, so
    /// this resolves to the development path — which is exactly the build this
    /// test is here to check.
    #[test]
    fn installed_development_dll_reports_a_compatible_api_when_present() {
        if default_dll_path().is_file() {
            let runtime = status(&BTreeMap::new());
            assert_ne!(runtime.state, "runtimeMissing", "{}", runtime.detail);
            assert_ne!(runtime.state, "incompatible", "{}", runtime.detail);
            assert!(runtime
                .version
                .as_deref()
                .is_some_and(|value| value.starts_with("1.")));
            assert!(matches!(runtime.platform, Some("CUDA 13" | "CUDA 12" | "Vulkan")));
        }
    }
    #[test]
    fn stage_ids_are_normalized_without_assuming_an_enum() {
        assert_eq!(stage_name(4), "denoising");
        assert_eq!(stage_name(99), "unknown");
    }
    #[test]
    fn generation_seed_accepts_random_and_non_negative_values() {
        assert!(generation_seed(-1).is_ok());
        assert_eq!(generation_seed(0).unwrap(), 0);
        assert_eq!(generation_seed(482_091).unwrap(), 482_091);
        assert!(generation_seed(-2).is_err());
    }
}
