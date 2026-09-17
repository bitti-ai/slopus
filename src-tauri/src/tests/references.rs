use super::*;

#[test]
fn reference_icon_files_are_256_square_jpegs_confined_to_the_project() {
    let root = tempfile::tempdir().unwrap();
    write_project(root.path(), &fixture()).unwrap();
    let rgba = vec![128; 768 * 768 * 4];
    let folder = root.path().to_str().unwrap();
    let relative = write_reference_icon_frame(folder, "icon-test", &rgba).unwrap();
    assert_eq!(relative, "references/icons/icon-test.jpg");
    let jpeg = fs::read(root.path().join(&relative)).unwrap();
    let mut expected = Vec::new();
    jpeg_encoder::Encoder::new(&mut expected, 95)
        .encode(
            &vec![128; 256 * 256 * 3],
            256,
            256,
            jpeg_encoder::ColorType::Rgb,
        )
        .unwrap();
    assert_eq!(jpeg, expected);
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    assert_eq!(&jpeg[jpeg.len() - 2..], &[0xff, 0xd9]);
    let frame = jpeg
        .windows(2)
        .position(|bytes| bytes == [0xff, 0xc0])
        .unwrap();
    assert_eq!(u16::from_be_bytes([jpeg[frame + 5], jpeg[frame + 6]]), 256);
    assert_eq!(u16::from_be_bytes([jpeg[frame + 7], jpeg[frame + 8]]), 256);
    assert!(write_reference_icon_frame(folder, "../escape", &rgba).is_err());
    assert!(write_reference_icon_frame(folder, "icon-invalid", &[0; 4]).is_err());
}

#[test]
fn reference_categories_and_subcategories_survive_project_save() {
    let root = tempfile::tempdir().unwrap();
    for (category, subcategory) in [
        ("character", "Animation"),
        ("animal", "Pets"),
        ("product", "Technology"),
        ("location", "Urban"),
        ("style", "Cinematic"),
    ] {
        let mut config = fixture();
        let reference = &mut config.references[0];
        reference.intended_use = vec![category.into()];
        reference.subcategory = Some(subcategory.into());
        reference.icon_relative_path = Some("references/icons/example.jpg".into());
        reference.description.clear();
        reference.content = None;
        write_project(root.path(), &config).unwrap();
        let restored = read_project(root.path()).unwrap();
        let reference = &restored.config.references[0];
        assert_eq!(reference.intended_use, vec![category]);
        assert_eq!(reference.subcategory.as_deref(), Some(subcategory));
        assert_eq!(
            reference.icon_relative_path.as_deref(),
            Some("references/icons/example.jpg")
        );
        assert!(reference.description.is_empty());
        assert!(reference.content.is_none());
    }
}

#[test]
fn initial_reference_images_are_copied_and_bound_to_the_first_draft() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("mood board.webp");
    fs::write(&source, b"fixture-image").unwrap();
    let config = fixture();

    let created =
        create_project_in_with_references(root.path(), &config, std::slice::from_ref(&source))
            .unwrap();
    let reference = created
        .config
        .references
        .iter()
        .find(|reference| reference.id == "ref-initial-1")
        .unwrap();

    assert_eq!(reference.kind, "image");
    assert_eq!(reference.intended_use, vec!["style"]);
    // The description must stay EMPTY. `compileMiniMaxH3Prompt` emits a
    // reference's description as the subject's traits in the prompt sent to
    // the paid model, so app-authored filing boilerplate here is shipped to
    // the model as if the user had written it about their own image
    // ("<Subject 1> is harbor-facade, shown in <Picture 1>. Visual
    // reference supplied with the initial project brief."). The app never
    // invents words and presents them as the user's description — the text
    // path documents the same rule at src/lib/project.ts:87.
    assert_eq!(
        reference.description, "",
        "an imported reference must carry no app-authored description"
    );
    assert!(created
        .config
        .generation_jobs
        .first()
        .unwrap()
        .reference_ids
        .contains(&reference.id));
    assert!(Path::new(&created.folder_path)
        .join(reference.relative_path.as_ref().unwrap())
        .is_file());
}

#[test]
fn a_video_reference_is_pointed_at_while_an_image_reference_is_copied() {
    let access = MediaAccess::default();
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    let video = root.path().join("reference cut.mov");
    fs::write(&video, b"video").unwrap();
    let image = root.path().join("harbor facade.png");
    fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();

    let referenced = import_reference_file(&access, &video, &project).unwrap();
    assert_eq!(referenced.kind, "video");
    assert_eq!(referenced.relative_path, None);
    assert!(referenced.source_path.is_some());
    assert!(
        !project
            .join("references")
            .join("reference cut.mov")
            .exists(),
        "a video reference was copied into the project"
    );

    let copied = import_reference_file(&access, &image, &project).unwrap();
    assert_eq!(copied.kind, "image");
    assert_eq!(
        copied.relative_path.as_deref(),
        Some("references/harbor facade.png")
    );
    assert_eq!(copied.source_path, None);
    assert!(project.join("references/harbor facade.png").is_file());
}

#[test]
fn blank_text_references_never_block_a_project_save() {
    // The workspace creates an empty text reference the instant "New
    // definition" is clicked, before the user has typed anything. Rejecting
    // it here failed the whole save and blocked every unrelated edit in the
    // project — a regression that shipped once already. A blank text
    // reference must stay valid; do not tighten this without a UI change.
    let mut config = fixture();
    config.references.push(ReusableReference {
        id: "reference-blank".into(),
        kind: "text".into(),
        name: "New definition".into(),
        description: String::new(),
        content: None,
        relative_path: None,
        source_path: None,
        images: Vec::new(),
        refmods: Vec::new(),
        video: None,
        intended_use: Vec::new(),
        subcategory: None,
        icon_relative_path: None,
        created_at: "2026-01-01T00:07:00.000Z".into(),
    });
    assert!(
        validate_and_normalize_config(config).is_ok(),
        "a blank text reference must never block saving the project"
    );
}

#[test]
fn refmod_attachments_round_trip_and_validate_ranges_and_paths() {
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["references"][0]["refmods"] = serde_json::json!([
        { "id": "latent", "name": "Person", "sourcePath": "D:/person.safetensors", "strength": 0.7, "copies": 2 }
    ]);
    let config =
        validate_and_normalize_config(serde_json::from_value(value.clone()).unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = Path::new(&created.folder_path);
    write_project(folder, &created.config).unwrap();
    assert_eq!(
        read_project(folder).unwrap().config.references[0].refmods,
        config.references[0].refmods
    );
    for (key, invalid) in [
        ("strength", serde_json::json!(-0.1)),
        ("strength", serde_json::json!(1.1)),
        ("copies", serde_json::json!(0)),
        ("copies", serde_json::json!(11)),
        ("sourcePath", serde_json::json!("../outside.safetensors")),
        ("sourcePath", serde_json::Value::Null),
    ] {
        let mut broken = value.clone();
        broken["references"][0]["refmods"][0][key] = invalid;
        assert!(serde_json::from_value(broken)
            .map_err(|error| error.to_string())
            .and_then(validate_and_normalize_config)
            .is_err());
    }
}

#[test]
fn unified_reference_import_copies_images_and_keeps_video_and_refmod_sources() {
    let access = MediaAccess::default();
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let paths = [
        root.path().join("photo.png"),
        root.path().join("motion.mp4"),
        root.path().join("person.safetensors"),
    ];
    for path in &paths {
        fs::write(path, b"source").unwrap();
    }
    let imported = import_reference_attachments(&access, &project, &paths).unwrap();
    assert_eq!(
        imported.iter().map(|file| file.kind).collect::<Vec<_>>(),
        ["image", "video", "refmod"]
    );
    assert!(project
        .join(imported[0].relative_path.as_ref().unwrap())
        .is_file());
    assert!(imported[2].relative_path.is_none());
    assert_eq!(
        imported[2].source_path.as_deref(),
        Some(external_source_path(&paths[2]).unwrap().as_str())
    );
    assert!(paths.iter().all(|path| path.is_file()));
    assert!(
        import_reference_attachments(&access, &project, &[paths[1].clone(), paths[1].clone()])
            .unwrap_err()
            .contains("one video")
    );
    assert!(reference_attachment_kind(Path::new("script.exe")).is_err());
}

#[test]
fn video_reference_clip_settings_survive_save_and_reopen() {
    let mut config = fixture();
    let reference = &mut config.references[0];
    reference.kind = "video".into();
    reference.relative_path = Some("media/reference.mp4".into());
    reference.source_path = None;
    reference.video = Some(ReferenceVideoOptions {
        start_seconds: 3.5,
        duration_seconds: 4.0,
        include_audio: false,
    });
    let config = validate_and_normalize_config(config).unwrap();
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(value["references"][0]["video"]["startSeconds"], 3.5);
    let reopened: ProjectConfig = serde_json::from_value(value).unwrap();
    assert_eq!(reopened.references[0].video, config.references[0].video);
    let mut invalid = reopened;
    invalid.references[0]
        .video
        .as_mut()
        .unwrap()
        .duration_seconds = 16.0;
    assert!(validate_and_normalize_config(invalid).is_err());
}

#[test]
fn reference_images_are_attachments_and_derived_state_is_not_serialized() {
    let mut config = fixture();
    config.references[0].images = vec![
        ReferenceImage {
            id: "tone-front".into(),
            name: "Front".into(),
            relative_path: Some("references/front.png".into()),
            source_path: None,
        },
        ReferenceImage {
            id: "tone-side".into(),
            name: "Side".into(),
            relative_path: Some("references/side.png".into()),
            source_path: None,
        },
    ];
    let config = validate_and_normalize_config(config).unwrap();
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(
        value["references"][0]["images"].as_array().unwrap().len(),
        2
    );
    assert!(value.get("agentConversation").is_none());
    assert!(value["generationJobs"][0].get("compiledPrompt").is_none());
}
