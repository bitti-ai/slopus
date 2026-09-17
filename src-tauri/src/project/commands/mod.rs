//! Restricted, transactional editing operations shared by agent transports.
mod batch;
mod clips;
mod effects;
mod jsonl;
mod patch;
mod project;
mod references;
mod scenes;
mod shots;
mod types;
pub(crate) use batch::execute_commands_at;
pub(crate) use jsonl::parse_jsonl_commands;
pub(crate) use types::{CommandBatch, ProjectCommand};
#[cfg(test)]
mod tests;
pub(crate) use batch::execute_checked;
