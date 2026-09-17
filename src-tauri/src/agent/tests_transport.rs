use super::{process::probe_command, prompt::*};
use std::{path::Path, time::Duration};

#[test]
fn probes_drain_large_output_without_filling_the_pipe() {
    #[cfg(windows)]
    let result = probe_command(
        Path::new("powershell.exe"),
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write(('x' * 200000))",
        ],
        Duration::from_secs(10),
    );
    #[cfg(not(windows))]
    let result = probe_command(
        Path::new("/bin/sh"),
        &["-c", "head -c 200000 /dev/zero | tr '\\000' x"],
        Duration::from_secs(10),
    );
    let output = result.unwrap();
    assert_eq!(output.len(), 65_536);
    assert!(output.bytes().all(|byte| byte == b'x'));
}

#[test]
fn another_model_supplies_its_own_policy_and_vocabulary() {
    use crate::generation::models::*;
    let model = ModelDefinition {
        defaults: SceneDefaults {
            provider_id: "future-model",
            duration_seconds: 8.0,
        },
        capabilities: ModelCapabilities {
            max_scene_seconds: 30.0,
            min_steps: 1,
            max_image_references: 1,
            max_video_references: 0,
            max_references: 1,
            continuation_overlap: 0,
            frame_stride: 1,
        },
        agent_instructions: "Future model authoring policy.",
        shot_catalog: || "custom-framing: wide".into(),
        validate_shot_settings: |_, _, _| Ok(()),
    };
    let prompt = system_prompt_for(&model);
    assert!(prompt.contains("Future model authoring policy."));
    assert!(prompt.contains("custom-framing: wide"));
    assert!(!prompt.contains(h3::MODEL.agent_instructions));
    assert!(prompt.contains("scene.add"));
}

#[test]
fn credentials_never_enter_model_context() {
    let mut config: crate::project::ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-created.json")).unwrap();
    config.provider_settings = serde_json::from_value(serde_json::json!({
        "future-provider": { "enabled": true, "model": "private-model", "options": { "apiKey": "secret-token" } }
    })).unwrap();
    let prompt = context_prompt(&config, "Plan a scene").unwrap();
    assert!(!prompt.contains("secret-token"));
    assert!(!prompt.contains("private-model"));
}
