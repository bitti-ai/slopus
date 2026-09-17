use crate::project::*;
use std::path::Path;
use super::{CliProvider, ClaudeProvider};
use super::super::{prompt::*, process::CommandSpec};
impl CliProvider for ClaudeProvider {
    fn label(&self) -> &'static str {
        "Claude Code"
    }
    fn executable_name(&self) -> &'static str {
        "claude"
    }
    fn auth_args(&self) -> &'static [&'static str] {
        &["auth", "status"]
    }
    fn command_spec(
        &self,
        root: &Path,
        executable: &Path,
        config: &ProjectConfig,
        prompt: &str,
        setting: Option<&ProviderSetting>,
    ) -> Result<CommandSpec, String> {
        let mut args = vec![
            "--print".into(),
            // Not optional decoration: `claude --print --output-format
            // stream-json` refuses to start without it —
            // "When using --print, --output-format=stream-json requires
            // --verbose" — and exits 1 before contacting the model. Everything
            // it adds is more NDJSON records on the same stream (system/init,
            // rate_limit_event, thinking-only assistant turns), which
            // `extract_provider_output` walks past on its way to the final
            // `result` record.
            "--verbose".into(),
            "--output-format".into(),
            "stream-json".into(),
            // `--tools` is variadic, so another flag must terminate its values
            // before Claude reads the actual request from stdin.
            "--tools".into(),
            "".into(),
            "--system-prompt".into(),
            project_system_prompt(config).into(),
        ];
        if let Some(model) = setting.and_then(|value| value.model.as_deref()) {
            args.extend(["--model".into(), model.into()]);
        }
        Ok(CommandSpec {
            executable: executable.into(),
            args,
            current_dir: root.into(),
            stdin_payload: Some(context_prompt(config, prompt)?),
        })
    }
}
