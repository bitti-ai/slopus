use super::types::*;
use crate::project::*;
use std::path::Path;
pub(super) trait CliProvider {
    fn label(&self) -> &'static str;
    fn executable_name(&self) -> &'static str;
    fn version_args(&self) -> &'static [&'static str] {
        &["--version"]
    }
    fn auth_args(&self) -> &'static [&'static str];
    fn command_spec(
        &self,
        root: &Path,
        executable: &Path,
        config: &ProjectConfig,
        prompt: &str,
        setting: Option<&ProviderSetting>,
    ) -> Result<CommandSpec, String>;
}

pub(super) struct ClaudeProvider;
pub(super) struct CodexProvider;

pub(super) fn cli_provider_for(id: ProviderId) -> Option<&'static dyn CliProvider> {
    static CLAUDE: ClaudeProvider = ClaudeProvider;
    static CODEX: CodexProvider = CodexProvider;
    match id {
        ProviderId::Claude => Some(&CLAUDE),
        ProviderId::Codex => Some(&CODEX),
        ProviderId::Openrouter | ProviderId::Local => None,
    }
}

mod claude;
mod codex;
pub(super) mod compatible;
pub(super) mod options;
use super::process::CommandSpec;
pub(super) mod output;
pub(super) mod session;
