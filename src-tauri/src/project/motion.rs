//! Portable Motion documents. Scripts are evaluated only in the UI worker;
//! saving or agent preparation never executes project JavaScript.
use serde_json::Value;

fn number(v: &Value, low: f64, high: f64) -> bool {
    v.as_f64().is_some_and(|n| n.is_finite() && n >= low && n <= high)
}
fn text(v: &Value, max: usize) -> bool { v.as_str().is_some_and(|s| s.chars().count() <= max) }
fn identifier(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 80 && s.as_bytes()[0].is_ascii_alphabetic()
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
}
fn vector(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.len() == 3 && a.iter().all(|n| number(n, -1e6, 1e6)))
}
pub(crate) fn validate(m: &Value) -> Result<(), String> {
    let invalid = || "Invalid Motion document. Use version 1, space 2d, valid nodes, parameters and source.".to_string();
    if m["version"] != 1 || m["space"] != "2d" || !text(&m["source"], 200000)
        || !number(&m["duration"], 0.1, 600.0)
        || ["width", "height"].iter().any(|k| !m[k].as_u64().is_some_and(|n| (32..=4096).contains(&n)))
        || m.get("seed").is_some_and(|v| !v.as_u64().is_some_and(|n| n <= u32::MAX as u64)) { return Err(invalid()); }
    let nodes = m["nodes"].as_array().ok_or_else(invalid)?;
    let params = m["parameters"].as_array().ok_or_else(invalid)?;
    if nodes.len() > 512 || params.len() > 100 { return Err(invalid()); }
    for entries in [nodes, params] {
        let mut ids = std::collections::BTreeSet::new();
        for entry in entries { if !identifier(&entry["id"]) || !ids.insert(entry["id"].as_str()) { return Err(invalid()); } }
    }
    for node in nodes {
        if !text(&node["name"], 200) || node["name"] == ""
            || !matches!(node["kind"].as_str(), Some("rect" | "ellipse" | "text" | "path")) { return Err(invalid()); }
        for key in ["position", "rotation", "scale"] { if node.get(key).is_some_and(|v| !vector(v)) { return Err(invalid()); } }
        for key in ["width", "height"] { if node.get(key).is_some_and(|v| !number(v, -1e6, 1e6)) { return Err(invalid()); } }
        for (key, low, high) in [("opacity", 0.0, 1.0), ("strokeWidth", 0.0, 1000.0), ("fontSize", 1.0, 1000.0)] {
            if node.get(key).is_some_and(|v| !number(v, low, high)) { return Err(invalid()); }
        }
        for (key, max) in [("fill", 100), ("stroke", 100), ("text", 10000), ("path", 50000)] {
            if node.get(key).is_some_and(|v| !text(v, max)) { return Err(invalid()); }
        }
        if node.get("visible").is_some_and(|v| !v.is_boolean()) || node.get("fontFamily").is_some_and(|v| !matches!(v.as_str(), Some("sans-serif" | "serif" | "monospace"))) { return Err(invalid()); }
    }
    for p in params {
        if !text(&p["label"], 200) || p["label"] == "" { return Err(invalid()); }
        let valid = match p["type"].as_str() {
            Some("number") => number(&p["value"], -1e6, 1e6),
            Some("boolean") => p["value"].is_boolean(),
            Some("string" | "color") => text(&p["value"], 10000), _ => false,
        };
        if !valid || ["min", "max"].iter().any(|k| p.get(k).is_some_and(|v| !number(v, -1e6, 1e6)))
            || p.get("step").is_some_and(|v| !number(v, f64::MIN_POSITIVE, 1e6)) { return Err(invalid()); }
        if let Some(min) = p["min"].as_f64() {
            if p["max"].as_f64().is_some_and(|max| max < min) || p["value"].as_f64().is_some_and(|v| v < min) { return Err(invalid()); }
        }
        if let Some(max) = p["max"].as_f64() { if p["value"].as_f64().is_some_and(|v| v > max) { return Err(invalid()); } }
    }
    if let Some(overrides) = m.get("overrides") {
        for (id, edit) in overrides.as_object().ok_or_else(invalid)? {
            if !nodes.iter().any(|n| n["id"] == id.as_str()) || !edit.is_object() { return Err(invalid()); }
            for key in ["offset", "scale", "rotation"] { if edit.get(key).is_some_and(|v| !vector(v)) { return Err(invalid()); } }
            for (key, max) in [("fill", 100), ("text", 10000)] { if edit.get(key).is_some_and(|v| !text(v, max)) { return Err(invalid()); } }
        }
    }
    Ok(())
}
