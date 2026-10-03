//! The desktop side of LAN workers. The protocol and the worker itself are in
//! slopus-core, which `slopus-worker` uses without any UI framework.
mod client;

pub use client::{WorkerList, Workers};
