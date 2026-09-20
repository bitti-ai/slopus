//! Native runtime adapter. Raw ABI and resource ownership are confined to ffi.
use std::path::{Path, PathBuf};
// Preparation atomically replaces adapters; model readers must be closed first.
pub(crate) static MODEL_ACCESS: std::sync::RwLock<()> = std::sync::RwLock::new(());

pub(crate) fn prepare_lora_grid(
    path: &Path,
    width: i32,
    allow_download: bool,
) -> Result<(), String> {
    ffi::Api::load(&default_dll_path())?.prepare_lora_grid(path, width, allow_download)
}
mod config;
mod events;
mod ffi;
mod generation;
mod h3;
mod icons;
mod planning;
mod platform;
mod references;
mod runtime;
mod status;
mod types;
pub use runtime::SlopfabRuntime;
pub use types::*;

pub use events::NativeEvent;
pub use icons::{generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};
pub use planning::resolve_plan;
pub use status::status;
const DLL_FILE_NAME: &str = "slopfab.dll";
/// Tauri stages the repository's runtime resources in development and release
/// builds. Installers and portable folders use the same relative layout.
pub fn default_dll_path() -> PathBuf {
    let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("Slopus.exe"));
    let directory = executable.parent().unwrap_or_else(|| Path::new("."));
    // Cargo test executables live one level below the staged resources.
    #[cfg(test)]
    let directory = if directory.file_name().is_some_and(|name| name == "deps") {
        directory.parent().unwrap_or(directory)
    } else {
        directory
    };
    directory.join(DLL_FILE_NAME)
}
const EXPECTED_CAPI_MAJOR: u32 = 1;
const NOT_READY: i32 = -7;
const CANCELLED: i32 = -8;

#[cfg(test)]
mod tests;
