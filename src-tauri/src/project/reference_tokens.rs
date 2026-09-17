pub(crate) fn action_reference_ids(action: &str) -> Result<Vec<&str>, String> {
    let mut ids = Vec::new();
    let mut rest = action;
    while let Some(start) = rest.find("@[ref:") {
        let after_prefix = &rest[start + "@[ref:".len()..];
        let end = after_prefix.find(']').ok_or_else(|| {
            "A shot contains an unfinished @[ref:<reference-id>] token.".to_string()
        })?;
        let id = &after_prefix[..end];
        if id.trim().is_empty() {
            return Err("A shot contains an empty @[ref:<reference-id>] token.".into());
        }
        ids.push(id);
        rest = &after_prefix[end + 1..];
    }
    Ok(ids)
}
