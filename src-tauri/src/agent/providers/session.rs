use super::{CliProvider, cli_provider_for, compatible::{run_compatible_endpoint, validate_compatible_setting}};
use crate::project::{ProjectConfig, ProviderSetting};
use crate::agent::{types::{AgentEvent, ProviderId}, discovery::discover_executable, process::run_subprocess};
use std::{path::{Path, PathBuf}, sync::{Arc, atomic::AtomicBool}, time::Duration};

pub(in crate::agent) struct TurnInput<'a> {
    pub root: &'a Path,
    pub config: &'a ProjectConfig,
    pub prompt: &'a str,
    pub cancellation: Arc<AtomicBool>,
    pub timeout: Duration,
    pub on_event: &'a dyn Fn(&AgentEvent),
}

/// One turn contract for CLI and HTTP transports. The runtime owns correction
/// policy and project validation; providers own execution and response envelopes.
pub(in crate::agent) trait AgentProvider {
    fn run_turn(&self, input: TurnInput<'_>) -> Result<(Vec<AgentEvent>, String), String>;
}

struct CliSession {
    id: ProviderId,
    provider: &'static dyn CliProvider,
    executable: PathBuf,
    setting: Option<ProviderSetting>,
}
impl AgentProvider for CliSession {
    fn run_turn(&self, input: TurnInput<'_>) -> Result<(Vec<AgentEvent>, String), String> {
        let spec = self.provider.command_spec(input.root, &self.executable, input.config, input.prompt, self.setting.as_ref())?;
        run_subprocess(spec, self.id, input.cancellation, input.timeout, input.on_event)
    }
}

struct EndpointSession { id: ProviderId, setting: ProviderSetting }
impl AgentProvider for EndpointSession {
    fn run_turn(&self, input: TurnInput<'_>) -> Result<(Vec<AgentEvent>, String), String> {
        run_compatible_endpoint(self.id, input.config, input.prompt, &self.setting, input.cancellation, input.timeout, input.on_event)
    }
}

pub(in crate::agent) fn prepare(id: ProviderId, setting: Option<ProviderSetting>) -> Result<Box<dyn AgentProvider>, String> {
    if let Some(provider) = cli_provider_for(id) {
        let executable = discover_executable(provider.executable_name(), setting.as_ref())
            .ok_or_else(|| format!("{} is not installed or is not on PATH.", provider.label()))?;
        Ok(Box::new(CliSession { id, provider, executable, setting }))
    } else {
        validate_compatible_setting(id, setting.as_ref())?;
        Ok(Box::new(EndpointSession { id, setting: setting.expect("validated endpoint settings") }))
    }
}
