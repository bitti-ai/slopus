//! LAN generation workers. A worker is this crate's generation queue run
//! headless on another computer (`slopus-worker`); Slopus finds it with mDNS
//! and sends it jobs. Weights with download URLs are fetched by the worker
//! itself, local-only files are uploaded, and finished frames and latents
//! come back to the project as if the job had run here.
mod client;
mod discovery;
mod protocol;
mod server;
mod store;

pub use client::{WorkerList, Workers};
pub use protocol::{WorkerRuntime, DEFAULT_PORT};
pub use server::{run, WorkerOptions};
