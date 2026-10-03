use super::ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ComputePlatform {
    Cuda13,
    Cuda12,
    Vulkan,
}

impl ComputePlatform {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Cuda13 => "CUDA 13",
            Self::Cuda12 => "CUDA 12",
            Self::Vulkan => "Vulkan",
        }
    }

    pub(super) fn backend(self) -> i32 {
        match self {
            Self::Cuda13 | Self::Cuda12 => 0,
            Self::Vulkan => 1,
        }
    }
}

pub(super) fn platform_from_cuda_probe(result: Result<i32, String>) -> ComputePlatform {
    match result {
        Ok(13) => ComputePlatform::Cuda13,
        Ok(12) => ComputePlatform::Cuda12,
        _ => ComputePlatform::Vulkan,
    }
}

pub(super) fn detect_platform(api: &ffi::Api) -> ComputePlatform {
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

/// What the GPU backend choice depends on, for a host that picks it itself.
#[derive(Debug, Clone)]
pub struct BackendProbe {
    /// An NVIDIA GPU is present, whether or not CUDA can be used on it.
    pub nvidia_gpu: bool,
    /// "CUDA 13" or "CUDA 12" when the CUDA runtime loaded.
    pub cuda: Option<&'static str>,
    /// Why CUDA could not be used on an NVIDIA GPU.
    pub cuda_problem: Option<String>,
}

/// Probes the engine at `dll_path` for CUDA. `cuda_version` is "auto" (CUDA
/// 13, then 12), "13" or "12"; the engine fixes the toolkit for the whole
/// process on first use, so call this before any generation. Fails only when
/// the engine itself cannot be loaded.
pub fn probe_backend(dll_path: &std::path::Path, cuda_version: &str) -> Result<BackendProbe, String> {
    let api = ffi::Api::load(dll_path)?;
    api.version()?;
    let cuda_device = ffi::has_cuda_device();
    // The display adapter list also covers a driver that cannot start CUDA.
    let nvidia_gpu = cuda_device || crate::weights::hardware_devices().iter()
        .any(|device| device.name.to_ascii_lowercase().contains("nvidia"));
    if !cuda_device {
        let cuda_problem = nvidia_gpu.then(|| "the NVIDIA driver reports no CUDA device".to_string());
        return Ok(BackendProbe { nvidia_gpu, cuda: None, cuda_problem });
    }
    api.set_cuda_version(cuda_version)?;
    let major = api.cuda_loaded_major();
    // The toolkit choice lives in the loaded DLL. Keep this instance loaded
    // so later loads share it instead of starting over with "auto".
    std::mem::forget(api);
    Ok(match major {
        Ok(major) => match platform_from_cuda_probe(Ok(major)) {
            ComputePlatform::Vulkan => BackendProbe { nvidia_gpu, cuda: None, cuda_problem: Some(format!("CUDA {major} is not supported; install CUDA 12.8 or 13")) },
            platform => BackendProbe { nvidia_gpu, cuda: Some(platform.label()), cuda_problem: None },
        },
        Err(error) => BackendProbe { nvidia_gpu, cuda: None, cuda_problem: Some(error) },
    })
}
