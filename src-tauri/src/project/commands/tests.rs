use super::*;
use super::batch::execute_commands;

#[test]
fn scene_creation_uses_injected_model_defaults() {
    let current = fixture();
    let batch = parse_jsonl_commands(r#"{"op":"scene.add","id":"future-scene","title":"Future model","seconds":7}
{"op":"shot.add","scene":"future-scene","id":"future-shot","at":0,"action":"A bird lands."}
{"op":"commit","summary":"Create a scene"}"#).unwrap();
    let next = super::batch::execute_with_defaults(&current, &batch.commands, &current.updated_at,
        crate::generation::models::SceneDefaults { provider_id: "future-model", duration_seconds: 7.0 }).unwrap();
    let scene = next.generation_jobs.iter().find(|scene| scene.id == "future-scene").unwrap();
    assert_eq!(scene.provider_id.as_deref(), Some("future-model"));
    assert_eq!(scene.prompt, "A bird lands.");
    assert_eq!(current, fixture());
}
use crate::project::validation::validate_and_normalize_config;
use super::clips::find_clip_location;
use crate::project::*;

fn fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap()
}

#[test]
fn parses_jsonl_and_preserves_explicit_null_patches() {
    let batch = parse_jsonl_commands(
        r#"```jsonl
{"op":"scene.set","id":"job-01","sound":null}
{"op":"commit","summary":"Removed the sound design."}
```"#,
    )
    .unwrap();
    assert_eq!(batch.summary, "Removed the sound design.");
    assert!(matches!(
        &batch.commands[0],
        ProjectCommand::SceneSet {
            sound: super::patch::Patch::Clear,
            ..
        }
    ));
}

#[test]
fn scene_frame_commands_accept_continuity_and_clear_the_last_frame() {
    let config = fixture();
    let id = &config.generation_jobs[0].id;
    let image = &config
        .references
        .iter()
        .find(|reference| reference.kind == "image")
        .unwrap()
        .id;
    let command: ProjectCommand = serde_json::from_value(serde_json::json!({
        "op": "scene.set", "id": id, "endFrame": image, "usePreviousSceneLastFrame": true
    }))
    .unwrap();
    let updated = execute_commands_at(&config, &[command], "2026-09-12T00:00:00.000Z").unwrap();
    assert_eq!(
        updated.generation_jobs[0].end_frame_reference_id.as_deref(),
        Some(image.as_str())
    );
    assert_eq!(
        updated.generation_jobs[0].use_previous_scene_last_frame,
        Some(true)
    );
    let clear: ProjectCommand = serde_json::from_value(serde_json::json!({
        "op": "scene.set", "id": id, "endFrame": null, "startFrame": image
    }))
    .unwrap();
    let updated = execute_commands_at(&updated, &[clear], "2026-09-12T00:00:00.000Z").unwrap();
    assert!(updated.generation_jobs[0].end_frame_reference_id.is_none());
    assert_ne!(
        updated.generation_jobs[0].use_previous_scene_last_frame,
        Some(true)
    );
    assert_eq!(
        updated.generation_jobs[0]
            .start_frame_reference_id
            .as_deref(),
        Some(image.as_str())
    );
}

#[test]
fn requires_a_final_non_empty_commit() {
    assert!(
        parse_jsonl_commands(r#"{"op":"scene.remove","id":"job-01"}"#)
            .unwrap_err()
            .contains("must end")
    );
    assert!(parse_jsonl_commands(r#"{"op":"commit","summary":""}"#)
        .unwrap_err()
        .contains("summary"));
}

#[test]
fn executes_reference_scene_and_shot_commands_as_one_batch() {
    let commands = parse_jsonl_commands(
        r#"{"op":"ref.add","id":"ref-mara","name":"Mara","text":"A woman in her thirties with cropped black hair, a rust wool jacket, charcoal trousers, and black leather boots.","use":["character"]}
{"op":"scene.add","id":"scene-opening","title":"Workshop arrival","seconds":8}
{"op":"shot.add","scene":"scene-opening","id":"shot-wide","at":0,"action":"@[ref:ref-mara] opens the workshop door and stops beside the workbench."}
{"op":"clip.add","id":"clip-workshop","scene":"scene-opening"}
{"op":"commit","summary":"Added Mara and the opening scene to the timeline."}"#,
    )
    .unwrap()
    .commands;
    let next = execute_commands(&fixture(), &commands).unwrap();
    let scene = next
        .generation_jobs
        .iter()
        .find(|job| job.id == "scene-opening")
        .unwrap();
    assert_eq!(scene.prompt, scene.creative_brief);
    assert_eq!(scene.reference_ids, ["ref-mara"]);
    assert_eq!(scene.shots.as_ref().unwrap()[0].id, "shot-wide");
    assert_eq!(scene.status, "draft");
    assert!(scene.output_relative_path.is_none());
    let clip = next
        .timeline
        .tracks
        .iter()
        .flat_map(|track| &track.clips)
        .find(|clip| clip.id == "clip-workshop")
        .unwrap();
    assert_eq!(
        clip.start_ms, 8_000,
        "default placement appends after the existing clip"
    );
    assert_eq!(clip.duration_ms, 8_000);
    assert_eq!(clip.asset_id, "asset-scene-opening");
    assert_eq!(clip.status, "draft");
    assert!(next
        .assets
        .iter()
        .any(|asset| asset.id == "asset-scene-opening"));
}

#[test]
fn timeline_commands_support_explicit_arrangements_and_removal() {
    let current = validate_and_normalize_config(fixture()).unwrap();
    let commands = parse_jsonl_commands(
        r#"{"op":"clip.add","id":"clip-macro-second-layer","asset":"asset-imported","track":"track-v2","at":2,"seconds":3,"sourceAt":1,"label":"Macro insert"}
{"op":"clip.set","id":"clip-macro-second-layer","track":"track-v3","at":4}
{"op":"commit","summary":"Placed and moved the macro insert."}"#,
    )
    .unwrap()
    .commands;
    let arranged = execute_commands(&current, &commands).unwrap();
    let clip = arranged.timeline.tracks[2]
        .clips
        .iter()
        .find(|clip| clip.id == "clip-macro-second-layer")
        .unwrap();
    assert_eq!(clip.start_ms, 4_000);
    assert_eq!(clip.duration_ms, 3_000);
    assert_eq!(clip.source_start_ms, 1_000);
    assert_eq!(clip.label, "Macro insert");

    let clip_id = clip.id.clone();
    let removed =
        execute_commands(&arranged, &[ProjectCommand::ClipRemove { id: clip_id }]).unwrap();
    assert!(find_clip_location(&removed, "clip-macro-second-layer").is_none());
}

#[test]
fn a_failed_command_does_not_mutate_the_input() {
    let current = fixture();
    let original = current.clone();
    let commands = vec![
        ProjectCommand::ProjectSet {
            name: Some("Changed".into()),
            prompt: None,
            target_seconds: None,
            aspect_ratio: None,
            resolution: None,
            frame_rate: None,
            background_color: None,
        },
        ProjectCommand::SceneRemove {
            id: "missing-scene".into(),
        },
    ];
    let error = execute_commands(&current, &commands).unwrap_err();
    assert!(error.contains("Command 2 (scene.remove)"));
    assert_eq!(current, original);
}

#[test]
fn project_video_settings_update_both_mirrors_without_retiming_media() {
    let current = validate_and_normalize_config(fixture()).unwrap();
    let commands = parse_jsonl_commands(r#"{"op":"project.set","aspectRatio":"9:16","resolution":"544p","targetSeconds":90}
{"op":"commit","summary":"Changed the project video settings."}"#).unwrap();
    let next = execute_commands(&current, &commands.commands).unwrap();
    assert_eq!(next.settings.aspect_ratio, "9:16");
    assert_eq!(next.settings.resolution, "544p");
    assert_eq!(next.brief.aspect_ratio, "9:16");
    assert_eq!(next.brief.resolution, "544p");
    assert_eq!(next.brief.target_duration_seconds, 90);
    assert_eq!(next.timeline, current.timeline);
    assert_eq!(next.assets, current.assets);
    for patch in [r#""targetSeconds":601"#, r#""resolution":"8k""#, r#""aspectRatio":"21:9""#] {
        let command: ProjectCommand = serde_json::from_str(&format!(r#"{{"op":"project.set",{patch}}}"#)).unwrap();
        assert!(execute_commands(&current, &[command]).is_err());
    }
}

#[test]
fn a_small_scene_patch_preserves_render_owned_fields() {
    let current = fixture();
    let before = current
        .generation_jobs
        .iter()
        .find(|job| job.id == "job-opener")
        .unwrap()
        .clone();
    let commands = parse_jsonl_commands(
        r#"{"op":"scene.set","id":"job-opener","title":"Warmer opener"}
{"op":"commit","summary":"Renamed the opener."}"#,
    )
    .unwrap()
    .commands;
    let next = execute_commands_at(&current, &commands, "2026-09-02T20:00:00.000Z").unwrap();
    let after = next
        .generation_jobs
        .iter()
        .find(|job| job.id == "job-opener")
        .unwrap();
    assert_eq!(after.title, "Warmer opener");
    assert_eq!(after.status, before.status);
    assert_eq!(after.output_relative_path, before.output_relative_path);
    assert_eq!(after.generation_snapshot, before.generation_snapshot);
    assert_eq!(after.updated_at, "2026-09-02T20:00:00.000Z");
}

#[test]
fn commands_cannot_deserialize_protected_scene_fields() {
    let error = serde_json::from_str::<ProjectCommand>(
        r#"{"op":"scene.set","id":"job-01","outputRelativePath":"outside.mp4"}"#,
    )
    .unwrap_err();
    assert!(error.to_string().contains("unknown field"), "{error}");
}
