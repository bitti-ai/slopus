use super::types::*;
use crate::project::commands::{parse_jsonl_commands, CommandBatch};
use serde_json::Value;
pub(super) fn parse_turn_result(raw: &str) -> Result<AgentTurnResult, String> {
    let trimmed = raw
        .trim()
        .strip_prefix("```json")
        .or_else(|| raw.trim().strip_prefix("```"))
        .unwrap_or(raw.trim());
    let trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed).trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(kind) = value.get("kind").and_then(Value::as_str) {
            if kind == "inspect" {
                let requests: Vec<super::generators::GeneratorRead> =
                    serde_json::from_value(value["requests"].clone()).map_err(|e| e.to_string())?;
                if requests.is_empty() || requests.len() > 8 {
                    return Err("Use 1 to 8 inspection requests per turn.".into());
                }
                return Ok(AgentTurnResult::Inspect { requests });
            }
            if kind == "generatorCommands" {
                let summary = value["summary"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("Generator commands need a nonempty summary.")?
                    .to_string();
                let commands: Vec<super::generators::GeneratorCommand> =
                    serde_json::from_value(value["commands"].clone()).map_err(|e| e.to_string())?;
                if commands.is_empty() || commands.len() > 100 {
                    return Err("Use 1 to 100 generator commands.".into());
                }
                return Ok(AgentTurnResult::GeneratorCommands { summary, commands });
            }
            let content = value
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Agent {kind} response needs string content."))?
                .to_string();
            if content.trim().is_empty() {
                return Err("Agent response content cannot be empty.".into());
            }
            return match kind {
                "answer" => Ok(AgentTurnResult::Answer { content }),
                "question" => Ok(AgentTurnResult::Question { content }),
                _ => Err(format!(
                    "Unknown agent response kind '{kind}'. Use answer, question, inspect, generatorCommands, or a project JSONL command stream."
                )),
            };
        }
    }
    let CommandBatch { summary, commands } = parse_jsonl_commands(raw)
        .map_err(|error| format!("Agent response did not match the turn contract: {error}"))?;
    Ok(AgentTurnResult::Commands { summary, commands })
}
