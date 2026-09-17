use crate::project::commands::parse_jsonl_commands;
use serde_json::Value;
/// The reason a provider gave for failing, as it reported it on stdout.
///
/// Codex emits `{"type":"error","message":…}` and `{"type":"turn.failed",
/// "error":{"message":…}}`; that is where the useful text lives, not on stderr.
pub(in crate::agent) fn structured_failure(lines: &[String]) -> Option<String> {
    lines.iter().rev().find_map(|line| {
        let value = serde_json::from_str::<Value>(line).ok()?;
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| {
                (value.get("type").and_then(Value::as_str) == Some("error"))
                    .then(|| value.get("message").and_then(Value::as_str))
                    .flatten()
            })?;
        Some(message.to_string())
    })
}

/// Reduce a provider's NDJSON transcript to the one payload the turn contract
/// is parsed from.
///
/// `--verbose` is mandatory for Claude's stream-json output, so the transcript
/// always carries records this has to walk past: `system/init`,
/// `rate_limit_event`, `system/thinking_tokens`, and assistant turns whose
/// only content block is `thinking` (no `text` at all). Scanning from the end
/// reaches the terminal `result` record first, which is the whole answer.
pub(in crate::agent) fn extract_provider_output(lines: &[String]) -> Result<String, String> {
    for line in lines.iter().rev() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        // Claude reports a failed turn in band and still exits 0; `result`
        // then holds an error message rather than a turn payload. Saying that
        // beats letting it fall through and blaming the turn contract.
        if value.get("type").and_then(Value::as_str) == Some("result")
            && value.get("is_error").and_then(Value::as_bool) == Some(true)
        {
            let detail = value
                .get("result")
                .and_then(Value::as_str)
                .or_else(|| value.get("subtype").and_then(Value::as_str))
                .unwrap_or("the provider gave no detail");
            return Err(format!(
                "The agent provider reported a failed turn: {detail}"
            ));
        }
        if value.get("kind").is_some() {
            return Ok(line.clone());
        }
        if let Some(text) = value.get("result").and_then(Value::as_str) {
            return Ok(text.into());
        }
        if let Some(text) = value.pointer("/item/text").and_then(Value::as_str) {
            return Ok(text.into());
        }
        if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
            if let Some(text) = content
                .iter()
                .rev()
                .find_map(|item| item.get("text").and_then(Value::as_str))
            {
                return Ok(text.into());
            }
        }
    }
    // A small test provider, or a future adapter with no transport envelope,
    // may print the model's JSONL stream directly. Keep only a stream where
    // every stdout line is a command object; normal provider diagnostics must
    // never be mistaken for a result.
    let joined = lines.join("\n");
    if parse_jsonl_commands(&joined).is_ok() {
        return Ok(joined);
    }
    Err("Agent provider returned no structured result.".into())
}
