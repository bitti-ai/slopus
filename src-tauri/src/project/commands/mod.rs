//! Restricted, transactional editing operations shared by agent transports.
mod types;
mod patch;
mod jsonl;
mod batch;
mod effects;
mod project;
mod references;
mod scenes;
mod shots;
mod clips;
pub(crate) use types::{ProjectCommand, CommandBatch};
pub(crate) use jsonl::parse_jsonl_commands;
pub(crate) use batch::{execute_commands, execute_commands_at};
#[cfg(test)]
mod tests;
