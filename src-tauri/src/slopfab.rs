//! Safe host-side boundary for the dynamically loaded slopfab C API.
//!
//! All ABI declarations and `unsafe` calls live in `ffi`; the rest of the
//! application only handles owned Rust status, plan, progress, and metadata.
use crate::{diagnostics, rendered, ProviderOption, ProviderSetting};
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

const DLL_FILE_NAME: &str = "slopfab.dll";
/// Where the packaged build puts the runtime while it is being developed. Used
/// only when the DLL is NOT beside the executable, so a `cargo run` out of the
/// source tree still finds it.
const DEVELOPMENT_DLL_PATH: &str = r"D:\Projects\slopfab\build\Release\slopfab.dll";

/// The runtime ships beside Slopus.exe and is loaded from there — there is
/// no path for anyone to configure and no way for one to go stale. slopfab.dll
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
    // Explicit "auto" makes Slopus's order deterministic even if the host
    // process carries SLOPFAB_CUDA_VERSION. If this DLL instance was already
    // initialized, the setter is expected to refuse the change and the loaded
    // major below remains the authority.
    let _ = api.set_cuda_version("auto");
    platform_from_cuda_probe(api.cuda_loaded_major())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlopfabStatus {
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
    #[serde(default)]
    pub still_image: bool,
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
    planned_steps: i32,
    elapsed_seconds: f64,
    frames: i32,
    canvas_width: i32,
    canvas_height: i32,
    reference_count: usize,
    timing_profile: String,
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
    reference_count: usize,
    timing_profile: String,
    seconds_conditioning: f64,
    seconds_denoise: f64,
    seconds_video_decode: f64,
    seconds_audio_decode: f64,
    seconds_total: f64,
    steps_computed: i32,
    steps_skipped: i32,
    duration_seconds: f64,
    boundary: &'static str,
}

#[derive(Clone)]
pub struct SlopfabRuntime {
    sender: mpsc::Sender<QueueItem>,
    cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for SlopfabRuntime {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<QueueItem>();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let worker_flags = cancellations.clone();
        thread::Builder::new().name("slopfab-serial-queue".into()).spawn(move || {
            while let Ok(item) = receiver.recv() {
                let started = std::time::Instant::now();
                diagnostics::info("slopfab", "generation.started", "Native generation worker started.", serde_json::json!({
                    "jobId": item.request.job_id,
                    "frames": item.request.frames,
                    "steps": item.request.steps,
                    "canvasWidth": item.request.canvas_width,
                    "canvasHeight": item.request.canvas_height,
                    "referenceCount": item.request.reference_paths.len(),
                    "randomSeed": item.request.seed == -1,
                }));
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
                let context = serde_json::json!({
                    "jobId": item.request.job_id,
                    "state": state,
                    "elapsedMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    "output": output.as_ref().map(|value| serde_json::json!({
                        "frames": value.frames, "width": value.width, "height": value.height,
                        "fps": value.fps, "audioChannels": value.audio_channels,
                        "audioSamples": value.audio_samples,
                        "secondsConditioning": value.seconds_conditioning,
                        "secondsDenoise": value.seconds_denoise,
                        "secondsVideoDecode": value.seconds_video_decode,
                        "secondsAudioDecode": value.seconds_audio_decode,
                        "secondsTotal": value.seconds_total,
                        "stepsComputed": value.steps_computed,
                        "stepsSkipped": value.steps_skipped,
                    })),
                });
                if state == "failed" {
                    diagnostics::error("slopfab", "generation.finished", &detail, context);
                } else if state == "cancelled" {
                    diagnostics::warn("slopfab", "generation.finished", &detail, context);
                } else {
                    diagnostics::info("slopfab", "generation.finished", &detail, context);
                }
                let _ = item.app.emit("slopfab-job", JobEvent { job_id: item.request.job_id.clone(), state, detail, output });
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
                        diagnostics::warn("slopfab", "models.clear_failed", &error, serde_json::json!({}));
                    }
                }
            }
        }).expect("could not start slopfab queue worker");
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

impl SlopfabRuntime {
    pub fn enqueue(
        &self,
        app: AppHandle,
        request: GenerationRequest,
        settings: &BTreeMap<String, ProviderSetting>,
    ) -> Result<(), String> {
        diagnostics::info(
            "slopfab",
            "generation.enqueue_requested",
            "Generation was submitted to the native queue.",
            serde_json::json!({
                "jobId": request.job_id,
                "frames": request.frames,
                "steps": request.steps,
                "canvasWidth": request.canvas_width,
                "canvasHeight": request.canvas_height,
                "referenceCount": request.reference_paths.len(),
                "inputChars": request.prompt.chars().count(),
            }),
        );
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
            "slopfab-job",
            JobEvent {
                job_id: queued_id.clone(),
                state: "queued",
                detail: "Queued behind any active slopfab generation.".into(),
                output: None,
            },
        );
        diagnostics::info(
            "slopfab",
            "generation.queued",
            "Generation entered the native queue.",
            serde_json::json!({ "jobId": queued_id }),
        );
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let accepted = self
            .cancellations
            .lock()
            .ok()
            .and_then(|flags| flags.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Release);
                true
            });
        diagnostics::info(
            "slopfab",
            "generation.cancel_requested",
            if accepted {
                "Cancellation was accepted."
            } else {
                "No queued generation matched the cancellation."
            },
            serde_json::json!({
                "jobId": job_id, "accepted": accepted,
            }),
        );
        accepted
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
        let slopfab = settings.get("slopfab");
        let option = |name: &str| {
            slopfab.and_then(|setting| match setting.options.get(name) {
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

    fn timing_profile(&self, version: &str, platform: ComputePlatform) -> String {
        let models = self
            .models
            .iter()
            .filter_map(|(_, id, path)| {
                path.as_ref().map(|path| {
                    let file = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("unknown");
                    format!("{id}={file}")
                })
            })
            .collect::<Vec<_>>()
            .join(";");
        format!("slopfab={version}|platform={}|{models}", platform.label())
    }
}

pub fn status(settings: &BTreeMap<String, ProviderSetting>) -> SlopfabStatus {
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
                SlopfabStatus {
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
            Err(error) => SlopfabStatus {
                state: "incompatible",
                dll_path,
                version: None,
                platform: None,
                detail: error,
                models,
            },
        },
        Err(error) => SlopfabStatus {
            state: "runtimeMissing",
            dll_path,
            version: None,
            platform: None,
            detail: format!("slopfab is unavailable: {error}. Editing remains available."),
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
    if request.still_image {
        api.set_still_image(handle)?;
    }
    api.set_steps(handle, request.steps)?;
    api.set_seed(handle, generation_seed(request.seed)?)?;
    api.set_resolution(handle, request.canvas_width, request.canvas_height)?;
    api.set_inference_backend(handle, platform.backend())?;
    api.set_attention(handle, platform.attention())?;
    api.set_verbose(handle, false)?;
    if include_models {
        api.set_reuse_models(handle, true)?;
        for (id, _, path) in &configuration.models {
            if request.still_image && *id == 4 {
                continue;
            }
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
/// Audio is copied once; video stays owned by slopfab until encoding completes.
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
    let version = api.version()?;
    let platform = detect_platform(&api);
    let timing_profile = item.configuration.timing_profile(&version, platform);
    diagnostics::debug(
        "slopfab",
        "generation.runtime_ready",
        "slopfab runtime loaded.",
        serde_json::json!({
            "jobId": item.request.job_id, "version": version, "platform": platform.label(),
        }),
    );
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
    diagnostics::debug(
        "slopfab",
        "generation.request_resolved",
        "slopfab resolved the generation request.",
        serde_json::json!({ "jobId": item.request.job_id }),
    );
    let context = Box::new(CallbackContext {
        app: item.app.clone(),
        job_id: item.request.job_id.clone(),
        frames: item.request.frames,
        canvas_width: item.request.canvas_width,
        canvas_height: item.request.canvas_height,
        reference_count: item.request.reference_paths.len(),
        timing_profile: timing_profile.clone(),
        planned_steps: (item.request.steps - 1).max(0),
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
    diagnostics::debug(
        "slopfab",
        "generation.api_started",
        "slopfab accepted the generation request.",
        serde_json::json!({ "jobId": item.request.job_id }),
    );
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
            return Err("Generation cancelled at the next slopfab checkpoint.".into());
        }
        if code != 0 {
            let error = api.generation_error(generation);
            api.destroy_generation(generation);
            unsafe {
                drop(Box::from_raw(context_ptr));
            }
            return Err(if error.is_empty() {
                format!("slopfab generation failed with status {code}.")
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
        return Err("Slopfab returned a null audio buffer with a non-zero size.".into());
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
        reference_count: item.request.reference_paths.len(),
        timing_profile,
        seconds_conditioning: output.seconds_conditioning,
        seconds_denoise: output.seconds_denoise,
        seconds_video_decode: output.seconds_video_decode,
        seconds_audio_decode: output.seconds_audio_decode,
        seconds_total: output.seconds_total,
        steps_computed: output.steps_computed,
        steps_skipped: output.steps_skipped,
        duration_seconds: if output.fps > 0.0 {
            output.frames as f64 / output.fps
        } else {
            0.0
        },
        boundary: "Decoded buffers remain owned by slopfab and frames are converted on demand. The webview encodes them; slopfab wrote no file.",
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

struct GenerationHandle<'a>(*mut ffi::Generation, &'a ffi::Api);
impl Drop for GenerationHandle<'_> {
    fn drop(&mut self) {
        self.1.destroy_generation(self.0);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIconSpec {
    pub id: String,
    pub prompt: String,
    pub seed: u64,
    pub destination: PathBuf,
}

#[derive(Debug)]
pub struct ReferenceIconBatchConfig {
    pub dll_path: PathBuf,
    pub transformer: PathBuf,
    pub text_encoder: PathBuf,
    pub video_vae: PathBuf,
    pub backend: String,
}

fn write_reference_icon(
    api: &ffi::Api,
    configuration: &Configuration,
    platform: ComputePlatform,
    spec: &ReferenceIconSpec,
) -> Result<(), String> {
    let request = GenerationRequest {
        job_id: spec.id.clone(),
        prompt: spec.prompt.clone(),
        frames: 1,
        still_image: true,
        steps: 30,
        seed: i64::try_from(spec.seed)
            .map_err(|_| format!("Icon '{}' seed is too large.", spec.id))?,
        canvas_width: 256,
        canvas_height: 256,
        reference_paths: Vec::new(),
    };
    let handle = RequestHandle::new(api)?;
    configure_request(api, handle.0, &request, configuration, platform, true)?;
    api.resolve(handle.0)?;
    let generation = GenerationHandle(api.start(handle.0, None, std::ptr::null_mut())?, api);
    let status = api.wait(generation.0, -1);
    if status != 0 {
        let detail = api.generation_error(generation.0);
        return Err(if detail.is_empty() {
            format!("Icon '{}' failed with slopfab status {status}.", spec.id)
        } else {
            format!("Icon '{}' failed: {detail}", spec.id)
        });
    }
    let output = api.output(generation.0)?;
    if output.width != 256 || output.height != 256 || output.frames != 1 {
        return Err(format!(
            "Icon '{}' returned {}x{} with {} frames.",
            spec.id, output.width, output.height, output.frames
        ));
    }
    let rgba = api.frame_rgba8(generation.0, 0, 256, 256)?;
    let rgb = rgba
        .chunks_exact(4)
        .flat_map(|pixel| [pixel[0], pixel[1], pixel[2]])
        .collect::<Vec<_>>();
    if let Some(parent) = spec.destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create icon folder '{}': {error}",
                parent.display()
            )
        })?;
    }
    let encoder = jpeg_encoder::Encoder::new_file(&spec.destination, 100).map_err(|error| {
        format!(
            "Could not create icon '{}': {error}",
            spec.destination.display()
        )
    })?;
    encoder
        .encode(&rgb, 256, 256, jpeg_encoder::ColorType::Rgb)
        .map_err(|error| {
            format!(
                "Could not encode icon '{}': {error}",
                spec.destination.display()
            )
        })
}

pub fn generate_reference_icon_batch(
    specs: &[ReferenceIconSpec],
    batch: &ReferenceIconBatchConfig,
) -> Result<(), String> {
    let backend = match batch.backend.as_str() {
        "cuda" => ComputePlatform::Cuda13,
        "vulkan" => ComputePlatform::Vulkan,
        value => return Err(format!("Unsupported icon generation backend '{value}'.")),
    };
    let configuration = Configuration {
        dll_path: batch.dll_path.clone(),
        models: [
            (0, "transformer", Some(batch.transformer.clone())),
            (1, "textEncoder", Some(batch.text_encoder.clone())),
            (2, "tokenizer", None),
            (3, "videoVae", Some(batch.video_vae.clone())),
            // Icons keep one picture and need no decoded soundtrack.
            (4, "audioVae", None),
        ],
    };
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    let platform = if backend == ComputePlatform::Cuda13 {
        detect_platform(&api)
    } else {
        backend
    };
    let result = specs.iter().enumerate().try_for_each(|(index, spec)| {
        let started = std::time::Instant::now();
        write_reference_icon(&api, &configuration, platform, spec)?;
        println!(
            "[{}/{}] {}: generated in {:.1}s",
            index + 1,
            specs.len(),
            spec.id,
            started.elapsed().as_secs_f64()
        );
        Ok(())
    });
    let cleared = api.clear_reused_models();
    result.and(cleared)
}

struct CallbackContext {
    app: AppHandle,
    job_id: String,
    frames: i32,
    canvas_width: i32,
    canvas_height: i32,
    reference_count: usize,
    timing_profile: String,
    planned_steps: i32,
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
        let _ = context.app.emit(
            "slopfab-progress",
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
        set_still_image: Option<unsafe extern "C" fn(*mut Request, i32) -> i32>,
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
                    request_destroy: symbol!(
                        "slopfab_request_destroy",
                        unsafe extern "C" fn(*mut Request)
                    ),
                    set_prompt: symbol!(
                        "slopfab_request_set_prompt",
                        unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                    ),
                    set_resolution: symbol!(
                        "slopfab_request_set_resolution",
                        unsafe extern "C" fn(*mut Request, i32, i32) -> i32
                    ),
                    set_frames: symbol!(
                        "slopfab_request_set_frames",
                        unsafe extern "C" fn(*mut Request, i32) -> i32
                    ),
                    set_still_image: library
                        .get::<unsafe extern "C" fn(*mut Request, i32) -> i32>(b"slopfab_request_set_still_image\0")
                        .ok().map(|symbol| *symbol),
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
                    set_attention: symbol!(
                        "slopfab_request_set_attention",
                        unsafe extern "C" fn(*mut Request, *const c_char) -> i32
                    ),
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
                if major != super::EXPECTED_CAPI_MAJOR {
                    return Err(format!(
                        "Incompatible slopfab C API major {major}; expected {}.",
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
        pub fn set_still_image(&self, r: *mut Request) -> Result<(), String> {
            let set = self.set_still_image.ok_or("This slopfab.dll does not support still-image generation. Update the runtime to generate reference icons.")?;
            self.error(unsafe { set(r, 1) })
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
            let v =
                CString::new(v).map_err(|_| "Attention mode contains a null byte.".to_string())?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_dll_is_an_explicit_disabled_state() {
        let mut settings = BTreeMap::new();
        settings.insert(
            "slopfab".into(),
            ProviderSetting {
                enabled: true,
                model: None,
                options: BTreeMap::from([(
                    "dllPath".into(),
                    ProviderOption::String("Z:/definitely-absent/slopfab.dll".into()),
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
            assert!(matches!(
                runtime.platform,
                Some("CUDA 13" | "CUDA 12" | "Vulkan")
            ));
        }
    }
    #[test]
    fn stage_ids_are_normalized_without_assuming_an_enum() {
        assert_eq!(stage_name(4), "denoising");
        assert_eq!(stage_name(99), "unknown");
    }

    #[test]
    fn installed_dll_resolves_icons_as_one_still_frame_when_present() {
        if !default_dll_path().is_file() { return; }
        let request: GenerationRequest = serde_json::from_value(serde_json::json!({
            "jobId": "icon-plan", "prompt": "A red toy car", "frames": 1, "stillImage": true,
            "steps": 30, "seed": 1, "canvasWidth": 256, "canvasHeight": 256
        })).unwrap();
        let plan = resolve_plan(&request, &BTreeMap::new()).unwrap();
        assert_eq!(plan.aligned_frames, 1);
        assert_eq!(plan.latent_frames, 1);
        assert_eq!((plan.canvas_width, plan.canvas_height), (256, 256));
    }
    #[test]
    fn generation_seed_accepts_random_and_non_negative_values() {
        assert!(generation_seed(-1).is_ok());
        assert_eq!(generation_seed(0).unwrap(), 0);
        assert_eq!(generation_seed(482_091).unwrap(), 482_091);
        assert!(generation_seed(-2).is_err());
    }
}
