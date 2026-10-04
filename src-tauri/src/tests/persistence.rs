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
fn effect_bypass_round_trips_and_stays_absent_when_unset() {
    let mut config = fixture();
    let clip = &mut config.timeline.tracks[0].clips[0];
    clip.chroma_key = Some(ClipChromaKey {
        color: "#00ff00".into(),
        tolerance: 20.0,
        enabled: Some(false),
    });
    clip.look = Some(ClipLook {
        opacity: 80.0,
        enabled: None,
    });
    let config = without_derived_project_state(validate_and_normalize_config(config).unwrap());
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    write_project(&folder, &config).unwrap();
    assert_eq!(read_project(&folder).unwrap().config, config);
    let json = serde_json::to_value(&config).unwrap();
    let clip = &json["timeline"]["tracks"][0]["clips"][0];
    assert_eq!(clip["chromaKey"]["enabled"], false);
    // Unset stays unset: a project written before bypass keeps its shape.
    assert!(clip["look"].as_object().unwrap().get("enabled").is_none());
    // A file that carries the flag (written by the frontend) loads with it.
    let parsed: ClipLook = serde_json::from_str(r#"{"opacity":50,"temperature":10,"enabled":false}"#).unwrap();
    assert_eq!(parsed.enabled, Some(false));
    let legacy: ClipLook = serde_json::from_str(r#"{"opacity":50,"temperature":10}"#).unwrap();
    assert_eq!(legacy.enabled, None);
    assert_eq!(serde_json::to_value(&legacy).unwrap(), serde_json::json!({"opacity":50.0}));
}

#[test]
fn chroma_key_survives_save_and_reopen_and_validates_settings() {
    let mut config = fixture();
    config.timeline.tracks[0].clips[0].chroma_key = Some(ClipChromaKey {
        color: "#12ABef".into(),
        tolerance: 27.0,
        enabled: None,
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
            enabled: None,
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
    clip["colorCorrection"] = serde_json::json!({"exposure": 1, "brightness": -25, "contrast": 20, "saturation": 80});
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
    assert_eq!(config.timeline.tracks[0].clips[0].color_correction.as_ref().unwrap().brightness, Some(-25.0));
    for brightness in [-101.0, 101.0, f64::NAN, f64::INFINITY] {
        let mut invalid = config.clone();
        invalid.timeline.tracks[0].clips[0].color_correction.as_mut().unwrap().brightness = Some(brightness);
        assert!(validate_and_normalize_config(invalid).unwrap_err().contains("video effects"));
    }
    let mut legacy = serde_json::to_value(&config).unwrap();
    legacy["timeline"]["tracks"][0]["clips"][0]["colorCorrection"].as_object_mut().unwrap().remove("brightness");
    let legacy = validate_and_normalize_config(serde_json::from_value(legacy).unwrap()).unwrap();
    assert_eq!(legacy.timeline.tracks[0].clips[0].color_correction.as_ref().unwrap().brightness, None);
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
fn project_look_and_extended_duration_survive_save_and_reopen() {
    let mut config = fixture();
    config.settings.default_look = Some("watercolor".into());
    config.brief.target_duration_seconds = 1800;
    let config = without_derived_project_state(validate_and_normalize_config(config).unwrap());
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    assert_eq!(read_project(&folder).unwrap().config, config);
    let mut cleared = config;
    cleared.settings.default_look = None;
    write_project(&folder, &cleared).unwrap();
    assert_eq!(read_project(&folder).unwrap().config, cleared);
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
    assert!(validate_empty_project_folder(selected.path()).is_ok());
    assert_eq!(fs::read_dir(selected.path()).unwrap().count(), 0);

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
    assert!(validate_empty_project_folder(selected.path()).unwrap_err().contains("not empty"));

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
        image_generation: None, scene_segments: None,
        image_draft: None,
        parent_asset_id: None,
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

#[test]
fn color_grading_round_trips_and_validates() {
    let mut json = serde_json::to_value(fixture()).unwrap();
    let clip = &mut json["timeline"]["tracks"][0]["clips"][0];
    clip["colorCorrection"] = serde_json::json!({"exposure":1.0,"contrast":20.0,"saturation":80.0,"temperature":25.0,"tint":-15.0,"highlights":-20.0,"shadows":30.0,"whites":10.0,"blacks":-10.0});
    clip["creative"] = serde_json::json!({"look":"Warm Film","intensity":65.0,"fadedFilm":10.0,"sharpen":35.0,"vibrance":-15.0,"enabled":false});
    clip["curves"] = serde_json::json!({"rgb":[[0.0,0.0],[0.5,0.7],[1.0,1.0]],"red":[[0.0,0.1],[1.0,0.9]],"green":[[0.0,0.0],[1.0,1.0]],"blue":[[0.0,0.0],[1.0,1.0]],"hueVsSat":[[0.0,0.5],[0.2,0.8],[1.0,0.5]],"hueVsHue":[[0.0,0.5],[1.0,0.5]],"hueVsLuma":[[0.0,0.5],[1.0,0.5]],"lumaVsSat":[[0.0,0.2],[1.0,0.8]],"satVsSat":[[0.0,0.5],[1.0,0.5]]});
    clip["colorWheels"] = serde_json::json!({"shadows":{"x":0.3,"y":-0.4,"lightness":10.0},"midtones":{"x":0.0,"y":0.0,"lightness":-20.0},"highlights":{"x":0.2,"y":0.1,"lightness":30.0}});
    clip["vignette"] = serde_json::json!({"amount":-30.0,"midpoint":20.0,"roundness":-15.0,"feather":65.0});
    let config = without_derived_project_state(validate_and_normalize_config(serde_json::from_value(json.clone()).unwrap()).unwrap());
    // Compare serialized effects too: equality of two Rust structs alone would miss dropped fields.
    let serialized = serde_json::to_value(&config).unwrap();
    for effect in ["colorCorrection", "creative", "curves", "colorWheels", "vignette"] {
        assert_eq!(serialized["timeline"]["tracks"][0]["clips"][0][effect], json["timeline"]["tracks"][0]["clips"][0][effect]);
    }
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = PathBuf::from(&created.folder_path);
    write_project(&folder, &config).unwrap();
    assert_eq!(read_project(&folder).unwrap().config, config);
    for (effect, field, value) in [
        ("colorCorrection", "temperature", serde_json::json!(101)),
        ("colorCorrection", "shadows", serde_json::json!(-101)),
        ("creative", "look", serde_json::json!("unknown")),
        ("creative", "vibrance", serde_json::json!(101)),
        ("vignette", "feather", serde_json::json!(-1)),
        ("curves", "rgb", serde_json::json!([])),
        ("curves", "rgb", serde_json::json!([[0,0],[0,1]])),
        ("curves", "hueVsHue", serde_json::json!([[0,0.1],[1,0.9]])),
        ("colorWheels", "shadows", serde_json::json!({"x":1,"y":1,"lightness":0})),
    ] {
        let mut invalid = json.clone();
        invalid["timeline"]["tracks"][0]["clips"][0][effect][field] = value;
        assert!(validate_and_normalize_config(serde_json::from_value(invalid).unwrap()).is_err(), "{effect}.{field}");
    }
}
