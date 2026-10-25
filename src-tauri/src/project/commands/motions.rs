use super::types::ProjectCommand;
use crate::project::{ProjectAsset, ProjectConfig};

pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str) -> Result<(), String> {
    match command {
        ProjectCommand::MotionAdd { id, name, motion } => {
            if id.trim().is_empty() || name.trim().is_empty() || project.assets.iter().any(|a| a.id == *id) { return Err("A Motion needs a unique asset id and name.".into()); }
            crate::project::motion::validate(motion)?;
            let asset: ProjectAsset = serde_json::from_value(serde_json::json!({
                "id": id, "name": name, "kind":"motion", "mimeType":"application/x-slopus-motion", "motion":motion, "createdAt":timestamp,
                "width":motion["width"], "height":motion["height"], "durationMs":(motion["duration"].as_f64().unwrap() * 1000.0).round() as u64, "hasAudio":false
            })).map_err(|e| e.to_string())?;
            project.assets.push(asset);
        }
        ProjectCommand::MotionSet { id, name, motion } => {
            let asset = project.assets.iter_mut().find(|a| a.id == *id && a.kind == "motion").ok_or("Motion asset not found.")?;
            if let Some(name) = name { if name.trim().is_empty() { return Err("Motion name cannot be empty.".into()); } asset.name = name.clone(); }
            if let Some(motion) = motion { crate::project::motion::validate(motion)?;
                asset.width = motion["width"].as_u64().map(|v| v as u32);
                asset.height = motion["height"].as_u64().map(|v| v as u32);
                asset.duration_ms = motion["duration"].as_f64().map(|v| (v * 1000.0).round() as u64);
                asset.motion = Some(motion.clone()); }
        }
        _ => return Err("Unsupported Motion command.".into()),
    }
    Ok(())
}
