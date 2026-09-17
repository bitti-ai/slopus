mod agent;
use project::commands as agent_commands;
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
mod generation;
mod commands;
mod media;
mod project;
mod storage;
mod window;

pub use app::run;
pub use slopfab::{default_dll_path, generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};


#[cfg(test)]
mod tests;
