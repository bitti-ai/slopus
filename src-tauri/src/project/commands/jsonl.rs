use super::types::*;
/** Parse the line protocol without weakening it into a general JSON patch. */
pub fn parse_jsonl_commands(raw: &str) -> Result<CommandBatch, String> {
    let clean = strip_code_fence(raw);
    let lines = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("Agent command stream is empty.".into());
    }

    let mut commands = Vec::new();
    let mut summary = None;
    for (index, line) in lines.iter().enumerate() {
        let line_number = index + 1;
        let operation: Operation = serde_json::from_str(line).map_err(|error| {
            format!("Agent command line {line_number} is not one JSON object: {error}")
        })?;
        if operation.op == "commit" {
            if line_number != lines.len() {
                return Err("The commit line must be the final line of the command stream.".into());
            }
            let commit: CommitLine = serde_json::from_str(line).map_err(|error| {
                format!("Agent commit line does not match the command contract: {error}")
            })?;
            if commit.op != "commit" || commit.summary.trim().is_empty() {
                return Err("Agent commit summary cannot be empty.".into());
            }
            summary = Some(commit.summary);
            continue;
        }
        if summary.is_some() {
            return Err("No command may appear after commit.".into());
        }
        let command: ProjectCommand = serde_json::from_str(line).map_err(|error| {
            format!(
                "Agent command line {line_number} does not match '{}': {error}",
                operation.op
            )
        })?;
        commands.push(command);
        if commands.len() > MAX_COMMANDS_PER_TURN {
            return Err(format!(
                "Agent command stream exceeds the limit of {MAX_COMMANDS_PER_TURN} commands."
            ));
        }
    }
    let summary = summary.ok_or_else(|| {
        "Agent command stream must end with {\"op\":\"commit\",\"summary\":\"...\"}.".to_string()
    })?;
    if commands.is_empty() {
        return Err("Agent command stream must contain at least one command before commit.".into());
    }
    Ok(CommandBatch { summary, commands })
}

fn strip_code_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let without_open = ["```jsonl", "```json", "```"]
        .iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix))
        .unwrap_or(trimmed);
    without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
}
