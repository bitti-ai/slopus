use super::super::types::*;
use crate::project::*;
use serde_json::Value;
use std::{sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};
use super::options::*;
use super::super::prompt::*;
pub(in crate::agent) fn compatible_setting_is_configured(id: ProviderId, setting: &ProviderSetting) -> bool {
    setting.enabled
        && setting
            .model
            .as_deref()
            .is_some_and(|model| !model.trim().is_empty())
        && option_string(setting, "endpoint").is_some_and(|value| !value.trim().is_empty())
        && (id != ProviderId::Openrouter
            || option_string(setting, "apiKey").is_some_and(|value| !value.trim().is_empty()))
}

pub(in crate::agent) fn validate_compatible_setting(
    id: ProviderId,
    setting: Option<&ProviderSetting>,
) -> Result<(), String> {
    let setting =
        setting.ok_or_else(|| format!("{} is not configured in Settings.", id.label()))?;
    if !compatible_setting_is_configured(id, setting) {
        let needed = if id == ProviderId::Openrouter {
            "an endpoint, API key, and model"
        } else {
            "an endpoint and model"
        };
        return Err(format!("{} needs {needed} in Settings.", id.label()));
    }
    compatible_resource_url(setting, "chat/completions")?;
    Ok(())
}

pub(in crate::agent) fn compatible_resource_url(setting: &ProviderSetting, resource: &str) -> Result<String, String> {
    let endpoint = option_string(setting, "endpoint")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The OpenAI-compatible endpoint is empty.".to_string())?;
    let base = endpoint
        .trim_end_matches('/')
        .strip_suffix("/chat/completions")
        .unwrap_or(endpoint.trim_end_matches('/'));
    let url = format!("{base}/{resource}");
    let parsed = reqwest::Url::parse(&url)
        .map_err(|error| format!("The OpenAI-compatible endpoint is not a valid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The OpenAI-compatible endpoint must use http or https.".into());
    }
    Ok(url)
}

pub(in crate::agent) fn compatible_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .user_agent("Slopus/0.1")
        .build()
        .map_err(|error| format!("Could not prepare the OpenAI-compatible client: {error}"))
}

pub(in crate::agent) fn with_compatible_auth(
    request: reqwest::blocking::RequestBuilder,
    setting: &ProviderSetting,
) -> reqwest::blocking::RequestBuilder {
    match option_string(setting, "apiKey")
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

pub(in crate::agent) fn compatible_http_error(label: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().chars().take(800).collect());
    if detail.is_empty() {
        format!("{label} returned HTTP {status}.")
    } else {
        format!("{label} returned HTTP {status}: {detail}")
    }
}

pub(in crate::agent) fn compatible_message_content(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array().and_then(|items| {
        let text = items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("content").and_then(Value::as_str))
            })
            .collect::<Vec<_>>()
            .join("");
        (!text.is_empty()).then_some(text)
    })
}

pub(in crate::agent) fn compatible_chat_body(
    config: &ProjectConfig,
    prompt: &str,
    model: &str,
) -> Result<Value, String> {
    Ok(serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": project_system_prompt(config) },
            { "role": "user", "content": context_prompt(config, prompt)? }
        ],
        "temperature": 0
    }))
}

pub(in crate::agent) fn run_compatible_endpoint(
    provider: ProviderId,
    config: &ProjectConfig,
    prompt: &str,
    setting: &ProviderSetting,
    cancel: Arc<AtomicBool>,
    timeout: Duration,
    on_event: &dyn Fn(&AgentEvent),
) -> Result<(Vec<AgentEvent>, String), String> {
    if cancel.load(Ordering::Acquire) {
        return Err("Agent turn cancelled.".into());
    }
    let started = AgentEvent::Started { provider };
    on_event(&started);
    let mut events = vec![started];
    let url = compatible_resource_url(setting, "chat/completions")?;
    let model = setting
        .model
        .as_deref()
        .expect("compatible setting validated");
    let body = compatible_chat_body(config, prompt, model)?;
    let client = reqwest::Client::builder().timeout(timeout).user_agent("Slopus/0.1")
        .build().map_err(|error| error.to_string())?;
    let mut request = client.post(url).json(&body);
    if let Some(key) = option_string(setting, "apiKey").map(str::trim).filter(|key| !key.is_empty()) {
        request = request.bearer_auth(key);
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| error.to_string())?;
    let (status, response_body) = runtime.block_on(async {
        tokio::select! {
            response = async {
                let response = request.send().await.map_err(|error| format!("Could not reach {}: {error}", provider.label()))?;
                let status = response.status();
                let body = response.text().await.map_err(|error| format!("Could not read {}'s response: {error}", provider.label()))?;
                Ok::<_, String>((status, body))
            } => response,
            _ = async {
                while !cancel.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(25)).await; }
            } => Err("Agent turn cancelled.".into()),
        }
    })?;
    if !status.is_success() {
        return Err(compatible_http_error(
            provider.label(),
            status,
            &response_body,
        ));
    }
    if cancel.load(Ordering::Acquire) {
        return Err("Agent turn cancelled.".into());
    }
    let value: Value = serde_json::from_str(&response_body)
        .map_err(|error| format!("{} returned invalid JSON: {error}", provider.label()))?;
    let output = compatible_message_content(&value).ok_or_else(|| {
        format!(
            "{} returned no assistant message content.",
            provider.label()
        )
    })?;
    let message = AgentEvent::Message {
        text: output.clone(),
    };
    on_event(&message);
    events.push(message);
    let completed = AgentEvent::Completed;
    on_event(&completed);
    events.push(completed);
    Ok((events, output))
}

pub fn compatible_models(
    provider: ProviderId,
    setting: &ProviderSetting,
) -> Result<Vec<String>, String> {
    if !provider.is_compatible_endpoint() {
        return Err("Model discovery is only available for endpoint providers.".into());
    }
    let url = compatible_resource_url(setting, "models")?;
    let request = compatible_client(Duration::from_secs(20))?.get(url);
    let response = with_compatible_auth(request, setting)
        .send()
        .map_err(|error| format!("Could not reach {}: {error}", provider.label()))?;
    let status = response.status();
    let response_body = response
        .text()
        .map_err(|error| format!("Could not read {}'s model list: {error}", provider.label()))?;
    if !status.is_success() {
        return Err(compatible_http_error(
            provider.label(),
            status,
            &response_body,
        ));
    }
    let value: Value = serde_json::from_str(&response_body).map_err(|error| {
        format!(
            "{} returned an invalid model list: {error}",
            provider.label()
        )
    })?;
    let mut models = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Ok(models)
}
