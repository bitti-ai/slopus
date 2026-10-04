//! Agent turn orchestration; provider transports never mutate the project.
mod cancellation;
pub(crate) mod capture;
mod discovery;
pub(crate) mod generators;
mod generation;
mod policy;
mod process;
mod prompt;
mod protocol;
mod providers;
mod retry;
mod runtime;
mod types;
mod weights;
pub(crate) use discovery::{provider_statuses, ProviderDiscovery};
pub(crate) use policy::validate_agent_scene_conventions;
pub(crate) use providers::compatible::compatible_models;
pub(crate) use runtime::AgentRuntime;
pub(crate) use types::*;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_generators;
#[cfg(test)]
mod tests_transport;
#[cfg(test)]
mod tests_capture;
