use super::*;

fn image_fixture() -> ProjectConfig {
    serde_json::from_str(include_str!("../../../fixtures/project-v1-image.json")).unwrap()
}

#[test]
fn image_editing_draft_survives_save_and_reopen() {
    let mut config = image_fixture();
    let mut snapshot: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/image-generation-snapshot.json")).unwrap();
    snapshot["scene"]["rootType"] = serde_json::json!("image");
    snapshot["scene"]["sourceImage"] = serde_json::json!({"name":"Source", "relativePath":"media/imported/source.png", "width":65, "height":41});
    config.assets.push(serde_json::from_value(serde_json::json!({
        "id":"draft", "kind":"image", "name":"Editing Source", "relativePath":"media/imported/source.png", "mimeType":"image/png",
        "width":65, "height":41, "createdAt":config.created_at, "imageDraft":true, "imageGeneration":snapshot
    })).unwrap());
    snapshot["scene"]["rootType"] = serde_json::json!("prompt");
    snapshot["scene"]["sourceImage"] = serde_json::Value::Null;
    snapshot["scene"]["nodes"].as_array_mut().unwrap().truncate(1);
    snapshot["scene"]["nodes"][0]["description"] = serde_json::json!("");
    config.assets.push(serde_json::from_value(serde_json::json!({
        "id":"empty-draft", "kind":"image", "name":"New image", "mimeType":"image/jpeg",
        "createdAt":config.created_at, "imageDraft":true, "imageGeneration":snapshot
    })).unwrap());
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let opened = read_project(Path::new(&created.folder_path)).unwrap();
    assert_eq!(opened.config.assets, config.assets);
    let mut invalid = opened.config;
    invalid.assets[0].image_generation = None;
    assert!(validate_and_normalize_config(invalid).is_err());
}

#[test]
fn edited_png_preserves_exact_pixels_and_exports_to_jpeg() {
    let folder = project_folder();
    let rgba: Vec<u8> = (0..65 * 41).flat_map(|index| [(index % 256) as u8, 80, 160, 255]).collect();
    let saved = crate::commands::artifacts::write_generated_png_frame(&folder.path().to_string_lossy(), "edit-test", 65, 41, &rgba).unwrap();
    let source = folder.path().join(saved.relative_path);
    assert_eq!(::image::open(&source).unwrap().to_rgba8().as_raw(), &rgba);
    let copy = folder.path().join("copy.png");
    export_image_file(&source, &copy).unwrap();
    assert_eq!(fs::read(&source).unwrap(), fs::read(copy).unwrap());
    let jpeg = folder.path().join("export.jpg");
    export_image_file(&source, &jpeg).unwrap();
    assert_eq!(::image::image_dimensions(jpeg).unwrap(), (65, 41));
}

#[test]
fn image_root_survives_save_and_agent_hierarchy_replacement() {
    use crate::project::commands::{execute_commands_at, ProjectCommand};
    let mut config = image_fixture();
    let scene = config.image_scene.as_mut().unwrap();
    scene.root_type = Some("image".into());
    scene.source_image = Some(crate::project::image::ImageSource { relative_path: "media/imported/source.png".into(), name: "Source".into(), width: 65, height: 41 });
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let reopened = read_project(Path::new(&created.folder_path)).unwrap();
    assert_eq!(reopened.config.image_scene, config.image_scene);
    let mut command = serde_json::to_value(config.image_scene.as_ref().unwrap()).unwrap();
    for field in ["rootType", "sourceImage", "outputAssetId"] { command.as_object_mut().unwrap().remove(field); }
    command["op"] = serde_json::json!("image.set");
    let parsed: ProjectCommand = serde_json::from_value(command).unwrap();
    let changed = execute_commands_at(&config, &[parsed], &config.updated_at).unwrap();
    assert_eq!(changed.image_scene, config.image_scene);
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
fn image_export_writes_real_png_or_copies_jpeg_without_changing_pixels_or_resolution() {
    let folder = project_folder();
    let root = folder.path().to_string_lossy();
    let rgba: Vec<u8> = (0..64 * 40).flat_map(|index| [(index % 256) as u8, 80, 160, 255]).collect();
    let saved = write_generated_image_frame(&root, "export-test", 64, 40, &rgba).unwrap();
    let source = folder.path().join(saved.relative_path);
    let jpeg = fs::read(&source).unwrap();
    for extension in ["jpg", "jpeg", "JPG"] {
        let destination = folder.path().join(format!("export.{extension}"));
        export_image_file(&source, &destination).unwrap();
        assert_eq!(fs::read(destination).unwrap(), jpeg);
    }
    let destination = folder.path().join("export.PNG");
    export_image_file(&source, &destination).unwrap();
    let png = fs::read(&destination).unwrap();
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let decoded = ::image::load_from_memory_with_format(&png, ::image::ImageFormat::Png).unwrap();
    let original = ::image::load_from_memory_with_format(&jpeg, ::image::ImageFormat::Jpeg).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (64, 40));
    assert_eq!(decoded.to_rgb8(), original.to_rgb8());
    export_image_file(&source, &folder.path().join("no-extension")).unwrap();
    assert_eq!(fs::read(folder.path().join("no-extension.jpg")).unwrap(), jpeg);
    let unsupported = folder.path().join("export.gif");
    fs::write(&unsupported, b"existing file").unwrap();
    assert!(export_image_file(&source, &unsupported).is_err());
    assert_eq!(fs::read(unsupported).unwrap(), b"existing file");
    assert_eq!(fs::read(source).unwrap(), jpeg);
}

#[test]
fn image_export_resizes_and_reencodes_at_the_chosen_quality() {
    use crate::commands::artifacts::{export_image_file_with, ImageExportFormat, ImageExportOptions};
    let folder = project_folder();
    let root = folder.path().to_string_lossy();
    let rgba: Vec<u8> = (0..128 * 80).flat_map(|index| [(index % 256) as u8, (index / 7 % 256) as u8, 160, 255]).collect();
    let saved = write_generated_image_frame(&root, "resize-test", 128, 80, &rgba).unwrap();
    let source = folder.path().join(saved.relative_path);
    let original = fs::read(&source).unwrap();
    let half = folder.path().join("half.png");
    export_image_file_with(&source, &half, ImageExportOptions { format: Some(ImageExportFormat::Png), width: Some(64), height: Some(40), quality: None }).unwrap();
    assert_eq!(::image::image_dimensions(&half).unwrap(), (64, 40));
    let enlarged = folder.path().join("enlarged.jpg");
    export_image_file_with(&source, &enlarged, ImageExportOptions { format: Some(ImageExportFormat::Jpg), width: Some(1280), height: Some(720), quality: Some(90) }).unwrap();
    let decoded = ::image::open(&enlarged).unwrap().to_rgb8();
    assert_eq!(decoded.dimensions(), (1280, 720));
    // Content fills the new canvas, including its far edge, rather than padding.
    assert!(decoded.get_pixel(1279, 719)[2] > 100);
    assert_eq!(fs::read(&source).unwrap(), original);
    let low = folder.path().join("low.jpg");
    export_image_file_with(&source, &low, ImageExportOptions { format: Some(ImageExportFormat::Jpg), width: None, height: None, quality: Some(20) }).unwrap();
    let low = fs::read(low).unwrap();
    assert_ne!(low, original);
    assert!(low.len() < original.len());
    let best = folder.path().join("best.jpg");
    export_image_file_with(&source, &best, ImageExportOptions { format: Some(ImageExportFormat::Jpg), width: None, height: None, quality: Some(100) }).unwrap();
    assert_eq!(fs::read(best).unwrap(), original);
    let zero = folder.path().join("zero.jpg");
    assert!(export_image_file_with(&source, &zero, ImageExportOptions { format: None, width: Some(0), height: Some(40), quality: None }).is_err());
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
fn image_generation_history_survives_native_save_and_reopen_and_validates_snapshots() {
    let mut snapshot: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/image-generation-snapshot.json")).unwrap();
    snapshot["usedSeed"] = serde_json::json!(9_007_199_254_740_991_u64);
    snapshot["scene"]["nodes"][1]["referenceIds"] = snapshot["scene"]["referenceIds"].clone();
    snapshot["scene"]["referenceIds"] = serde_json::json!([]);
    let expected: crate::project::image::ImageGenerationSnapshot = serde_json::from_value(snapshot.clone()).unwrap();
    let mut config = image_fixture();
    config.assets.push(serde_json::from_value(serde_json::json!({
        "id": "image-history", "kind": "image", "name": "Lantern", "relativePath": "media/generated/lantern.jpg",
        "mimeType": "image/jpeg", "width": 1088, "height": 1344, "createdAt": config.created_at,
        "imageGeneration": snapshot,
    })).unwrap());
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let opened = read_project(Path::new(&created.folder_path)).unwrap();
    assert_eq!(opened.config.assets[0].image_generation.as_ref(), Some(&expected));
    let mut updated = opened.config;
    updated.image_scene.as_mut().unwrap().background = "Changed since generation".into();
    updated.references.clear();
    write_project(Path::new(&created.folder_path), &updated).unwrap();
    let reopened = read_project(Path::new(&created.folder_path)).unwrap();
    assert_eq!(reopened.config.assets[0].image_generation.as_ref(), Some(&expected));
    for invalid in ["tree", "reference", "resolution", "seed"] {
        let mut bad = reopened.config.clone();
        let history = bad.assets[0].image_generation.as_mut().unwrap();
        match invalid {
            "tree" => history.scene.nodes[1].parent_id = Some("missing".into()),
            "reference" => history.references.clear(),
            "seed" => history.used_seed = Some(9_007_199_254_740_992),
            _ => history.resolution = "invalid".into(),
        }
        assert!(validate_and_normalize_config(bad).is_err(), "{invalid}");
    }
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

#[test]
fn granular_image_commands_edit_subtrees_without_touching_generated_outputs() {
    use crate::project::commands::{execute_commands_at, parse_jsonl_commands};
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/image-commands.json")).unwrap();
    let stream = cases["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|command| serde_json::to_string(command).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n{\"op\":\"commit\",\"summary\":\"Composed balloons\"}";
    let commands = parse_jsonl_commands(&stream).unwrap().commands;
    let mut current = image_fixture();
    current.image_scene.as_mut().unwrap().output_asset_id = Some("saved-result".into());
    let next = execute_commands_at(&current, &commands, &current.updated_at).unwrap();
    let scene = next.image_scene.unwrap();
    assert_eq!(scene.output_asset_id.as_deref(), Some("saved-result"));
    assert_eq!(scene.nodes[0].description, "Balloons over the sea");
    assert_eq!(scene.style.lighting, "Soft morning light");
    assert_eq!(scene.style.mode, "art");
    let siblings: Vec<_> = scene
        .nodes
        .iter()
        .filter(|node| node.parent_id.as_deref() == Some("image-root"))
        .map(|node| node.id.as_str())
        .collect();
    assert_eq!(siblings, ["caption", "sky-copy", "group-rocket"]);
    let balloon = scene
        .nodes
        .iter()
        .find(|node| node.id == "sky-copy--balloon")
        .unwrap();
    assert_eq!(balloon.parent_id.as_deref(), Some("caption"));
    assert_eq!(balloon.description, "A red balloon");
    assert_eq!(
        balloon.r#box,
        Some(crate::project::image::ImageBox {
            x: 250.0,
            y: 250.0,
            width: 50.0,
            height: 50.0
        })
    );
    assert!(scene
        .nodes
        .iter()
        .all(|node| node.id != "sky" && node.id != "balloon"));
    assert_eq!(
        scene.nodes.iter().find(|node| node.id == "title"),
        Some(&current.image_scene.as_ref().unwrap().nodes[2])
    );
    for command in &commands {
        assert!(
            execute_commands_at(&created_fixture(), &[command.clone()], &current.updated_at)
                .is_err()
        );
    }
}

#[test]
fn image_prompts_cite_existing_references_and_keep_them_from_removal() {
    use crate::project::commands::{execute_commands_at, ProjectCommand};
    let command = |value: serde_json::Value| -> ProjectCommand { serde_json::from_value(value).unwrap() };
    let current = image_fixture();
    let add = command(serde_json::json!({"op":"ref.add","id":"ref-mara","name":"Mara","text":"A lighthouse keeper","use":["character"]}));
    let cite = command(serde_json::json!({"op":"image.configure","prompt":"@[ref:ref-mara] holds the lantern","background":"Fog"}));
    let next = execute_commands_at(&current, &[add.clone(), cite], &current.updated_at).unwrap();
    assert_eq!(next.image_scene.as_ref().unwrap().cited_reference_ids().unwrap(), ["ref-mara"]);
    let remove = command(serde_json::json!({"op":"ref.remove","id":"ref-mara"}));
    let error = execute_commands_at(&next, &[remove], &next.updated_at).unwrap_err();
    assert!(error.contains("still used by the image"), "{error}");
    for text in ["@[ref:missing] waves", "A @[ref:ref-mara"] {
        let cite = command(serde_json::json!({"op":"image.configure","background":text}));
        assert!(execute_commands_at(&current, &[add.clone(), cite], &current.updated_at).is_err(), "{text}");
    }
}

#[test]
fn invalid_image_commands_roll_back_the_entire_batch() {
    use crate::project::commands::{execute_commands_at, ProjectCommand};
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/image-commands.json")).unwrap();
    let current = image_fixture();
    let original = current.clone();
    let valid: ProjectCommand = serde_json::from_value(
        serde_json::json!({"op":"image.configure","background":"Must not stick"}),
    )
    .unwrap();
    for invalid in cases["invalid"].as_array().unwrap() {
        if let Ok(command) = serde_json::from_value::<ProjectCommand>(invalid.clone()) {
            assert!(
                execute_commands_at(&current, &[valid.clone(), command], &current.updated_at)
                    .is_err(),
                "{invalid}"
            );
        }
        assert_eq!(current, original);
    }
}

#[test]
fn image_node_patches_distinguish_missing_and_null_and_initialize_older_image_projects() {
    use crate::project::commands::{execute_commands_at, ProjectCommand};
    let current = image_fixture();
    let edit = |config: &ProjectConfig, value: serde_json::Value| {
        let command: ProjectCommand = serde_json::from_value(value).unwrap();
        execute_commands_at(config, &[command], &config.updated_at).unwrap()
    };
    let renamed = edit(
        &current,
        serde_json::json!({"op":"image.node.set","id":"group-rocket","name":"Vehicle"}),
    );
    assert_eq!(
        renamed.image_scene.as_ref().unwrap().nodes[1].r#box,
        current.image_scene.as_ref().unwrap().nodes[1].r#box
    );
    let cleared = edit(
        &renamed,
        serde_json::json!({"op":"image.node.set","id":"group-rocket","box":null}),
    );
    assert!(cleared.image_scene.as_ref().unwrap().nodes[1]
        .r#box
        .is_none());
    assert_eq!(
        cleared.image_scene.as_ref().unwrap().nodes[2].r#box,
        current.image_scene.as_ref().unwrap().nodes[2].r#box
    );
    let mut older = current;
    older.image_scene = None;
    let initialized = edit(
        &older,
        serde_json::json!({"op":"image.node.add","id":"subject","parent":"image-root","kind":"object","name":"Subject"}),
    );
    assert_eq!(
        initialized.image_scene.as_ref().unwrap().nodes[0].description,
        older.brief.prompt
    );
    assert_eq!(initialized.image_scene.as_ref().unwrap().nodes.len(), 2);
}
