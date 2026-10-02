//! LAN generation workers: the wire protocol both sides compile, and the
//! headless server `slopus-worker` runs. The desktop client lives in the app.
pub mod discovery;
pub mod protocol;
pub mod server;
pub mod store;

pub use protocol::{WorkerRuntime, DEFAULT_PORT};
pub use server::{run, WorkerOptions};
