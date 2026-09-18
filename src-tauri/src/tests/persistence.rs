use super::*;

#[test]
fn legacy_project_defaults_to_video_and_persists_its_type() {
    let root = tempfile::tempdir().unwrap();
    let legacy = include_str!("../../../fixtures/project-v1-created.json");
    assert!(serde_json::from_str::<serde_json::Value>(legacy)
        .unwrap()
        .get("generationType")
        .is_none());
    fs::write(root.path().join(PROJECT_FILE_NAME), legacy).unwrap();
    let opened = read_project(root.path()).unwrap();
    assert_eq!(opened.config.generation_type, GenerationType::Video);
    write_project(root.path(), &opened.config).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join(PROJECT_FILE_NAME)).unwrap()).unwrap();
    assert_eq!(saved["generationType"], "video");
}

#[test]
fn generation_types_survive_create_save_and_reopen() {
    for generation_type in ["video", "image", "3d", "music", "speech"] {
        let root = tempfile::tempdir().unwrap();
        let mut value = serde_json::to_value(created_fixture()).unwrap();
        value["generationType"] = serde_json::json!(generation_type);
        let config: ProjectConfig = serde_json::from_value(value).unwrap();
        let created = create_project_in(root.path(), &config).unwrap();
        let folder = Path::new(&created.folder_path);
        let opened = read_project(folder).unwrap();
        write_project(folder, &opened.config).unwrap();
        let reopened = read_project(folder).unwrap();
        assert_eq!(reopened.config.generation_type, config.generation_type);
        assert_eq!(
            serde_json::to_value(reopened.config).unwrap()["generationType"],
            generation_type
        );
    }
}

#[test]
fn invalid_explicit_generation_types_are_rejected() {
    for generation_type in [
        serde_json::Value::Null,
        serde_json::json!(""),
        serde_json::json!("unknown"),
        serde_json::json!("Video"),
        serde_json::json!(3),
    ] {
        let mut value = serde_json::to_value(created_fixture()).unwrap();
        value["generationType"] = generation_type;
        assert!(serde_json::from_value::<ProjectConfig>(value).is_err());
    }
}

#[test]
fn complete_project_create_open_save_reopen_is_lossless() {
    let root = tempfile::tempdir().unwrap();
    let expected = without_derived_project_state(validate_and_normalize_config(fixture()).unwrap());
    let created = create_project_in(root.path(), &expected).unwrap();
    assert_eq!(created.config, expected);

    let project_folder = PathBuf::from(&created.folder_path);
    let opened = read_project(&project_folder).unwrap();
    assert_eq!(opened.config, expected);

    let mut saved = opened.config.clone();
    saved.updated_at = "2026-02-03T04:05:06.000Z".into();
    write_project(&project_folder, &saved).unwrap();
    assert_eq!(read_project(&project_folder).unwrap().config, saved);

    let mut directories = Vec::new();
    fn collect_directories(root: &Path, current: &Path, output: &mut Vec<String>) {
        for entry in fs::read_dir(current).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                output.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
                collect_directories(root, &path, output);
            }
        }
    }
    collect_directories(&project_folder, &project_folder, &mut directories);
    directories.sort();
    assert_eq!(
        directories,
        [
            "cache",
            "exports",
            "media",
            "media/generated",
            "media/imported",
            "references",
            "thumbnails",
        ]
    );
    let files: Vec<_> = fs::read_dir(&project_folder)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files, [PROJECT_FILE_NAME]);
}

#[test]
fn chroma_key_survives_save_and_reopen_and_validates_settings() {
    let mut config = fixture();
    config.timeline.tracks[0].clips[0].chroma_key = Some(ClipChromaKey {
        color: "#12ABef".into(),
        tolerance: 27.0,
    });
    let config = without_derived_project_state(validate_and_normalize_config(config).unwrap());
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    write_project(&folder, &config).unwrap();
    assert_eq!(read_project(&folder).unwrap().config, config);
    let json = serde_json::to_value(&config).unwrap();
    assert_eq!(
        json["timeline"]["tracks"][0]["clips"][0]["chromaKey"]["color"],
        "#12ABef"
    );
    for (color, tolerance) in [
        ("green", 20.0),
        ("#12345g", 20.0),
        ("#00ff00", -1.0),
        ("#00ff00", 101.0),
        ("#00ff00", f64::NAN),
    ] {
        let mut invalid = config.clone();
        invalid.timeline.tracks[0].clips[0].chroma_key = Some(ClipChromaKey {
            color: color.into(),
            tolerance,
        });
        assert!(validate_and_normalize_config(invalid)
            .unwrap_err()
            .contains("chroma key"));
    }
    let mut removed = config.clone();
    removed.timeline.tracks[0].clips[0].chroma_key = None;
    write_project(&folder, &removed).unwrap();
    assert!(
        read_project(&folder).unwrap().config.timeline.tracks[0].clips[0]
            .chroma_key
            .is_none()
    );
}

#[test]
fn deleting_a_project_removes_its_folder_and_every_file_inside_it() {
    let parent = tempfile::tempdir().unwrap();
    let project = project_folder_at(&parent.path().join("Disposable project"));
    fs::create_dir_all(project.join("media/generated")).unwrap();
    fs::write(project.join("media/generated/scene.mp4"), b"video").unwrap();
    let id = read_project(&project).unwrap().config.id;

    delete_project_folder(&project.to_string_lossy(), &id).unwrap();

    assert!(!project.exists());
    assert!(parent.path().is_dir());
}

#[test]
fn video_effects_survive_save_and_reopen() {
    let mut json = serde_json::to_value(fixture()).unwrap();
    let clip = &mut json["timeline"]["tracks"][0]["clips"][0];
    clip["sharpen"] = serde_json::json!({"amount": 60});
    clip["blur"] = serde_json::json!({"radius": 4});
    clip["colorCorrection"] = serde_json::json!({"exposure": 1, "contrast": 20, "saturation": 80});
    clip["vignette"] = serde_json::json!({"amount": 30});
    clip["lut"] = serde_json::json!({"intensity": 70, "table": {
        "name": "Identity", "size": 2, "domainMin": [0, 0, 0], "domainMax": [1, 1, 1],
        "values": [0,0,0, 1,0,0, 0,1,0, 1,1,0, 0,0,1, 1,0,1, 0,1,1, 1,1,1]
    }});
    let config = without_derived_project_state(
        validate_and_normalize_config(serde_json::from_value(json).unwrap()).unwrap(),
    );
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    write_project(&folder, &config).unwrap();
    assert_eq!(read_project(&folder).unwrap().config, config);
    let mut invalid = config.clone();
    invalid.timeline.tracks[0].clips[0]
        .lut
        .as_mut()
        .unwrap()
        .table
        .as_mut()
        .unwrap()
        .values
        .pop();
    assert!(validate_and_normalize_config(invalid)
        .unwrap_err()
        .contains("LUT table"));
    let mut invalid = config.clone();
    invalid.timeline.tracks[0].clips[0]
        .blur
        .as_mut()
        .unwrap()
        .radius = 25.0;
    assert!(validate_and_normalize_config(invalid)
        .unwrap_err()
        .contains("video effects"));
}

#[test]
fn deletion_refuses_a_different_project_identity_and_keeps_the_folder() {
    let parent = tempfile::tempdir().unwrap();
    let project = project_folder_at(&parent.path().join("Keep this project"));

    let error =
        delete_project_folder(&project.to_string_lossy(), "some-other-project").unwrap_err();

    assert!(error.contains("not the project selected for deletion"));
    assert!(project.is_dir());
    assert!(project.join(PROJECT_FILE_NAME).is_file());
}

#[test]
fn old_v1_documents_receive_empty_persistence_containers() {
    let mut value = serde_json::to_value(fixture()).unwrap();
    let object = value.as_object_mut().unwrap();
    object.remove("references");
    object.remove("generationJobs");
    object.remove("agentConversation");
    object.remove("providerSettings");
    let config: ProjectConfig = serde_json::from_value(value).unwrap();
    assert!(config.references.is_empty());
    assert!(config.generation_jobs.is_empty());
    assert!(config.agent_conversation.messages.is_empty());
    assert!(config.provider_settings.is_empty());
}

#[test]
fn replacement_failure_preserves_original_project_json() {
    let root = tempfile::tempdir().unwrap();
    let original = fixture();
    write_project(root.path(), &original).unwrap();
    let destination = root.path().join(PROJECT_FILE_NAME);
    let original_bytes = fs::read(&destination).unwrap();

    let mut changed = original.clone();
    changed.name = "This must not replace the original".into();
    let error = write_project_with_replacer(root.path(), &changed, |_, _| {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "simulated replacement failure",
        ))
    })
    .unwrap_err();

    assert!(error.contains("simulated replacement failure"));
    assert_eq!(fs::read(&destination).unwrap(), original_bytes);
    assert_eq!(
        read_project(root.path()).unwrap().config,
        without_derived_project_state(validate_and_normalize_config(original).unwrap())
    );
    assert_eq!(
        fs::read_dir(root.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_file())
            .count(),
        1
    );
}

#[test]
fn new_project_uses_the_selected_empty_folder_itself() {
    let selected = tempfile::tempdir().unwrap();
    let expected_root = selected.path().canonicalize().unwrap();

    let created = create_project_at_with_references(selected.path(), &fixture(), &[]).unwrap();

    assert_eq!(
        PathBuf::from(created.folder_path).canonicalize().unwrap(),
        expected_root
    );
    assert!(selected.path().join(PROJECT_FILE_NAME).is_file());
    assert!(!selected
        .path()
        .join(safe_folder_name(&created.config.name))
        .exists());
}

#[test]
fn new_project_rejects_a_nonempty_selected_folder_without_changing_it() {
    let selected = tempfile::tempdir().unwrap();
    let existing = selected.path().join("keep.txt");
    fs::write(&existing, b"user data").unwrap();

    let error = create_project_at_with_references(selected.path(), &fixture(), &[]).unwrap_err();

    assert!(error.contains("not empty"), "unexpected error: {error}");
    assert_eq!(fs::read(&existing).unwrap(), b"user data");
    assert!(!selected.path().join(PROJECT_FILE_NAME).exists());
}

#[test]
fn project_mutation_rejects_broken_relational_ids() {
    let mut config = fixture();
    config.generation_jobs[0]
        .reference_ids
        .push("missing-reference".into());
    assert!(validate_and_normalize_config(config)
        .unwrap_err()
        .contains("unknown reference"));
}

#[test]
fn a_project_file_only_yields_media_a_hand_edit_cannot_widen() {
    let access = MediaAccess::default();
    // Belt and braces for the direction the allow-list alone cannot cover:
    // a HAND-EDITED project file naming something that is not media. The
    // path is recorded, so the allow-list passes — the extension check is
    // what refuses it.
    let root = tempfile::tempdir().unwrap();
    let secret = root.path().join("id_rsa");
    fs::write(&secret, b"private key").unwrap();

    let mut config = created_fixture();
    config.assets.push(ProjectAsset {
        id: "asset-crafted".into(),
        kind: "video".into(),
        name: "Not a clip".into(),
        relative_path: None,
        source_path: Some(external_source_path(&secret).unwrap()),
        mime_type: "video/mp4".into(),
        duration_ms: None,
        width: None,
        height: None,
        has_audio: None,
        created_at: config.created_at.clone(),
    });
    let created = create_project_in(root.path(), &config).unwrap();
    let recorded = created.config.assets[0].source_path.clone().unwrap();
    let error = external_media_bytes(&access, &created.folder_path, &recorded).unwrap_err();
    assert!(
        error.contains("not a media file"),
        "unexpected error: {error}"
    );
}

#[test]
fn the_settings_file_is_slopus_json_and_the_older_names_still_open() {
    assert_eq!(PROJECT_FILE_NAME, "slopus.json");
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &fixture()).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    assert!(folder.join("slopus.json").is_file());

    // Every older name still opens, one folder per name, because a project
    // written by an earlier build must not become unopenable.
    for legacy in LEGACY_PROJECT_FILE_NAMES {
        let old = root.path().join(format!("old-{legacy}"));
        fs::create_dir(&old).unwrap();
        fs::copy(folder.join(PROJECT_FILE_NAME), old.join(legacy)).unwrap();
        assert_eq!(
            read_project(&old).unwrap().config,
            created.config,
            "a project stored as {legacy} failed to open"
        );
        // Saving migrates the name and leaves the old file where it is, so
        // the build that wrote it can still read the project.
        write_project(&old, &created.config).unwrap();
        assert!(old.join(PROJECT_FILE_NAME).is_file());
        assert!(old.join(legacy).is_file());
        // The new name wins once both exist.
        assert_eq!(project_file_in(&old), old.join(PROJECT_FILE_NAME));
    }
}

#[test]
fn blank_brief_is_a_valid_empty_project() {
    let mut config = fixture();
    config.brief.prompt.clear();
    config.generation_jobs.clear();
    assert!(validate_and_normalize_config(config).is_ok());
}
