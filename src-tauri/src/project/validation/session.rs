use super::values::*;
use crate::project::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    for message in &config.agent_conversation.messages {
        if message.id.trim().is_empty() || message.content.trim().is_empty() {
            return Err("Agent message id and content cannot be empty.".into());
        }
        if !matches!(message.role.as_str(), "user" | "assistant" | "system") {
            return Err(format!(
                "Unsupported agent message role '{}'.",
                message.role
            ));
        }
        check_iso_datetime(
            &format!("Agent message '{}' createdAt", message.id),
            &message.created_at,
        )?;
    }
    for (provider_id, setting) in &config.provider_settings {
        if provider_id.trim().is_empty() {
            return Err("Provider setting ids cannot be empty.".into());
        }
        if setting
            .model
            .as_deref()
            .is_some_and(|model| model.trim().is_empty())
        {
            return Err("Provider setting models cannot be empty.".into());
        }
    }
    Ok(())
}
