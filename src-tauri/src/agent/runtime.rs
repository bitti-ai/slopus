use super::cancellation::CancellationRegistry;
use super::providers::options::*;
use super::providers::session::{self, TurnInput};
use super::types::*;
use super::{discovery::*, policy::*, protocol::*, retry::*};
use crate::project::commands::execute_checked;
use crate::project::validation::issue::ValidationIssue;
use crate::project::{validation::validate_and_normalize_config, *};
use std::{path::Path, time::Duration};
pub(super) const DEFAULT_TIMEOUT_SECONDS: u64 = 300;
#[derive(Clone, Default)]
pub struct AgentRuntime {
    cancellations: CancellationRegistry,
}

impl AgentRuntime {
    pub fn cancel(&self, request_id: &str) -> bool {
        self.cancellations.cancel(request_id)
    }

    pub fn run(
        &self,
        request: AgentTurnRequest,
        on_event: impl Fn(&AgentEvent),
    ) -> Result<AgentTurnResponse, String> {
        if request.request_id.trim().is_empty() || request.prompt.trim().is_empty() {
            return Err("Agent request id and prompt cannot be empty.".into());
        }
        let folder = confined_project_root(Path::new(&request.folder_path))?;
        let setting = request
            .config
            .provider_settings
            .get(request.provider.key())
            .cloned();
        // Endpoint credentials are machine settings merged into this one IPC
        // request. They are transport configuration, not project content: do
        // not show them to the model or let a command persist them.
        let mut project_config = without_endpoint_provider_settings(request.config.clone());
        project_config.agent_conversation.messages = request.conversation.clone();
        let config = validate_and_normalize_config(project_config)?;
        if setting.as_ref().is_some_and(|value| !value.enabled) {
            return Err(format!("{} is disabled.", request.provider.label()));
        }
        let provider = session::prepare(request.provider, setting.clone())?;
        let timeout = setting
            .as_ref()
            .and_then(|value| option_number(value, "timeoutSeconds"))
            .map(|value| value.clamp(5.0, 600.0) as u64)
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);
        let running = self.cancellations.register(&request.request_id)?;
        let cancel = running.flag.clone();
        let run_result = (|| {
            let original_prompt = request.prompt.trim();
            let mut attempt_prompt = original_prompt.to_string();
            let mut all_events = Vec::new();
            let mut retries = RetryBudget::default();
            let result = loop {
                let (events, output) = provider.run_turn(TurnInput {
                    root: &folder,
                    config: &config,
                    prompt: &attempt_prompt,
                    cancellation: cancel.clone(),
                    timeout: Duration::from_secs(timeout),
                    on_event: &on_event,
                })?;
                all_events.extend(events);

                let checked = parse_turn_result(&output)
                    .map_err(|message| {
                        ValidationIssue::new("turn.contract", None, "response", message)
                    })
                    .and_then(|result| {
                        if let AgentTurnResult::Commands { commands, .. } = &result {
                            let next = execute_checked(
                                &config,
                                commands,
                                &config.updated_at,
                                crate::generation::models::default_model().defaults,
                            )?;
                            validate_scene_policy(&config, &next)?;
                        }
                        Ok(result)
                    });
                match checked {
                    Ok(valid) => break valid,
                    Err(failure) => {
                        let issue_retry_round = retries.correction(&failure)?;
                        let event = AgentEvent::Validation {
                            round: issue_retry_round,
                            max_rounds: MAX_RETRIES_PER_VALIDATION_ISSUE,
                            text: failure.message.clone(),
                        };
                        on_event(&event);
                        all_events.push(event);
                        attempt_prompt = validation_retry_prompt(
                            original_prompt,
                            &output,
                            &failure.message,
                            issue_retry_round,
                        );
                    }
                }
            };
            Ok(AgentTurnResponse {
                result,
                events: all_events,
            })
        })();
        run_result
    }
}

pub(super) fn without_endpoint_provider_settings(mut config: ProjectConfig) -> ProjectConfig {
    config.provider_settings.clear();
    config
}
