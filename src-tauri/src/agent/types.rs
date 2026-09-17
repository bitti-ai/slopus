use crate::project::*;
use crate::project::commands::ProjectCommand;
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderId {
    Claude,
    Codex,
    Openrouter,
    Local,
}

impl ProviderId {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Openrouter => "openrouter",
            Self::Local => "local",
        }
    }

    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Openrouter => "OpenRouter",
            Self::Local => "Local OpenAI-compatible",
        }
    }

    pub(super) fn is_compatible_endpoint(self) -> bool {
        matches!(self, Self::Openrouter | Self::Local)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: ProviderId,
    pub label: &'static str,
    pub state: &'static str,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AgentEvent {
    Started {
        provider: ProviderId,
    },
    Message {
        text: String,
    },
    Diagnostic {
        text: String,
    },
    Validation {
        round: usize,
        #[serde(rename = "maxRounds")]
        max_rounds: usize,
        text: String,
    },
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentTurnResult {
    Answer {
        content: String,
    },
    Question {
        content: String,
    },
    Commands {
        summary: String,
        commands: Vec<ProjectCommand>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnRequest {
    pub request_id: String,
    pub folder_path: String,
    pub provider: ProviderId,
    pub prompt: String,
    pub config: ProjectConfig,
    #[serde(default)]
    pub conversation: Vec<AgentMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnResponse {
    pub result: AgentTurnResult,
    pub events: Vec<AgentEvent>,
}
