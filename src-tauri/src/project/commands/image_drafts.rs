use super::{images::new_scene, types::ProjectCommand};
use crate::project::{image::ImageGenerationSnapshot, ImageSettings, ProjectConfig};

fn settings(project: &ProjectConfig) -> ImageSettings {
    project.image_settings.clone().unwrap_or_else(|| ImageSettings {
        resolution: project.settings.resolution.clone(),
        aspect_ratio: project.settings.aspect_ratio.clone(),
        default_look: project.settings.default_look.clone(),
    })
}

fn snapshot(project: &ProjectConfig, template: String) -> Result<ImageGenerationSnapshot, String> {
    let mut scene = project.image_scene.clone().ok_or("No image composition selected.")?;
    scene.output_asset_id = None;
    let cited = scene.cited_reference_ids()?;
    for id in &cited {
        if !project.references.iter().any(|reference| reference.id == *id && matches!(reference.kind.as_str(), "image" | "text")) {
            return Err(format!("Image reference '{id}' must name an existing image or text reference."));
        }
    }
    let references = project.references.iter().filter(|reference| cited.contains(&reference.id.as_str())
        || scene.reference_ids.contains(&reference.id)
        || scene.nodes.iter().any(|node| node.reference_ids.as_ref().is_some_and(|ids| ids.contains(&reference.id))))
        .cloned().collect();
    let settings = settings(project);
    Ok(ImageGenerationSnapshot { scene, resolution: settings.resolution, aspect_ratio: settings.aspect_ratio,
        default_look: settings.default_look, brief_prompt: project.brief.prompt.clone(), prompt: String::new(),
        generator_template_id: template, used_seed: None, template: None, references })
}

pub(super) fn save(project: &mut ProjectConfig) -> Result<(), String> {
    let selected = project.image_scene.as_ref().and_then(|scene| scene.output_asset_id.as_ref());
    let Some(index) = project.assets.iter().position(|asset| Some(&asset.id) == selected && asset.image_draft == Some(true)
        && asset.image_generation.as_ref().is_some_and(|snapshot| snapshot.template.is_none())) else { return Ok(()) };
    let template = project.assets[index].image_generation.as_ref().unwrap().generator_template_id.clone();
    project.assets[index].image_generation = Some(snapshot(project, template)?);
    Ok(())
}

pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str) -> Result<(), String> {
    save(project)?;
    match command {
        ProjectCommand::ImageDraftAdd { id, name, prompt, resolution, aspect_ratio } => {
            if id.trim().is_empty() || name.trim().is_empty() { return Err("Image draft id and name cannot be empty.".into()); }
            if project.assets.iter().any(|asset| &asset.id == id) { return Err(format!("Asset '{id}' already exists.")); }
            let mut options = settings(project);
            if let Some(value) = resolution { options.resolution = value.clone(); }
            if let Some(value) = aspect_ratio { options.aspect_ratio = value.clone(); }
            project.image_settings = Some(options);
            let mut scene = new_scene(prompt);
            scene.output_asset_id = Some(id.clone());
            project.image_scene = Some(scene);
            let generation = snapshot(project, "image-draft".into())?;
            // App-owned placeholders deliberately have no media location.
            project.assets.push(serde_json::from_value(serde_json::json!({
                "id": id, "name": name, "kind": "image", "mimeType": "image/jpeg",
                "imageDraft": true, "imageGeneration": generation, "createdAt": timestamp
            })).map_err(|e| e.to_string())?);
        }
        ProjectCommand::ImageDraftSelect { id } => {
            let asset = project.assets.iter().find(|asset| &asset.id == id && asset.kind == "image" && asset.image_draft == Some(true)
                && asset.image_generation.as_ref().is_some_and(|snapshot| snapshot.template.is_none()))
                .ok_or_else(|| format!("Editable image draft '{id}' was not found."))?;
            let generation = asset.image_generation.clone().unwrap();
            let mut scene = generation.scene;
            scene.output_asset_id = Some(id.clone());
            project.image_scene = Some(scene);
            project.image_settings = Some(ImageSettings { resolution: generation.resolution, aspect_ratio: generation.aspect_ratio, default_look: generation.default_look });
            project.brief.prompt = generation.brief_prompt;
            project.thumbnail = asset.relative_path.clone();
            for reference in generation.references {
                if let Some(current) = project.references.iter_mut().find(|current| current.id == reference.id) { *current = reference; }
                else { project.references.push(reference); }
            }
        }
        _ => unreachable!(),
    }
    project.updated_at = timestamp.into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::commands::execute_commands_at;
    use serde_json::{json, Value};

    #[test]
    fn image_draft_commands_keep_independent_snapshots_and_reject_invalid_batches() {
        let config: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let config = crate::project::validation::validate_and_normalize_config(config).unwrap();
        let fixture: Value = serde_json::from_str(include_str!("../../../../fixtures/image-draft-commands.json")).unwrap();
        let commands: Vec<ProjectCommand> = serde_json::from_value(fixture["commands"].clone()).unwrap();
        let next = execute_commands_at(&config, &commands, &config.updated_at).unwrap();
        assert_eq!(next.settings, config.settings);
        assert_eq!(next.generation_jobs, config.generation_jobs);
        assert_eq!(next.timeline, config.timeline);
        let poster = next.assets.iter().find(|asset| asset.id == "poster").unwrap();
        assert_eq!(poster.image_draft, Some(true));
        assert!(poster.relative_path.is_none() && poster.source_path.is_none());
        let snapshot = poster.image_generation.as_ref().unwrap();
        assert_eq!(snapshot.scene.steps, 30);
        assert_eq!(snapshot.scene.seed, 42);
        assert_eq!(snapshot.scene.nodes.len(), 2);
        assert_eq!(snapshot.scene.nodes[0].description, "@[ref:ref-balloon] floats beside the mountains");
        assert_eq!(snapshot.references[0].id, "ref-balloon");
        assert_eq!(snapshot.resolution, "768p");
        assert_eq!(next.image_settings.as_ref().unwrap().aspect_ratio, "1:1");
        let reopened: ProjectConfig = serde_json::from_value(serde_json::to_value(&next).unwrap()).unwrap();
        assert_eq!(reopened.assets, next.assets);
        assert_eq!(reopened.image_scene, next.image_scene);
        assert_eq!(reopened.image_settings, next.image_settings);
        for invalid in fixture["invalid"].as_array().unwrap() {
            let batch = vec![serde_json::from_value(json!({"op":"image.configure","background":"Must not stick"})).unwrap(),
                serde_json::from_value(invalid.clone()).unwrap()];
            assert!(execute_commands_at(&next, &batch, &next.updated_at).is_err(), "{invalid}");
        }
        assert!(serde_json::from_value::<ProjectCommand>(json!({"op":"image.draft.add","id":"bad","name":"Bad","prompt":"No","relativePath":"invented.png"})).is_err());
        let mut finished = next.clone();
        let asset = finished.assets.iter_mut().find(|asset| asset.id == "banner").unwrap();
        asset.image_draft = Some(false);
        asset.relative_path = Some("media/banner.jpg".into());
        assert!(execute_commands_at(&finished, &[ProjectCommand::ImageDraftSelect { id: "banner".into() }], &finished.updated_at).is_err());
    }
}
