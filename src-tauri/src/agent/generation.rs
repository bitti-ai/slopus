use super::generators::GeneratorContext;
use crate::project::ProjectConfig;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum GenerationCommand {
    #[serde(rename = "scene.generate")]
    Generate { scene: String, template: String },
}

pub(super) fn validate(
    command: &GenerationCommand,
    config: &ProjectConfig,
    generators: &GeneratorContext,
) -> Result<(), String> {
    let GenerationCommand::Generate { scene, template } = command;
    if !config.generation_jobs.iter().any(|job| &job.id == scene) {
        return Err(format!(
            "Unknown scene '{scene}'. Create the scene before generating it."
        ));
    }
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
