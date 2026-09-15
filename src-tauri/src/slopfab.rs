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
// https://huggingface.co/Viggle/Viggle-Animate/raw/main/assets/fixed_prompt.txt
const ANIMATE_PROMPT: &str = include_str!("../assets/viggle-animate-fixed-prompt.txt");
/// Tauri stages the repository's runtime resources in development and release
/// builds. Installers and portable folders use the same relative layout.
pub fn default_dll_path() -> PathBuf {
    let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("Slopus.exe"));
    let directory = executable.parent().unwrap_or_else(|| Path::new("."));
    // Cargo test executables live one level below the staged resources.
    #[cfg(test)]
    let directory = if directory.file_name().is_some_and(|name| name == "deps") {
        directory.parent().unwrap_or(directory)
    } else { directory };
    directory.join(DLL_FILE_NAME)
}
const EXPECTED_CAPI_MAJOR: u32 = 1;
const NOT_READY: i32 = -7;
const CANCELLED: i32 = -8;

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
}

fn platform_from_cuda_probe(result: Result<i32, String>) -> ComputePlatform {
    match result {
        Ok(13) => ComputePlatform::Cuda13,
        Ok(12) => ComputePlatform::Cuda12,
        _ => ComputePlatform::Vulkan,
    }
}

fn detect_platform(api: &ffi::Api) -> ComputePlatform {
    // A toolkit can be installed on an AMD/Intel machine. Check for a usable
    // NVIDIA device before treating the cuBLAS installation as CUDA support.
    if !ffi::has_cuda_device() {
        return ComputePlatform::Vulkan;
    }
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
    pub cuda_available: bool,
    pub cuda_device_names: Vec<String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub name: String,
    pub memory_bytes: u64,
}

pub fn gpu_devices() -> Vec<GpuDevice> { ffi::gpu_devices() }

#[derive(Debug, Clone, Default, Deserialize)]
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
    #[serde(default)]
    pub reference_video_ids: Vec<String>,
    #[serde(default)]
    pub refmods: Vec<RefmodInput>,
    #[serde(default)]
    pub continuation_relative_path: Option<String>,
    // Only the project commands resolve paths; IPC cannot supply save targets.
    #[serde(skip)]
    pub continuation_path: Option<PathBuf>,
    #[serde(skip)]
    pub save_latents_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RefmodInput {
    pub path: String,
    pub strength: f32,
    pub copies: u32,
}

impl GenerationRequest {
    pub fn reference_count(&self) -> usize {
        self.reference_paths.len() + self.reference_video_ids.len()
    }
}

// A video owns its DLL and input buffers. Commands serialize mutations; the
// C API retains immutable snapshots when a plan/generation attaches a video.
static REFERENCE_VIDEOS: std::sync::LazyLock<Mutex<HashMap<String, ffi::ReferenceVideoHandle>>> =
    std::sync::LazyLock::new(Default::default);
static NEXT_REFERENCE_VIDEO: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn create_reference_video(duration: f64, settings: &BTreeMap<String, ProviderSetting>) -> Result<String, String> {
    let configuration = Configuration::from_settings(settings);
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    let video = ffi::ReferenceVideoHandle::new(api, duration, configuration.dll_path)?;
    let mut videos = REFERENCE_VIDEOS.lock().map_err(|_| "Reference video lock failed.")?;
    if videos.len() >= 3 { return Err("At most three video references can be prepared at once.".into()); }
    let id = NEXT_REFERENCE_VIDEO.fetch_add(1, Ordering::Relaxed).to_string();
    videos.insert(id.clone(), video);
    Ok(id)
}

pub fn append_reference_video(id: &str, bytes: &[u8], width: i32, height: i32, timestamp: f64) -> Result<(), String> {
    REFERENCE_VIDEOS.lock().map_err(|_| "Reference video lock failed.")?
        .get_mut(id).ok_or("The prepared reference video no longer exists.")?
        .append(bytes, width, height, timestamp)
}

pub fn set_reference_video_audio(id: &str, bytes: &[u8], channels: i32, sample_rate: i32) -> Result<(), String> {
    if bytes.len() % 4 != 0 { return Err("Reference audio must contain complete float32 samples.".into()); }
    let samples: Vec<f32> = bytes.chunks_exact(4).map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap())).collect();
    REFERENCE_VIDEOS.lock().map_err(|_| "Reference video lock failed.")?
        .get_mut(id).ok_or("The prepared reference video no longer exists.")?
        .set_audio(&samples, channels, sample_rate)
}

pub fn release_reference_videos(ids: &[String]) -> Result<(), String> {
    let mut videos = REFERENCE_VIDEOS.lock().map_err(|_| "Reference video lock failed.")?;
    for id in ids { videos.remove(id); }
    Ok(())
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
                    "referenceCount": item.request.reference_count(),
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
        mut request: GenerationRequest,
        settings: &BTreeMap<String, ProviderSetting>,
    ) -> Result<(), String> {
        let configuration = Configuration::from_settings(settings);
        request.steps = configuration.generation_steps(request.steps)?;
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
                "referenceCount": request.reference_count(),
                "inputChars": request.prompt.chars().count(),
            }),
        );
        if request.job_id.trim().is_empty() {
            return Err("Generation job id cannot be empty.".into());
        }
        configuration.validate_inputs(&request)?;
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

#[derive(Debug, Clone, Deserialize)]
struct LoraAdapter {
    path: String,
    strength: f32,
}

#[derive(Clone)]
struct Configuration {
    dll_path: PathBuf,
    vulkan: bool,
    attention: &'static str,
    animate: bool,
    models: [(i32, &'static str, Option<PathBuf>); 5],
    loras: Result<Vec<LoraAdapter>, String>,
    step_override: Result<Option<i32>, String>,
}

impl Configuration {
    fn from_settings(settings: &BTreeMap<String, ProviderSetting>) -> Self {
        let slopfab = settings.get("slopfab");
        let string_option = |name: &str| {
            slopfab.and_then(|setting| match setting.options.get(name) {
                Some(ProviderOption::String(value)) => Some(value.as_str()),
                _ => None,
            })
        };
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
            // working; with none, use the DLL beside the executable.
            dll_path: option("dllPath").unwrap_or_else(default_dll_path),
            vulkan: string_option("inferenceBackend") == Some("vulkan"),
            animate: string_option("generationMode") == Some("animate"),
            attention: match string_option("attention") {
                Some("exact") => "exact",
                Some("flash2") => "flash2",
                _ => "sage2",
            },
            models: [
                (0, "transformer", option("transformer")),
                (1, "textEncoder", option("textEncoder")),
                (2, "tokenizer", option("tokenizer")),
                (3, "videoVae", option("videoVae")),
                (4, "audioVae", option("audioVae")),
            ],
            loras: match slopfab.and_then(|setting| setting.options.get("loras")) {
                None => Ok(Vec::new()),
                Some(ProviderOption::String(value)) => serde_json::from_str::<Vec<LoraAdapter>>(value)
                    .map_err(|error| format!("Invalid LoRA settings: {error}")),
                _ => Err("LoRA settings must be a JSON array of paths and strengths.".into()),
            },
            step_override: match slopfab.and_then(|setting| setting.options.get("stepOverride")) {
                None => Ok(None),
                Some(ProviderOption::Number(value)) if value.is_finite() && value.fract() == 0.0 && *value >= 2.0 && *value <= i32::MAX as f64 => Ok(Some(*value as i32)),
                _ => Err("LoRA step override must be a whole number from 2 to 2147483647.".into()),
            },
        }
    }

    fn validate_inputs(&self, request: &GenerationRequest) -> Result<(), String> {
        if self.animate {
            if request.still_image {
                return Err("Animate requires video generation.".into());
            }
            if request.reference_video_ids.is_empty() {
                return Err("Animate requires a reference video.".into());
            }
        } else if request.prompt.trim().is_empty() {
            return Err("Generation prompt cannot be empty.".into());
        }
        Ok(())
    }

    fn generation_steps(&self, fallback: i32) -> Result<i32, String> {
        self.step_override.clone().map(|steps| steps.unwrap_or(fallback))
    }

    fn platform(&self, detected: ComputePlatform) -> ComputePlatform {
        if self.vulkan {
            ComputePlatform::Vulkan
        } else {
            detected
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
        let adapters = self.loras.as_ref().map(|loras| loras.iter()
            .map(|lora| format!("{}@{}", lora.path, lora.strength)).collect::<Vec<_>>().join(";")).unwrap_or_default();
        format!("slopfab={version}|platform={}|attention={}|{models}|loras={adapters}|steps={:?}", platform.label(), self.attention, self.step_override)
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
                let detected = detect_platform(&api);
                let platform = configuration.platform(detected);
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
                    cuda_available: detected != ComputePlatform::Vulkan,
                    cuda_device_names: ffi::cuda_device_names(),
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
                cuda_available: false,
                cuda_device_names: Vec::new(),
                detail: error,
                models,
            },
        },
        Err(error) => SlopfabStatus {
            state: "runtimeMissing",
            dll_path,
            version: None,
            platform: None,
            cuda_available: false,
            cuda_device_names: Vec::new(),
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
    let platform = configuration.platform(detect_platform(&api));
    let handle = RequestHandle::new(&api)?;
    configure_request(&api, handle.0, request, &configuration, platform, false)?;
    let plan = api.resolve(handle.0)?;
    let description = api.describe(handle.0)?;
    let (_, frames) = scene_frame_window(request, plan.aligned_frames)?;
    Ok(ResolvedPlan {
        canvas_width: plan.canvas_width,
        canvas_height: plan.canvas_height,
        aligned_frames: frames,
        duration_seconds: plan.duration_seconds * frames as f64 / plan.aligned_frames as f64,
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
    if request.reference_paths.len() > 9 || request.reference_video_ids.len() > 3 || request.reference_count() > 12 {
        return Err("Use at most nine images and three videos per generation.".into());
    }
    if request.still_image && !request.reference_video_ids.is_empty() {
        return Err("Video references cannot be used for still-image generation.".into());
    }
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
    configuration.validate_inputs(request)?;
    api.set_prompt(handle, if configuration.animate { ANIMATE_PROMPT } else { &request.prompt })?;
    api.set_frames(handle, request.frames)?;
    if request.still_image {
        api.set_still_image(handle)?;
    }
    api.set_steps(handle, configuration.generation_steps(request.steps)?)?;
    api.set_seed(handle, generation_seed(request.seed)?)?;
    api.set_resolution(handle, request.canvas_width, request.canvas_height)?;
    api.set_inference_backend(handle, platform.backend())?;
    api.set_attention(handle, configuration.attention)?;
    api.set_verbose(handle, false)?;
    if let Some(path) = &request.continuation_path {
        api.set_continuation_file(handle, path, 22)?;
    }
    if include_models {
        if let Some(path) = &request.save_latents_path {
            api.set_save_latents(handle, path)?;
        }
    }
    for lora in configuration.loras.as_ref().map_err(Clone::clone)? {
        if lora.path.trim().is_empty() || !lora.strength.is_finite() {
            return Err("LoRA paths must be nonempty and strengths finite.".into());
        }
        if lora.strength == 0.0 { continue; }
        if include_models && !Path::new(&lora.path).is_file() {
            return Err(format!("LoRA file is missing: {}", lora.path));
        }
        api.add_lora(handle, Path::new(&lora.path), lora.strength)?;
    }
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
    }
    for path in &request.reference_paths {
        api.add_reference(handle, Path::new(path))?;
    }
    if !request.reference_video_ids.is_empty() {
        let videos = REFERENCE_VIDEOS.lock().map_err(|_| "Reference video lock failed.")?;
        for id in &request.reference_video_ids {
            videos.get(id).ok_or("The prepared reference video no longer exists. Please retry generation.")?
                .attach(handle, &configuration.dll_path)?;
        }
    }
    for refmod in &request.refmods {
        if refmod.path.trim().is_empty() || !refmod.strength.is_finite() || !(0.0..=1.0).contains(&refmod.strength)
            || !(1..=10).contains(&refmod.copies) {
            return Err("Refmods need a path, strength 0 to 1 and copies 1 to 10.".into());
        }
        if refmod.strength == 0.0 { continue; }
        api.add_refmod(handle, Path::new(&refmod.path), refmod.strength, refmod.copies as i32)?;
    }
    Ok(())
}

/// Continuation output is cumulative. Expose only the new scene to the editor,
/// while the DLL saves the full archive for the next continuation.
fn scene_frame_window(request: &GenerationRequest, total: i32) -> Result<(i32, i32), String> {
    if total <= 0 { return Err("Slopfab returned no video frames.".into()); }
    if request.continuation_path.is_none() { return Ok((0, total)); }
    if request.frames <= 0 { return Err("Continuation needs a positive frame count.".into()); }
    let frames = request.frames.checked_add(16).ok_or("Continuation frame count overflow.")? / 17 * 17;
    let offset = total.checked_sub(frames).filter(|offset| *offset >= 22)
        .ok_or("Slopfab continuation output is missing its source frames.".to_string())?;
    Ok((offset, frames))
}

fn scene_audio_offset(frame_offset: i32, fps: f64, channels: i32, sample_rate: i32, total: usize) -> Result<usize, String> {
    if total == 0 || frame_offset == 0 { return Ok(0); }
    if !fps.is_finite() || fps <= 0.0 || channels <= 0 || sample_rate <= 0 {
        return Err("Slopfab returned invalid continuation audio timing.".into());
    }
    let samples = (frame_offset as f64 * sample_rate as f64 / fps).round();
    let offset = (samples as usize).checked_mul(channels as usize)
        .filter(|offset| *offset <= total).ok_or("Slopfab continuation audio is shorter than its source scene.")?;
    Ok(offset)
}

/// Runs one generation and retains its terminal handle for frame streaming.
/// Audio is copied once; video stays owned by slopfab until encoding completes.
struct FinishedGeneration {
    api: ffi::Api,
    generation: *mut ffi::Generation,
    frame_offset: u32,
}

// Created by the serial worker and moved into a mutex-protected render store
// only after reaching a terminal state. Finished output is read-only.
unsafe impl Send for FinishedGeneration {}

impl rendered::FrameSource for FinishedGeneration {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let index = index.checked_add(self.frame_offset).ok_or("Continuation frame index overflow.")?;
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
    let platform = item.configuration.platform(detect_platform(&api));
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
        reference_count: item.request.reference_count(),
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
    unsafe { drop(Box::from_raw(context_ptr)) };
    drop(request);
    let mut source = Box::new(FinishedGeneration { api, generation, frame_offset: 0 });
    let (frame_offset, frames) = scene_frame_window(&item.request, output.frames)?;
    source.frame_offset = frame_offset as u32;
    if output.audio.is_null() && output.audio_float_count != 0 {
        return Err("Slopfab returned a null audio buffer with a non-zero size.".into());
    }
    // Audio is small enough to own directly. Video remains in the generation
    // and is converted through frame_rgba8 only as WebCodecs asks for it.
    let audio_offset = scene_audio_offset(frame_offset, output.fps, output.audio_channels, output.audio_sample_rate, output.audio_float_count)?;
    let audio = if output.audio.is_null() {
        &[][..]
    } else {
        &(unsafe { std::slice::from_raw_parts(output.audio, output.audio_float_count) })[audio_offset..]
    };
    let metadata = OutputMetadata {
        frames, width: output.width, height: output.height, fps: output.fps,
        audio_channels: output.audio_channels, audio_sample_rate: output.audio_sample_rate,
        audio_samples: audio.len(),
        reference_count: item.request.reference_count(),
        timing_profile,
        seconds_conditioning: output.seconds_conditioning,
        seconds_denoise: output.seconds_denoise,
        seconds_video_decode: output.seconds_video_decode,
        seconds_audio_decode: output.seconds_audio_decode,
        seconds_total: output.seconds_total,
        steps_computed: output.steps_computed,
        steps_skipped: output.steps_skipped,
        duration_seconds: if output.fps > 0.0 {
            frames as f64 / output.fps
        } else {
            0.0
        },
        boundary: "Latents are saved in the project. Decoded buffers remain owned by slopfab; the webview encodes the new scene's frames on demand.",
    };
    let pictures = rendered::from_source(
        &item.request.job_id,
        source,
        audio,
        frames as u32,
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
        steps: crate::reference_icons::STEPS,
        seed: i64::try_from(spec.seed)
            .map_err(|_| format!("Icon '{}' seed is too large.", spec.id))?,
        canvas_width: crate::reference_icons::RENDER_SIZE as i32,
        canvas_height: crate::reference_icons::RENDER_SIZE as i32,
        reference_paths: Vec::new(),
        refmods: Vec::new(),
        reference_video_ids: Vec::new(),
        ..Default::default()
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
    let render_size = crate::reference_icons::RENDER_SIZE;
    if output.width != render_size as i32 || output.height != render_size as i32 || output.frames != 1 {
        return Err(format!(
            "Icon '{}' returned {}x{} with {} frames.",
            spec.id, output.width, output.height, output.frames
        ));
    }
    let rgba = api.frame_rgba8(generation.0, 0, render_size, render_size)?;
    let jpeg = crate::reference_icons::encode_jpeg(&rgba)?;
    if let Some(parent) = spec.destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Could not create icon folder '{}': {error}",
                parent.display()
            )
        })?;
    }
    std::fs::write(&spec.destination, jpeg).map_err(|error| {
        format!(
            "Could not create icon '{}': {error}",
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
        loras: Ok(Vec::new()),
        step_override: Ok(None),
        vulkan: backend == ComputePlatform::Vulkan,
        attention: "sage2",
        animate: false,
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
    enum ReferenceVideo {}
    type VideoCreate = unsafe extern "C" fn(f64, *mut *mut ReferenceVideo) -> i32;
    type VideoDestroy = unsafe extern "C" fn(*mut ReferenceVideo);
    type VideoAppend = unsafe extern "C" fn(*mut ReferenceVideo, *const u8, usize, i32, i32, usize, f64) -> i32;
    type VideoAudio = unsafe extern "C" fn(*mut ReferenceVideo, *const f32, usize, i32, i32, f64) -> i32;
    type VideoAttach = unsafe extern "C" fn(*mut Request, *const ReferenceVideo) -> i32;

    pub struct ReferenceVideoHandle {
        api: Api,
        handle: *mut ReferenceVideo,
        destroy: VideoDestroy,
        append_rgba: VideoAppend,
        audio: VideoAudio,
        attach_video: VideoAttach,
        dll_path: std::path::PathBuf,
        frames: usize,
    }

    // The registry mutex serializes access. The DLL handle and all copied input
    // buffers outlive every call, and attached snapshots own their references.
    unsafe impl Send for ReferenceVideoHandle {}

    impl ReferenceVideoHandle {
        pub fn new(api: Api, duration: f64, dll_path: std::path::PathBuf) -> Result<Self, String> {
            unsafe {
                let missing = |error| format!("This slopfab.dll does not support video references. Update the runtime: {error}");
                let create = *api._library.get::<VideoCreate>(b"slopfab_reference_video_create\0").map_err(missing)?;
                let destroy = *api._library.get::<VideoDestroy>(b"slopfab_reference_video_destroy\0").map_err(missing)?;
                let append_rgba = *api._library.get::<VideoAppend>(b"slopfab_reference_video_append_rgba8\0").map_err(missing)?;
                let audio = *api._library.get::<VideoAudio>(b"slopfab_reference_video_set_audio_f32\0").map_err(missing)?;
                let attach_video = *api._library.get::<VideoAttach>(b"slopfab_request_add_reference_video\0").map_err(missing)?;
                let mut handle = std::ptr::null_mut();
                api.error(create(duration, &mut handle))?;
                if handle.is_null() { return Err("slopfab returned an empty reference video handle.".into()); }
                Ok(Self { api, handle, destroy, append_rgba, audio, attach_video, dll_path, frames: 0 })
            }
        }
        pub fn append(&mut self, bytes: &[u8], width: i32, height: i32, timestamp: f64) -> Result<(), String> {
            if width <= 0 || height <= 0 || width > 1024 || height > 1024 || self.frames >= 361 {
                return Err("Reference video preparation exceeds the frame or dimension limit.".into());
            }
            self.api.error(unsafe { (self.append_rgba)(self.handle, bytes.as_ptr(), bytes.len(), width, height, width as usize * 4, timestamp) })?;
            self.frames += 1;
            Ok(())
        }
        pub fn set_audio(&mut self, samples: &[f32], channels: i32, sample_rate: i32) -> Result<(), String> {
            self.api.error(unsafe { (self.audio)(self.handle, samples.as_ptr(), samples.len(), channels, sample_rate, 0.0) })
        }
        pub fn attach(&self, request: *mut Request, dll_path: &Path) -> Result<(), String> {
            if dll_path != self.dll_path { return Err("Reference video and generation must use the same slopfab runtime.".into()); }
            self.api.error(unsafe { (self.attach_video)(request, self.handle) })
        }
    }
    impl Drop for ReferenceVideoHandle {
        fn drop(&mut self) { unsafe { (self.destroy)(self.handle) }; }
    }

    pub fn has_cuda_device() -> bool {
        // CUDA's driver API uses the system calling convention on Windows.
        // Keep the library alive until both calls have returned.
        unsafe {
            #[cfg(windows)]
            let driver = libloading::os::windows::Library::load_with_flags(
                "nvcuda.dll", 0x00000800, // LOAD_LIBRARY_SEARCH_SYSTEM32
            ).map(Library::from);
            #[cfg(not(windows))]
            let driver = Library::new("libcuda.so.1");
            let Ok(library) = driver else { return false };
            let Ok(init) = library.get::<unsafe extern "system" fn(u32) -> i32>(b"cuInit\0") else { return false };
            let Ok(count) = library.get::<unsafe extern "system" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0") else { return false };
            let mut devices = 0;
            init(0) == 0 && count(&mut devices) == 0 && devices > 0
        }
    }
    pub fn cuda_device_names() -> Vec<String> {
        gpu_devices().into_iter().map(|device| device.name).collect()
    }

    pub fn gpu_devices() -> Vec<super::GpuDevice> {
        // The display driver's API is available without the CUDA toolkit.
        // Keep the library and fixed-size name buffer alive for every call.
        unsafe {
            #[cfg(windows)]
            let driver = libloading::os::windows::Library::load_with_flags(
                "nvcuda.dll", 0x00000800, // LOAD_LIBRARY_SEARCH_SYSTEM32
            ).map(Library::from);
            #[cfg(not(windows))]
            let driver = Library::new("libcuda.so.1");
            let Ok(library) = driver else { return Vec::new() };
            let Ok(init) = library.get::<unsafe extern "system" fn(u32) -> i32>(b"cuInit\0") else { return Vec::new() };
            let Ok(count) = library.get::<unsafe extern "system" fn(*mut i32) -> i32>(b"cuDeviceGetCount\0") else { return Vec::new() };
            let Ok(get) = library.get::<unsafe extern "system" fn(*mut i32, i32) -> i32>(b"cuDeviceGet\0") else { return Vec::new() };
            let Ok(name) = library.get::<unsafe extern "system" fn(*mut c_char, i32, i32) -> i32>(b"cuDeviceGetName\0") else { return Vec::new() };
            let memory = library.get::<unsafe extern "system" fn(*mut usize, i32) -> i32>(b"cuDeviceTotalMem_v2\0").ok();
            let mut count_value = 0;
            if init(0) != 0 || count(&mut count_value) != 0 { return Vec::new() }
            (0..count_value).filter_map(|ordinal| {
                let mut device = 0;
                let mut buffer = [0u8; 256];
                if get(&mut device, ordinal) != 0 || name(buffer.as_mut_ptr().cast(), buffer.len() as i32, device) != 0 {
                    return None;
                }
                let end = buffer.iter().position(|byte| *byte == 0).unwrap_or(buffer.len());
                let mut memory_bytes = 0usize;
                if let Some(memory) = &memory { if memory(&mut memory_bytes, device) != 0 { memory_bytes = 0; } }
                Some(super::GpuDevice { name: String::from_utf8_lossy(&buffer[..end]).into_owned(), memory_bytes: memory_bytes as u64 })
            }).collect()
        }
    }

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
        set_save_latents: Option<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>,
        set_continuation_file: Option<unsafe extern "C" fn(*mut Request, *const c_char, i32) -> i32>,
        set_steps: unsafe extern "C" fn(*mut Request, i32) -> i32,
        set_seed: unsafe extern "C" fn(*mut Request, u64) -> i32,
        set_model: unsafe extern "C" fn(*mut Request, i32, *const c_char) -> i32,
        add_lora: Option<unsafe extern "C" fn(*mut Request, *const c_char, f32) -> i32>,
        add_refmod: Option<unsafe extern "C" fn(*mut Request, *const c_char, f32, i32) -> i32>,
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
                    add_lora: library
                        .get::<unsafe extern "C" fn(*mut Request, *const c_char, f32) -> i32>(b"slopfab_request_add_lora\0")
                        .ok().map(|symbol| *symbol),
                    set_save_latents: library
                        .get::<unsafe extern "C" fn(*mut Request, *const c_char) -> i32>(b"slopfab_request_set_save_latents\0")
                        .ok().map(|symbol| *symbol),
                    set_continuation_file: library
                        .get::<unsafe extern "C" fn(*mut Request, *const c_char, i32) -> i32>(b"slopfab_request_set_continuation_file\0")
                        .ok().map(|symbol| *symbol),
                    add_refmod: library
                        .get::<unsafe extern "C" fn(*mut Request, *const c_char, f32, i32) -> i32>(b"slopfab_request_add_refmod\0")
                        .ok().map(|symbol| *symbol),
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
        pub fn set_save_latents(&self, r: *mut Request, path: &Path) -> Result<(), String> {
            let set = self.set_save_latents.ok_or("Saving generation latents requires slopfab.dll API 1.9 or later. Update the runtime.")?;
            let path = path_cstring(path)?;
            self.error(unsafe { set(r, path.as_ptr()) })
        }
        pub fn set_continuation_file(&self, r: *mut Request, path: &Path, overlap: i32) -> Result<(), String> {
            let set = self.set_continuation_file.ok_or("Scene continuation requires slopfab.dll API 1.9 or later. Update the runtime.")?;
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
        pub fn add_lora(&self, r: *mut Request, path: &Path, strength: f32) -> Result<(), String> {
            let add = self.add_lora.ok_or("This slopfab.dll does not support LoRAs. Update the DLL or disable the selected LoRAs.")?;
            let path = path_cstring(path)?;
            self.error(unsafe { add(r, path.as_ptr(), strength) })
        }
        pub fn add_refmod(&self, r: *mut Request, path: &Path, strength: f32, copies: i32) -> Result<(), String> {
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
    fn animate_requires_video_and_prompt_mode_requires_text() {
        let mut configuration = Configuration::from_settings(&BTreeMap::new());
        let mut request = GenerationRequest::default();
        assert!(configuration.validate_inputs(&request).unwrap_err().contains("prompt"));
        configuration.animate = true;
        assert!(configuration.validate_inputs(&request).unwrap_err().contains("reference video"));
        request.reference_paths.push("image.png".into());
        assert!(configuration.validate_inputs(&request).is_err());
        request.reference_video_ids.push("video".into());
        configuration.validate_inputs(&request).unwrap();
        request.still_image = true;
        assert!(configuration.validate_inputs(&request).unwrap_err().contains("video generation"));
    }

    #[test]
    fn animate_fixed_prompt_and_four_steps_reach_bundled_dll() {
        let settings = BTreeMap::from([("slopfab".into(), ProviderSetting {
            enabled: true, model: None,
            options: BTreeMap::from([
                ("generationMode".into(), ProviderOption::String("animate".into())),
                ("stepOverride".into(), ProviderOption::Number(4.0)),
            ]),
        })]);
        let configuration = Configuration::from_settings(&settings);
        let api = ffi::Api::load(&configuration.dll_path).unwrap();
        let id = create_reference_video(2.0, &settings).unwrap();
        let result = (|| -> Result<(), String> {
            append_reference_video(&id, &vec![127; 64 * 64 * 4], 64, 64, 0.0)?;
            let mut request = GenerationRequest {
                job_id: "animate-test".into(), frames: 48, steps: 20, seed: 1,
                canvas_width: 736, canvas_height: 416, reference_video_ids: vec![id.clone()],
                ..Default::default()
            };
            for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
                for include_models in [false, true] {
                    let handle = RequestHandle::new(&api)?;
                    configure_request(&api, handle.0, &request, &configuration, platform, include_models)?;
                    assert_eq!(api.resolve(handle.0)?.num_model_evaluations, 3);
                    assert!(api.describe(handle.0)?.contains(&format!("prompt              {} characters", ANIMATE_PROMPT.len())));
                    request.prompt = "This scene prompt must be ignored by Animate.".into();
                    let handle = RequestHandle::new(&api)?;
                    configure_request(&api, handle.0, &request, &configuration, platform, include_models)?;
                    assert!(api.describe(handle.0)?.contains(&format!("prompt              {} characters", ANIMATE_PROMPT.len())));
                    request.prompt.clear();
                }
            }
            Ok(())
        })();
        release_reference_videos(&[id]).unwrap();
        result.unwrap();
    }

    #[test]
    fn continuation_uses_22_frames_and_plans_only_the_new_scene() {
        // An independent 39-frame, 64x32 archive exercises the real DLL without
        // loading model weights. Its sampling window should be 22 + 34 frames.
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("previous.safetensors");
        let video_bytes = 24 * 96 * 4;
        let audio_bytes = 130 * 32 * 4;
        let mut header = serde_json::json!({
            "__metadata__": { "slopfab_latents": "h3-av-v1", "width": "64", "height": "32", "frames": "39", "fps": "24", "sampled": "1" },
            "video_rows": { "dtype": "F32", "shape": [24, 96], "data_offsets": [0, video_bytes] },
            "audio_rows": { "dtype": "F32", "shape": [130, 32], "data_offsets": [video_bytes, video_bytes + audio_bytes] },
        }).to_string();
        while header.len() % 8 != 0 { header.push(' '); }
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        bytes.resize(bytes.len() + video_bytes + audio_bytes, 0);
        std::fs::write(&path, bytes).unwrap();
        let mut request = GenerationRequest {
            job_id: "continued".into(), prompt: "The camera keeps moving.".into(),
            frames: 18, steps: 4, seed: 1, canvas_width: 64, canvas_height: 32,
            continuation_path: Some(path.clone()), save_latents_path: Some(root.path().join("next.safetensors")),
            ..Default::default()
        };
        let settings = BTreeMap::new();
        let configuration = Configuration::from_settings(&settings);
        let api = ffi::Api::load(&configuration.dll_path).unwrap();
        for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
            let handle = RequestHandle::new(&api).unwrap();
            configure_request(&api, handle.0, &request, &configuration, platform, true).unwrap();
            let raw = api.resolve(handle.0).unwrap();
            assert_eq!(raw.aligned_frames, 73);
            assert_eq!(raw.latent_frames, 17); // 56-frame window, including 22 overlap.
            assert_eq!(scene_frame_window(&request, raw.aligned_frames).unwrap(), (39, 34));
        }
        let plan = resolve_plan(&request, &settings).unwrap();
        assert_eq!(plan.aligned_frames, 34);
        assert!((plan.duration_seconds - 34.0 / 24.0).abs() < 1e-6);
        assert!(!request.save_latents_path.as_ref().unwrap().exists()); // Planning never writes.
        request.canvas_width = 128;
        assert!(resolve_plan(&request, &settings).is_err());
        request.canvas_width = 64;
        std::fs::write(&path, b"invalid archive").unwrap();
        assert!(resolve_plan(&request, &settings).is_err());
    }

    #[test]
    fn continuation_video_and_audio_skip_the_cumulative_source() {
        let mut request = GenerationRequest { frames: 119, continuation_path: Some("source".into()), ..Default::default() };
        assert_eq!(scene_frame_window(&request, 243).unwrap(), (124, 119));
        // A further continuation skips the full joined source, not just its last scene.
        assert_eq!(scene_frame_window(&request, 362).unwrap(), (243, 119));
        assert_eq!(scene_audio_offset(124, 24.0, 2, 48_000, 972_000).unwrap(), 496_000);
        assert_eq!(scene_audio_offset(243, 24.0, 2, 44_100, 2_000_000).unwrap(), 893_026);
        assert_eq!(scene_audio_offset(124, 24.0, 0, 0, 0).unwrap(), 0);
        assert!(scene_audio_offset(124, 24.0, 2, 48_000, 100).is_err());
        assert!(scene_frame_window(&request, 120).is_err());
        request.continuation_path = None;
        assert_eq!(scene_frame_window(&request, 124).unwrap(), (0, 124));
    }

    #[test]
    fn refmods_attach_for_plans_and_icons_or_report_an_older_dll() {
        let configuration = Configuration::from_settings(&BTreeMap::new());
        let api = ffi::Api::load(&configuration.dll_path).unwrap();
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("person.safetensors");
        let header = serde_json::json!({
            "__metadata__": { "refmod_meta": serde_json::json!({ "kind": "image", "name": "Person", "_format_version": 4 }).to_string() },
            "latent": { "dtype": "F32", "shape": [1, 24, 1, 2, 2], "data_offsets": [0, 384] }
        }).to_string();
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend_from_slice(header.as_bytes());
        for _ in 0..96 { bytes.extend_from_slice(&0.25_f32.to_le_bytes()); }
        std::fs::write(&file, bytes).unwrap();
        let mut request = GenerationRequest {
            job_id: "refmod-test".into(), prompt: "A portrait.".into(), still_image: true, frames: 1,
            steps: 20, seed: 1, canvas_width: 768, canvas_height: 768,
            reference_paths: Vec::new(), reference_video_ids: Vec::new(),
            refmods: vec![RefmodInput { path: file.to_string_lossy().into_owned(), strength: 0.7, copies: 2 }],
            ..Default::default()
        };
        let probe = RequestHandle::new(&api).unwrap();
        let added = api.add_refmod(probe.0, &file, 0.7, 2);
        if let Err(error) = &added {
            assert!(error.contains("does not support refmods"), "{error}");
            eprintln!("Refmod export not yet available in the installed DLL; checked compatibility error.");
            assert!(configure_request(&api, probe.0, &request, &configuration, ComputePlatform::Vulkan, false).unwrap_err().contains("does not support refmods"));
        } else {
            for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
                for still_image in [false, true] {
                    request.still_image = still_image;
                    request.frames = if still_image { 1 } else { 120 };
                    for include_models in [false, true] {
                        let handle = RequestHandle::new(&api).unwrap();
                        configure_request(&api, handle.0, &request, &configuration, platform, include_models).unwrap();
                        let plan = api.resolve(handle.0).unwrap();
                        assert!(plan.aligned_frames >= request.frames);
                    }
                }
            }
        }
        request.refmods[0].strength = 0.0;
        std::fs::remove_file(&file).unwrap();
        let handle = RequestHandle::new(&api).unwrap();
        configure_request(&api, handle.0, &request, &configuration, ComputePlatform::Vulkan, true).unwrap();
        request.refmods[0].copies = 11;
        assert!(configure_request(&api, handle.0, &request, &configuration, ComputePlatform::Vulkan, false).is_err());
    }

    #[test]
    fn ordered_loras_and_step_override_reach_cuda_and_vulkan_requests() {
        let root = tempfile::tempdir().unwrap();
        let paths = [root.path().join("style.safetensors"), root.path().join("TaoMate.safetensors")];
        for path in &paths { std::fs::write(path, b"planning does not load weights").unwrap(); }
        let settings = BTreeMap::from([("slopfab".into(), ProviderSetting {
            enabled: true, model: None,
            options: BTreeMap::from([
                ("loras".into(), ProviderOption::String(serde_json::json!([
                    { "path": paths[0], "strength": -0.5 },
                    { "path": paths[1], "strength": 1.0 },
                ]).to_string())),
                ("stepOverride".into(), ProviderOption::Number(8.0)),
            ]),
        })]);
        let configuration = Configuration::from_settings(&settings);
        let api = ffi::Api::load(&configuration.dll_path).unwrap();
        let request = GenerationRequest {
            job_id: "lora-test".into(), prompt: "A quiet harbour.".into(),
            frames: 120, still_image: false, steps: 20, seed: 1,
            canvas_width: 736, canvas_height: 416,
            reference_paths: Vec::new(), reference_video_ids: Vec::new(),
            refmods: Vec::new(),
            ..Default::default()
        };
        for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
            for include_models in [false, true] {
                let handle = RequestHandle::new(&api).unwrap();
                configure_request(&api, handle.0, &request, &configuration, platform, include_models).unwrap();
                assert_eq!(api.resolve(handle.0).unwrap().num_model_evaluations, 7);
                let description = api.describe(handle.0).unwrap();
                assert!(!description.contains("taomate-3step"));
                assert!(description.find("style.safetensors").unwrap() < description.find("TaoMate.safetensors").unwrap());
                assert!(description.contains("strength -0.5"));
            }
        }
        let invalid = BTreeMap::from([("slopfab".into(), ProviderSetting {
            enabled: true, model: None,
            options: BTreeMap::from([("loras".into(), ProviderOption::String("invalid JSON".into()))]),
        })]);
        assert!(Configuration::from_settings(&invalid).loras.is_err());
        std::fs::remove_file(&paths[0]).unwrap();
        let handle = RequestHandle::new(&api).unwrap();
        assert!(configure_request(&api, handle.0, &request, &configuration, ComputePlatform::Vulkan, true).unwrap_err().contains("LoRA file is missing"));
    }

    #[test]
    fn vulkan_video_references_prepare_and_attach_for_planning_and_generation() {
        let settings = BTreeMap::from([("slopfab".into(), ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([("inferenceBackend".into(), ProviderOption::String("vulkan".into()))]),
        })]);
        let id = create_reference_video(2.0, &settings).unwrap();
        let result = (|| -> Result<(), String> {
            append_reference_video(&id, &vec![127; 64 * 64 * 4], 64, 64, 0.0)?;
            set_reference_video_audio(&id, &vec![0; 32_000 * 2 * 4], 1, 32_000)?;
            let request = GenerationRequest {
                job_id: "vulkan-reference-test".into(), prompt: "A scene using <Video 1>.".into(),
                frames: 120, still_image: false, steps: 12, seed: 1,
                canvas_width: 736, canvas_height: 416,
                reference_paths: Vec::new(), reference_video_ids: vec![id.clone()],
                refmods: Vec::new(),
                ..Default::default()
            };
            let configuration = Configuration::from_settings(&settings);
            let api = ffi::Api::load(&configuration.dll_path)?;
            for include_models in [false, true] {
                let handle = RequestHandle::new(&api)?;
                configure_request(&api, handle.0, &request, &configuration, ComputePlatform::Vulkan, include_models)?;
                assert!(api.resolve(handle.0)?.aligned_frames > 0);
            }
            Ok(())
        })();
        release_reference_videos(&[id]).unwrap();
        result.unwrap();
    }

    #[test]
    fn video_reference_c_api_copies_inputs_and_retains_attached_snapshot() {
        let path = default_dll_path();
        let api = ffi::Api::load(&path).unwrap();
        let request = RequestHandle::new(&api).unwrap();
        api.set_prompt(request.0, "A scene using <Video 1>.").unwrap();
        api.set_frames(request.0, 120).unwrap();
        api.set_resolution(request.0, 736, 416).unwrap();
        let mut video = ffi::ReferenceVideoHandle::new(ffi::Api::load(&path).unwrap(), 2.0, path.clone()).unwrap();
        let pixels = vec![127_u8; 64 * 64 * 4];
        video.append(&pixels, 64, 64, 0.0).unwrap();
        assert!(video.append(&pixels, 64, 64, 0.0).is_err());
        assert!(video.append(&pixels[..10], 64, 64, 0.5).is_err());
        video.append(&pixels, 64, 64, 1.0).unwrap();
        video.set_audio(&vec![0.0; 32_000 * 2], 1, 32_000).unwrap();
        video.attach(request.0, &path).unwrap();
        drop(video);
        drop(pixels);
        // Plan resolution reads the retained video/audio snapshot without a
        // neural model or a CUDA allocation, even after the host releases it.
        let plan = api.resolve(request.0).unwrap();
        assert!(plan.aligned_frames > 0);
    }

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
    }

    #[test]
    fn backend_preference_cannot_enable_cuda_without_cuda_hardware() {
        let mut config = Configuration::from_settings(&BTreeMap::new());
        assert_eq!(config.platform(ComputePlatform::Cuda13), ComputePlatform::Cuda13);
        assert_eq!(config.platform(ComputePlatform::Cuda12), ComputePlatform::Cuda12);
        assert_eq!(config.platform(ComputePlatform::Vulkan), ComputePlatform::Vulkan);
        config.vulkan = true;
        for detected in [ComputePlatform::Cuda13, ComputePlatform::Cuda12, ComputePlatform::Vulkan] {
            assert_eq!(config.platform(detected), ComputePlatform::Vulkan);
        }
    }

    #[test]
    fn attention_defaults_to_sage_and_is_independent_of_backend() {
        assert_eq!(Configuration::from_settings(&BTreeMap::new()).attention, "sage2");
        for backend in ["cuda", "vulkan"] {
            for attention in ["exact", "flash2", "sage2", "invalid"] {
                let settings = serde_json::from_value(serde_json::json!({
                    "slopfab": { "enabled": true, "model": null,
                        "options": { "inferenceBackend": backend, "attention": attention } }
                })).unwrap();
                let config = Configuration::from_settings(&settings);
                let expected = if attention == "invalid" { "sage2" } else { attention };
                assert_eq!(config.attention, expected);
                assert_eq!(config.vulkan, backend == "vulkan");
                assert!(config.timing_profile("1.4.0", ComputePlatform::Vulkan).contains(&format!("attention={expected}|")));
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn bundled_dll_reports_a_compatible_api() {
        assert!(default_dll_path().is_file(), "The build must stage slopfab.dll beside the executable.");
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
            "steps": 20, "seed": 1, "canvasWidth": 768, "canvasHeight": 768
        })).unwrap();
        let plan = resolve_plan(&request, &BTreeMap::new()).unwrap();
        assert_eq!(plan.aligned_frames, 1);
        assert_eq!(plan.latent_frames, 1);
        assert_eq!((plan.canvas_width, plan.canvas_height), (768, 768));
    }

    #[test]
    fn bundled_dll_accepts_all_attention_modes_on_both_backends() {
        if !default_dll_path().is_file() { return; }
        let api = ffi::Api::load(&default_dll_path()).unwrap();
        let request: GenerationRequest = serde_json::from_value(serde_json::json!({
            "jobId": "attention-plan", "prompt": "A red toy car", "frames": 1, "stillImage": true,
            "steps": 20, "seed": 1, "canvasWidth": 768, "canvasHeight": 768
        })).unwrap();
        let mut config = Configuration::from_settings(&BTreeMap::new());
        for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
            for attention in ["exact", "flash2", "sage2"] {
                config.attention = attention;
                let handle = RequestHandle::new(&api).unwrap();
                configure_request(&api, handle.0, &request, &config, platform, false).unwrap();
                assert_eq!(api.resolve(handle.0).unwrap().aligned_frames, 1);
            }
        }
    }
    #[test]
    fn generation_seed_accepts_random_and_non_negative_values() {
        assert!(generation_seed(-1).is_ok());
        assert_eq!(generation_seed(0).unwrap(), 0);
        assert_eq!(generation_seed(482_091).unwrap(), 482_091);
        assert!(generation_seed(-2).is_err());
    }
}
