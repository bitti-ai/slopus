use super::*;

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
