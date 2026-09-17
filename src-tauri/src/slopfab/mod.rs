//! Native runtime adapter. Raw ABI and resource ownership are confined to ffi.
use crate::{diagnostics, rendered};
use crate::project::{ProviderOption, ProviderSetting};
use getrandom::fill as fill_random;
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, HashMap},path::{Path, PathBuf},sync::{atomic::{AtomicBool, Ordering},mpsc,Arc,Mutex},thread};
mod types;
mod platform;
mod config;
mod status;
mod runtime;
mod references;
mod planning;
mod h3;
use h3::configure_request;
mod generation;
mod icons;
mod events;
mod ffi;
pub use types::*;
pub use runtime::SlopfabRuntime;
pub use references::*;
pub use planning::resolve_plan;
pub use status::status;
pub use icons::{generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};
pub use events::{EventSink, NativeEvent};
use platform::*;
use config::*;
use planning::*;
use runtime::QueueItem;
use generation::run_generation;
use events::*;
use ffi::RequestHandle;
const DLL_FILE_NAME: &str = "slopfab.dll";
// https://huggingface.co/Viggle/Viggle-Animate/raw/main/assets/fixed_prompt.txt
const ANIMATE_PROMPT: &str = include_str!("../../assets/viggle-animate-fixed-prompt.txt");
// SlopFab rounds up to 17*k + 5 frames but rejects Animate plans over 360.
const ANIMATE_MAX_ALIGNED_FRAMES: i32 = (360 - 5) / 17 * 17 + 5;
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

#[cfg(test)] mod tests;
