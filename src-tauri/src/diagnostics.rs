//! Diagnostics are written by slopus-core; this adds where the app keeps them.
pub use slopus_core::diagnostics::*;
use std::path::PathBuf;
use tauri::AppHandle;

pub fn directory(app: &AppHandle) -> PathBuf {
    crate::app_paths::data_directory(app).join("logs")
}

pub fn initialize(app: &AppHandle) -> Result<DiagnosticLogInfo, String> {
    initialize_in(&directory(app))
}
