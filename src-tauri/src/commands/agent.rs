use crate::agent;
use crate::project::commands as agent_commands;
use crate::project::{validation::validate_and_normalize_config, *};
use serde::Serialize;
use tauri::{AppHandle, Emitter as _};
#[tauri::command]
pub(crate) async fn list_agent_models(
    provider: agent::ProviderId,
    setting: ProviderSetting,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || agent::compatible_models(provider, &setting))
        .await
        .map_err(|error| format!("Could not load agent models: {error}"))?
}

#[tauri::command]
pub(crate) async fn run_agent_turn(
    app: AppHandle,
    state: tauri::State<'_, agent::AgentRuntime>,
    request: agent::AgentTurnRequest,
) -> Result<agent::AgentTurnResponse, String> {
    let runtime = state.inner().clone();
    let request_id = request.request_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        runtime.run(request, |event| {
            let _ = app.emit(
                "agent-turn-event",
                AgentTurnEventPayload {
                    request_id: request_id.clone(),
                    event: event.clone(),
                },
            );
        })
    })
    .await
    .map_err(|error| format!("Agent task failed: {error}"))?
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTurnEventPayload {
    pub(crate) request_id: String,
    pub(crate) event: agent::AgentEvent,
}

#[tauri::command]
pub(crate) fn cancel_agent_turn(
    state: tauri::State<'_, agent::AgentRuntime>,
    request_id: String,
) -> bool {
    state.cancel(&request_id)
}

/** Execute an already provider-validated command batch against the latest
 * config held by the editor. The provider can take minutes to answer; applying
 * here, after it returns, keeps edits made while it was thinking instead of
 * replacing them with the older prompt snapshot. Persistence remains in the
 * workspace's ordered save queue. */
#[tauri::command]
pub(crate) fn execute_agent_commands(
    config: ProjectConfig,
    commands: Vec<agent_commands::ProjectCommand>,
    executed_at: String,
) -> Result<ProjectConfig, String> {
    let current = validate_and_normalize_config(config)?;
    let mut next = agent_commands::execute_commands_at(&current, &commands, &executed_at)?;
    agent::validate_agent_scene_conventions(&current, &next)?;
    next.agent_conversation = AgentConversation::default();
    validate_and_normalize_config(next)
}
