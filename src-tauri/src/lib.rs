mod agent;
mod agent_commands;
mod app_paths;
mod app_settings;
mod cuda_support;
mod conditioning;
mod diagnostics;
mod export;
mod reference_icons;
mod rendered;
mod slopfab;
mod weights;
mod app;
mod commands;
mod media;
mod project;
mod storage;
mod window;

pub use app::run;
pub use slopfab::{default_dll_path, generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};

use project::*;
use project::validation::validate_and_normalize_config;
use project::storage::{LEGACY_PROJECT_FILE_NAMES, PROJECT_FILE_NAME};
use project::paths::display_path;

#[cfg(test)]
mod tests;
