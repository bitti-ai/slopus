use super::generators::GeneratorContext;
use crate::project::ProjectConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum GenerationCommand {
    #[serde(rename = "scene.generate")]
    Generate { scene: String, template: String },
    #[serde(rename = "image.generate")]
    Image { image: String, template: String },
}

pub(super) fn validate(
    command: &GenerationCommand,
    config: &ProjectConfig,
    generators: &GeneratorContext,
) -> Result<(), String> {
    let template = match command {
        GenerationCommand::Generate { scene, template } => {
            if !config.generation_jobs.iter().any(|job| &job.id == scene) {
                return Err(format!("Unknown scene '{scene}'. Create the scene before generating it."));
            }
            template
        }
        GenerationCommand::Image { image, template } => {
            // A finished image must still reach the app's per-turn receipt
            // cache if the provider repeats its request after completion.
            // The queue host permits new renders only from editable drafts.
            if !config.assets.iter().any(|asset| &asset.id == image && asset.kind == "image"
                && asset.image_generation.as_ref().is_some_and(|snapshot| snapshot.template.is_none())) {
                return Err(format!("Image draft or result '{image}' was not found. Use image.draft.add first."));
            }
            if generators.settings["templates"].as_array().is_some_and(|templates| templates.iter().any(|item|
                item["id"].as_str() == Some(template) && item["mode"].as_str() == Some("animate"))) {
                return Err("Choose a prompt generator for images.".into());
            }
            template
        }
    };
    if !generators.settings["templates"]
        .as_array()
        .is_some_and(|templates| {
            templates
                .iter()
                .any(|item| item["id"].as_str() == Some(template))
        })
    {
        return Err(format!(
            "Unknown generator template '{template}'. Use generator.list to find its id."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{protocol::parse_turn_result, AgentTurnResult};
    use serde_json::json;

    #[test]
    fn image_generation_validates_prepared_drafts_and_prompt_generators() {
        let config: ProjectConfig = serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
        let response = json!({"kind":"generation","summary":"Prepare and generate", "prepare":[
            {"op":"image.draft.add","id":"poster","name":"Poster","prompt":"A red balloon"}
        ], "command":{"op":"image.generate","image":"poster","template":"chosen"}});
        let AgentTurnResult::Generation { command, prepare, .. } = parse_turn_result(&response.to_string()).unwrap() else { panic!() };
        let mut generators = GeneratorContext { settings: json!({"templates":[{"id":"chosen","mode":"prompt"}]}), ..Default::default() };
        assert!(validate(&command, &config, &generators).is_err());
        let prepared = crate::project::commands::execute_commands_at(&config, &prepare, &config.updated_at).unwrap();
        validate(&command, &prepared, &generators).unwrap();
        let mut completed = prepared.clone();
        completed.assets.iter_mut().find(|asset| asset.id == "poster").unwrap().image_draft = Some(false);
        // Duplicate requests need to reach the frontend receipt cache.
        validate(&command, &completed, &generators).unwrap();
        generators.settings["templates"][0]["mode"] = json!("animate");
        assert!(validate(&command, &prepared, &generators).is_err());
        assert!(parse_turn_result(&json!({"kind":"generation","summary":"Bad","command":{"op":"image.generate","image":"poster","template":"chosen","relativePath":"fake.png"}}).to_string()).is_err());
    }

    #[test]
    fn generation_requires_existing_scene_and_template_without_mutating_either() {
        let config: ProjectConfig =
            serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json"))
                .unwrap();
        let scene = config.generation_jobs[0].id.clone();
        let generators = GeneratorContext {
            settings: json!({"templates":[{"id":"chosen"}]}),
            ..Default::default()
        };
        let request = json!({"kind":"generation","summary":"Generate this scene","command":{"op":"scene.generate","scene":scene,"template":"chosen"}});
        let before = serde_json::to_value(&config).unwrap();
        let AgentTurnResult::Generation { command, .. } =
            parse_turn_result(&request.to_string()).unwrap()
        else {
            panic!("generation command");
        };
        validate(&command, &config, &generators).unwrap();
        assert_eq!(before, serde_json::to_value(&config).unwrap());
        assert!(validate(
            &GenerationCommand::Generate {
                scene: "unknown".into(),
                template: "chosen".into()
            },
            &config,
            &generators
        )
        .unwrap_err()
        .contains("Unknown scene"));
        assert!(validate(
            &GenerationCommand::Generate {
                scene,
                template: "unknown".into()
            },
            &config,
            &generators
        )
        .unwrap_err()
        .contains("Unknown generator"));
    }

    #[test]
    fn generation_rejects_missing_ids_extra_fields_and_mixed_commands() {
        for command in [
            json!({"op":"scene.generate","scene":"s"}),
            json!({"op":"scene.generate","template":"t"}),
            json!({"op":"scene.generate","scene":"s","template":"t","path":"weights.bin"}),
            json!({"op":"scene.generate","scene":["s"],"template":"t"}),
        ] {
            assert!(parse_turn_result(
                &json!({"kind":"generation","summary":"Generate","command":command}).to_string()
            )
            .is_err());
        }
        assert!(parse_turn_result(r#"{"kind":"generation","summary":"","command":{"op":"scene.generate","scene":"s","template":"t"}}"#).is_err());
        assert!(parse_turn_result(r#"{"kind":"generation","summary":"Generate","commands":[],"command":{"op":"scene.generate","scene":"s","template":"t"}}"#).is_err());
        assert!(parse_turn_result("{\"op\":\"scene.generate\",\"scene\":\"s\",\"template\":\"t\"}\n{\"op\":\"commit\",\"summary\":\"Generate\"}").is_err());
    }
}
