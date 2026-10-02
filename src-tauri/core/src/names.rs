//! Caller-named things that become file names.

/// A scene id, as a file name.
///
/// The webview names the job, so this is caller-controlled text about to become
/// a path — the exact shape of a traversal. Rather than sanitising it, the id
/// is REFUSED unless it is already only letters, digits, dash and underscore,
/// which is what every id Slopus generates looks like. There is nothing to
/// strip and nothing to get wrong: no dots (so no `..` and no second
/// extension), no separators, no length worth arguing about.
pub fn generated_file_stem(job_id: &str) -> Result<String, String> {
    let trimmed = job_id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return Err("A scene id must be between 1 and 64 characters.".into());
    }
    if !trimmed
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!(
            "'{job_id}' is not a scene id: only letters, digits, dashes and underscores name a rendered file."
        ));
    }
    Ok(trimmed.to_string())
}
