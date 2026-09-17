use super::*;

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
pub struct ProgressEvent {
    pub(super) job_id: String,
    pub(super) stage: &'static str,
    pub(super) step: i32,
    pub(super) total_steps: i32,
    pub(super) planned_steps: i32,
    pub(super) elapsed_seconds: f64,
    pub(super) frames: i32,
    pub(super) canvas_width: i32,
    pub(super) canvas_height: i32,
    pub(super) reference_count: usize,
    pub(super) timing_profile: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub(super) job_id: String,
    pub(super) state: &'static str,
    pub(super) detail: String,
    pub(super) output: Option<OutputMetadata>,
}

/// What came back, and what the webview needs in order to encode it: the
/// shape of the pictures now waiting in [`crate::rendered`], and how much sound
/// came with them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OutputMetadata {
    pub(super) frames: i32,
    pub(super) width: i32,
    pub(super) height: i32,
    pub(super) fps: f64,
    pub(super) audio_channels: i32,
    pub(super) audio_sample_rate: i32,
    /// Interleaved samples across every channel, so the webview can tell an
    /// empty soundtrack from one it has not read yet.
    pub(super) audio_samples: usize,
    pub(super) reference_count: usize,
    pub(super) timing_profile: String,
    pub(super) seconds_conditioning: f64,
    pub(super) seconds_denoise: f64,
    pub(super) seconds_video_decode: f64,
    pub(super) seconds_audio_decode: f64,
    pub(super) seconds_total: f64,
    pub(super) steps_computed: i32,
    pub(super) steps_skipped: i32,
    pub(super) duration_seconds: f64,
    pub(super) boundary: &'static str,
}

