use crate::project::ProjectConfig;
pub(super) const AGENT_SYSTEM_PROMPT: &str = include_str!("../../assets/agent-system.md");
pub(super) fn full_agent_system_prompt() -> String {
    system_prompt_for(crate::generation::models::default_model())
}
pub(super) fn system_prompt_for(model: &crate::generation::models::ModelDefinition) -> String {
    let catalog = (model.shot_catalog)();
    format!("{AGENT_SYSTEM_PROMPT}\n\n{}\n\nSupported shot.settings catalog:\n{catalog}", model.agent_instructions)
}
pub(super) fn context_prompt(config: &ProjectConfig, prompt: &str) -> Result<String, String> {
    let conversation = serde_json::to_string(&config.agent_conversation.messages)
        .map_err(|error| format!("Could not prepare conversation context: {error}"))?;
    let mut project_context = config.clone();
    project_context.provider_settings.clear();
    project_context.agent_conversation.messages.clear();
    let project = serde_json::to_string(&project_context)
        .map_err(|error| format!("Could not prepare project context: {error}"))?;
    Ok(format!(
        "Prior conversation JSON:\n<conversation-json>\n{conversation}\n</conversation-json>\n\nComplete current slopus.json data:\n<project-json>\n{project}\n</project-json>\n\nCurrent user reply or request:\n{prompt}"
    ))
}

/// Include only registered model policies used by this project. A new empty
/// project gets the default policy; unknown persisted models remain inert data.
pub(super) fn project_system_prompt(config: &ProjectConfig) -> String {
    let mut ids = std::collections::BTreeSet::new();
    let models: Vec<_> = config.generation_jobs.iter()
        .filter_map(|job| crate::generation::models::for_scene(job.provider_id.as_deref()))
        .filter(|model| ids.insert(model.defaults.provider_id))
        .collect();
    if models.is_empty() && config.generation_jobs.is_empty() { return full_agent_system_prompt(); }
    let policies = models.into_iter().map(|model| format!("Model {}:\n{}\nSupported shot.settings catalog:\n{}",
        model.defaults.provider_id, model.agent_instructions, (model.shot_catalog)())).collect::<Vec<_>>().join("\n\n");
    format!("{AGENT_SYSTEM_PROMPT}\n\n{policies}")
}
