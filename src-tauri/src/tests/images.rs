use super::*;

fn image_fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../fixtures/project-v1-image.json")).unwrap()
}

#[test]
fn generated_jpeg_preserves_resolution_and_stays_inside_the_project() {
    let folder = project_folder();
    let root = folder.path().to_string_lossy();
    let rgba = vec![128; 640 * 416 * 4];
    let saved = write_generated_image_frame(&root, "image-test", 640, 416, &rgba).unwrap();
    assert_eq!((saved.width, saved.height), (640, 416));
    assert_eq!(saved.relative_path, "media/generated/image-test.jpg");
    let bytes = fs::read(folder.path().join(saved.relative_path)).unwrap();
    assert!(bytes.starts_with(&[0xff, 0xd8]));
    // Baseline JPEG SOF: precision, then big-endian height and width.
    let sof = bytes
        .windows(2)
        .position(|pair| pair == [0xff, 0xc0])
        .unwrap();
    assert_eq!(&bytes[sof + 5..sof + 9], &[1, 160, 2, 128]);
    assert!(write_generated_image_frame(&root, "../escape", 640, 416, &rgba).is_err());
    assert!(write_generated_image_frame(&root, "bad-pixels", 640, 416, &[0; 4]).is_err());
}

#[test]
fn image_tree_survives_folder_creation_save_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let config = image_fixture();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = Path::new(&created.folder_path);
    let mut opened = read_project(folder).unwrap();
    opened.config.image_scene.as_mut().unwrap().nodes[2].text = "TO THE MOON".into();
    write_project(folder, &opened.config).unwrap();
    let reopened = read_project(folder).unwrap();
    assert_eq!(reopened.config.generation_type, GenerationType::Image);
    assert_eq!(reopened.config.image_scene, opened.config.image_scene);
    assert!(reopened.config.generation_jobs.is_empty());
    let wire = serde_json::to_value(config.clone()).unwrap();
    assert_eq!(wire["imageScene"]["nodes"][1]["parentId"], "image-root");
    let roundtrip: ProjectConfig = serde_json::from_value(wire).unwrap();
    assert_eq!(roundtrip.image_scene, config.image_scene);
}

#[test]
fn invalid_image_hierarchies_and_bounds_are_rejected() {
    for invalid in ["cycle", "missing", "duplicate", "disconnected", "bounds"] {
        let mut config = image_fixture();
        let scene = config.image_scene.as_mut().unwrap();
        match invalid {
            "cycle" => scene.nodes[1].parent_id = Some(scene.nodes[2].id.clone()),
            "missing" => scene.nodes[1].parent_id = Some("missing".into()),
            "duplicate" => scene.nodes[1].id = scene.nodes[0].id.clone(),
            "disconnected" => scene.nodes[1].parent_id = None,
            _ => scene.nodes[1].r#box.as_mut().unwrap().width = 1000.0,
        }
        assert!(validate_and_normalize_config(config).is_err(), "{invalid}");
    }
}

#[test]
fn agent_image_edits_preserve_outputs_and_reject_video_projects_or_invalid_trees() {
    use crate::project::commands::{execute_commands_at, ProjectCommand};
    let mut config = image_fixture();
    config.image_scene.as_mut().unwrap().output_asset_id = Some("generated-picture".into());
    let mut command = serde_json::to_value(config.image_scene.as_ref().unwrap()).unwrap();
    command.as_object_mut().unwrap().remove("outputAssetId");
    command["op"] = serde_json::json!("image.set");
    command["background"] = serde_json::json!("A moonlit ocean");
    let parsed: ProjectCommand = serde_json::from_value(command.clone()).unwrap();
    let next = execute_commands_at(&config, &[parsed.clone()], &config.updated_at).unwrap();
    assert_eq!(
        next.image_scene.as_ref().unwrap().background,
        "A moonlit ocean"
    );
    assert_eq!(
        next.image_scene
            .as_ref()
            .unwrap()
            .output_asset_id
            .as_deref(),
        Some("generated-picture")
    );
    assert!(execute_commands_at(&created_fixture(), &[parsed], &config.updated_at).is_err());
    command["nodes"][1]["parentId"] = serde_json::json!("missing");
    let parsed: ProjectCommand = serde_json::from_value(command).unwrap();
    assert!(execute_commands_at(&config, &[parsed], &config.updated_at).is_err());
}
