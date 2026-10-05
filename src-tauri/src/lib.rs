mod agent;
mod app;
mod app_paths;
mod app_settings;
mod commands;
mod cuda_support;
mod diagnostics;
mod export;
mod external_links;
mod generation;
#[cfg(target_os = "linux")]
mod linux_webview;
mod media;
mod native_shell;
mod project;
mod slop;
mod updater_mode;
mod upscale;
mod weights;
mod window;
mod worker;

// The generation runtime is shared with the LAN worker through slopus-core.
use slopus_core::{conditioning, reference_icons, rendered, slopfab, storage};

pub use app::run;
pub use slopus_core::{default_dll_path, generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};

#[cfg(test)]
mod tests;
