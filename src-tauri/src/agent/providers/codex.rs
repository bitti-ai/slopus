use crate::project::*;
use std::{ffi::OsString, path::Path};
use super::{CliProvider, CodexProvider};
use super::super::{prompt::*, process::CommandSpec};
impl CliProvider for CodexProvider {
    fn label(&self) -> &'static str {
        "Codex"
    }
    fn executable_name(&self) -> &'static str {
        "codex"
    }
    fn auth_args(&self) -> &'static [&'static str] {
        &["login", "status"]
    }
    fn command_spec(
        &self,
        root: &Path,
        executable: &Path,
        config: &ProjectConfig,
        prompt: &str,
        setting: Option<&ProviderSetting>,
    ) -> Result<CommandSpec, String> {
        // Every flag here is scoped to the `exec` subcommand, so `exec` stays
        // first and the stdin marker stays last. `--skip-git-repo-check`
        // and `--json` do not exist on the top-level `codex` command at all;
        // put them before `exec` and clap fails the invocation.
        let mut args: Vec<OsString> = vec![
            "exec".into(),
            "--ephemeral".into(),
            "--ignore-user-config".into(),
            "--json".into(),
            // A Slopus project folder is a plain directory of media and
            // JSON; it is usually not a git repository, and Codex refuses to
            // run outside one without this.
            "--skip-git-repo-check".into(),
            "--sandbox".into(),
            "read-only".into(),
            "-C".into(),
            root.as_os_str().into(),
        ];
        if let Some(model) = setting.and_then(|value| value.model.as_deref()) {
            args.extend(["--model".into(), model.into()]);
        }
        // An explicit `-` tells `codex exec` to read the initial instructions
        // from stdin instead of the Windows command line. Project JSON and
        // validation retries can easily exceed CreateProcessW's 32K limit.
        args.push("-".into());
        Ok(CommandSpec {
            executable: executable.into(),
            args,
            current_dir: root.into(),
            stdin_payload: Some(format!(
                "{}\n\n{}",
                project_system_prompt(config),
                context_prompt(config, prompt)?
            )),
        })
    }
}

// `codex exec --output-schema` is deliberately not used. Command turns are
// JSONL—a sequence of values rather than one JSON value—so Codex's strict
// structured-output validator cannot describe their transport. The turn
// contract is stated in AGENT_SYSTEM_PROMPT and enforced by
// `parse_turn_result` for every provider.
