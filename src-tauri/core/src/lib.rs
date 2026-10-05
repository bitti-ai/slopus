//! The Slopus generation runtime, shared by the desktop app and the headless
//! LAN worker. Nothing here depends on a UI framework: the app adds Tauri
//! commands on top, and `slopus-worker` serves the same runtime over HTTP.
pub mod conditioning;
pub mod diagnostics;
pub mod models;
pub mod names;
pub mod reference_icons;
pub mod rendered;
pub mod settings;
pub mod slopfab;
pub mod storage;
pub mod weights;
pub mod worker;
pub mod upscale_stream;

pub use slopfab::{default_dll_path, generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};
