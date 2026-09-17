// S1: the perimeter this command actually has, pinned so nobody has to
// take the docstring's word for it. The actor that opens a file here is
// the PROJECT FILE, not the person — a `slopus.json` the user merely
// opened can name any media file on the disk and get its bytes. That
// follows from trusting any project file the user opens; the unbuilt
// narrowing is a per-installation approval list (see the command's
// docstring). What it IS bounded by is asserted here too.
use super::*;
#[test]
fn a_project_the_user_only_opened_reads_any_media_file_it_names() {
    let root = tempfile::tempdir().unwrap();
    let pictures = root.path().join("Pictures");
    fs::create_dir(&pictures).unwrap();
    let private_photo = pictures.join("private.jpg");
    fs::write(&private_photo, b"PRIVATE PHOTO BYTES").unwrap();
    let diary = pictures.join("diary.txt");
    fs::write(&diary, b"DIARY").unwrap();
    let unnamed = pictures.join("holiday.jpg");
    fs::write(&unnamed, b"ANOTHER PHOTO").unwrap();

    // A project file the user did not write: a template a colleague sent,
    // an unzipped folder. Nobody picked these paths in any dialog.
    let mut config = created_fixture();
    for (index, (id, file)) in [("named", &private_photo), ("crafted", &diary)]
        .into_iter()
        .enumerate()
    {
        config.assets.push(ProjectAsset {
            id: format!("asset-{id}"),
            kind: "image".into(),
            name: format!("Shared {index}"),
            relative_path: None,
            source_path: Some(external_source_path(file).unwrap()),
            mime_type: "image/jpeg".into(),
            duration_ms: None,
            width: None,
            height: None,
            has_audio: None,
            created_at: config.created_at.clone(),
        });
    }
    let shared = root.path().join("Shared project");
    fs::create_dir(&shared).unwrap();
    write_project(&shared, &config).unwrap();
    let folder = shared.to_string_lossy().into_owned();

    // The rule, stated plainly: the project names it, so it is served.
    let named = config.assets[0].source_path.clone().unwrap();
    assert_eq!(
        external_media_bytes(&folder, &named).unwrap(),
        b"PRIVATE PHOTO BYTES",
        "this is the documented perimeter, not a wish about it"
    );

    // And the two things that DO bound it. Media extensions only, checked
    // on the canonical path — a project file cannot name credentials.
    let crafted = config.assets[1].source_path.clone().unwrap();
    assert!(external_media_bytes(&folder, &crafted)
        .unwrap_err()
        .contains("not a media file"));
    // And only what the project names: not the whole folder around it.
    assert!(external_media_bytes(&folder, &unnamed.to_string_lossy())
        .unwrap_err()
        .contains("not one of the files this project points at"));
}

// S2: a file picked while project A was open is not project B's to read.
// The session list used to be process-global, so opening a colleague's
// project after importing your own rushes handed their project file a
// reader for your footage — no hand-editing required, the paths were
// already in memory.
#[test]
fn one_project_s_picks_are_not_another_project_s_to_read() {
    let root = tempfile::tempdir().unwrap();
    let rushes = root.path().join("Rushes");
    fs::create_dir(&rushes).unwrap();
    let footage = rushes.join("my footage.mp4");
    fs::write(&footage, b"A's footage").unwrap();

    let mine = project_folder_at(&root.path().join("Mine"));
    let theirs = project_folder_at(&root.path().join("Theirs"));

    // Imported into MY project, and not saved yet: only the session list
    // knows about it.
    let imported = import_media_file(&footage, &mine).unwrap();
    let source = imported.source_path.unwrap();
    assert!(recorded_external_paths(&read_project(&mine).unwrap().config).is_empty());

    assert_eq!(
        external_media_bytes(&mine.to_string_lossy(), &source).unwrap(),
        b"A's footage",
        "the project the clip was imported into must still preview it"
    );
    let error = external_media_bytes(&theirs.to_string_lossy(), &source).unwrap_err();
    assert!(
        error.contains("not one of the files this project points at"),
        "another project read a file picked for this one: {error}"
    );
}

// S3: `read_project_file` confines the relative path against the folder it
// is handed, and nothing used to check that the folder was a project. The
// pair was the hole: every check passed while pointing at `.ssh`.
#[test]
fn reading_a_project_file_requires_the_folder_to_hold_a_project() {
    let root = tempfile::tempdir().unwrap();
    let ssh = root.path().join(".ssh");
    fs::create_dir(&ssh).unwrap();
    fs::write(ssh.join("id_rsa"), b"BEGIN OPENSSH PRIVATE KEY").unwrap();

    // `tauri::ipc::Response` is not `Debug`, so the error comes out by hand.
    let read = |folder: &Path, relative: &str| {
        read_project_file(folder.to_string_lossy().into_owned(), relative.into())
            .map(|_| ())
            .err()
    };
    let error = read(&ssh, "id_rsa").expect("a folder with no project was read");
    assert!(
        error.contains("does not hold a Slopus project"),
        "unexpected error: {error}"
    );
    // Same shape for the external read, which takes the folder too.
    assert!(external_media_bytes(
        &ssh.to_string_lossy(),
        &ssh.join("id_rsa").to_string_lossy()
    )
    .unwrap_err()
    .contains("does not hold a Slopus project"));

    // A real project still reads its own files.
    let project = project_folder_at(&root.path().join("project"));
    fs::create_dir_all(project.join("references")).unwrap();
    fs::write(project.join("references/harbor.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    assert_eq!(read(&project, "references/harbor.png"), None);
    // ...and still cannot climb out of itself.
    assert!(read(&project, "../.ssh/id_rsa").is_some());
}

#[test]
fn a_project_file_only_yields_media_a_hand_edit_cannot_widen() {
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
    let error = external_media_bytes(&created.folder_path, &recorded).unwrap_err();
    assert!(
        error.contains("not a media file"),
        "unexpected error: {error}"
    );
}

#[test]
fn every_stored_location_is_one_place_and_only_one() {
    let external = external_fixture();
    let normalized = validate_and_normalize_config(external.clone()).unwrap();
    assert_eq!(
        normalized.assets[0].source_path.as_deref(),
        Some(r"D:\tmp\news\News broadcast\rush-01.mp4"),
        "an external path is stored verbatim, not rewritten as a relative one"
    );
    assert!(normalized.assets[0].relative_path.is_none());

    // Both at once is not a location, and neither is neither.
    let mut both = external_fixture();
    both.assets[0].relative_path = Some("media/rush-01.mp4".into());
    assert!(validate_and_normalize_config(both)
        .unwrap_err()
        .contains("cannot have both"));
    let mut neither = external_fixture();
    neither.assets[0].source_path = None;
    assert!(validate_and_normalize_config(neither)
        .unwrap_err()
        .contains("must have either"));

    // A Generator scene can be arranged before its render exists. It still
    // has an asset id for timeline integrity, and gains its path when the
    // generated file is saved.
    let mut waiting_scene = external_fixture();
    waiting_scene.assets[0].kind = "generated".into();
    waiting_scene.assets[0].source_path = None;
    assert!(validate_and_normalize_config(waiting_scene).is_ok());

    // A "source path" that is not absolute resolves against nothing.
    for path in [
        "Footage\\clip.mp4",
        "media/clip.mp4",
        "..\\..\\clip.mp4",
        "D:\\..\\clip.mp4",
        "",
    ] {
        let mut relative = external_fixture();
        relative.assets[0].source_path = Some(path.into());
        assert!(
            validate_and_normalize_config(relative).is_err(),
            "accepted '{path}' as an absolute source path"
        );
    }
    // Every absolute form is accepted on every platform: a project file
    // written on Windows is still read on Linux and back.
    for path in [
        "D:\\Footage\\clip.mp4",
        "D:/Footage/clip.mp4",
        "/home/nn/clip.mp4",
        "\\\\nas\\share\\clip.mp4",
    ] {
        let mut absolute = external_fixture();
        absolute.assets[0].source_path = Some(path.into());
        assert!(
            validate_and_normalize_config(absolute).is_ok(),
            "rejected the absolute path '{path}'"
        );
    }

    // References follow the same rule, and a file-backed one still needs
    // its file.
    let mut both_on_reference = external_fixture();
    both_on_reference.references[1].relative_path = Some("references/cut.mov".into());
    assert!(validate_and_normalize_config(both_on_reference).is_err());
    let mut nowhere = external_fixture();
    nowhere.references[1].source_path = None;
    assert!(validate_and_normalize_config(nowhere).is_err());
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
fn sanitizes_folder_names() {
    assert_eq!(safe_folder_name("  Launch: Film?  "), "Launch- Film-");
    assert_eq!(safe_folder_name("..."), "Untitled video");
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
    let config = validate_and_normalize_config(serde_json::from_value(value.clone()).unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = Path::new(&created.folder_path);
    write_project(folder, &created.config).unwrap();
    assert_eq!(read_project(folder).unwrap().config.references[0].refmods, config.references[0].refmods);
    for (key, invalid) in [
        ("strength", serde_json::json!(-0.1)), ("strength", serde_json::json!(1.1)),
        ("copies", serde_json::json!(0)), ("copies", serde_json::json!(11)),
        ("sourcePath", serde_json::json!("../outside.safetensors")),
        ("sourcePath", serde_json::Value::Null),
    ] {
        let mut broken = value.clone();
        broken["references"][0]["refmods"][0][key] = invalid;
        assert!(serde_json::from_value(broken).map_err(|error| error.to_string()).and_then(validate_and_normalize_config).is_err());
    }
}

#[test]
fn unified_reference_import_copies_images_and_keeps_video_and_refmod_sources() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let paths = [root.path().join("photo.png"), root.path().join("motion.mp4"), root.path().join("person.safetensors")];
    for path in &paths { fs::write(path, b"source").unwrap(); }
    let imported = import_reference_attachments(&project, &paths).unwrap();
    assert_eq!(imported.iter().map(|file| file.kind).collect::<Vec<_>>(), ["image", "video", "refmod"]);
    assert!(project.join(imported[0].relative_path.as_ref().unwrap()).is_file());
    assert!(imported[2].relative_path.is_none());
    assert_eq!(imported[2].source_path.as_deref(), Some(external_source_path(&paths[2]).unwrap().as_str()));
    assert!(paths.iter().all(|path| path.is_file()));
    assert!(import_reference_attachments(&project, &[paths[1].clone(), paths[1].clone()]).unwrap_err().contains("one video"));
    assert!(reference_attachment_kind(Path::new("script.exe")).is_err());
}

#[test]
fn video_reference_clip_settings_survive_save_and_reopen() {
    let mut config = fixture();
    let reference = &mut config.references[0];
    reference.kind = "video".into();
    reference.relative_path = Some("media/reference.mp4".into());
    reference.source_path = None;
    reference.video = Some(ReferenceVideoOptions { start_seconds: 3.5, duration_seconds: 4.0, include_audio: false });
    let config = validate_and_normalize_config(config).unwrap();
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(value["references"][0]["video"]["startSeconds"], 3.5);
    let reopened: ProjectConfig = serde_json::from_value(value).unwrap();
    assert_eq!(reopened.references[0].video, config.references[0].video);
    let mut invalid = reopened;
    invalid.references[0].video.as_mut().unwrap().duration_seconds = 16.0;
    assert!(validate_and_normalize_config(invalid).is_err());
}

#[test]
fn scene_frame_settings_survive_save_and_reopen_and_validate_images() {
    let mut config = fixture();
    let image_id = config
        .references
        .iter()
        .find(|reference| reference.kind == "image")
        .unwrap()
        .id
        .clone();
    config.generation_jobs[0].end_frame_reference_id = Some(image_id.clone());
    config.generation_jobs[0].use_previous_scene_last_frame = Some(true);
    let folder = tempfile::tempdir().unwrap();
    write_project(folder.path(), &config).unwrap();
    let restored = read_project(folder.path()).unwrap().config;
    assert_eq!(
        restored.generation_jobs[0]
            .end_frame_reference_id
            .as_deref(),
        Some(image_id.as_str())
    );
    assert_eq!(
        restored.generation_jobs[0].use_previous_scene_last_frame,
        Some(true)
    );
    config.generation_jobs[0].end_frame_reference_id = Some("missing".into());
    assert!(validate_and_normalize_config(config.clone())
        .unwrap_err()
        .contains("unknown end-frame"));
    config.generation_jobs[0].end_frame_reference_id = Some(
        config
            .references
            .iter()
            .find(|reference| reference.kind == "text")
            .unwrap()
            .id
            .clone(),
    );
    assert!(validate_and_normalize_config(config)
        .unwrap_err()
        .contains("is not an image"));
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

#[test]
fn blank_brief_is_a_valid_empty_project() {
    let mut config = fixture();
    config.brief.prompt.clear();
    config.generation_jobs.clear();
    assert!(validate_and_normalize_config(config).is_ok());
}

#[test]
fn validator_rejects_what_the_frontend_schema_rejects() {
    // Configs arriving from the agent subprocess are written to disk before
    // the frontend ever parses them, so anything zod refuses has to be
    // refused here too or a project lands on disk that cannot be reopened.
    fn rejects(case: &str, break_config: impl FnOnce(&mut ProjectConfig)) {
        let mut config = fixture();
        break_config(&mut config);
        assert!(
            validate_and_normalize_config(config).is_err(),
            "accepted a config the frontend schema rejects: {case}"
        );
    }

    rejects("name longer than 120 characters", |config| {
        config.name = "n".repeat(200);
    });
    rejects("unsupported settings aspect ratio", |config| {
        config.settings.aspect_ratio = "21:9".into();
    });
    rejects("unsupported settings resolution", |config| {
        config.settings.resolution = "8k".into();
    });
    rejects("unsupported frame rate", |config| {
        config.settings.frame_rate = 48;
    });
    rejects("named background color", |config| {
        config.settings.background_color = "black".into();
    });
    rejects("shorthand background color", |config| {
        config.settings.background_color = "#fff".into();
    });
    rejects("non-hex digit in background color", |config| {
        config.settings.background_color = "#10131g".into();
    });
    rejects("unsupported brief status", |config| {
        config.brief.status = "done".into();
    });
    rejects("target duration above 600 seconds", |config| {
        config.brief.target_duration_seconds = 900;
    });
    rejects("unsupported brief aspect ratio", |config| {
        config.brief.aspect_ratio = "21:9".into();
    });
    rejects("unsupported brief resolution", |config| {
        config.brief.resolution = "8k".into();
    });
    rejects("unsupported asset kind", |config| {
        config.assets[0].kind = "clip".into();
    });
    rejects("empty asset mime type", |config| {
        config.assets[0].mime_type = String::new();
    });
    rejects("zero asset width", |config| {
        config.assets[0].width = Some(0);
    });
    rejects("zero asset height", |config| {
        config.assets[0].height = Some(0);
    });
    rejects("unsupported track kind", |config| {
        config.timeline.tracks[0].kind = "text".into();
    });
    rejects("empty track name", |config| {
        config.timeline.tracks[0].name = String::new();
    });
    rejects("empty clip label", |config| {
        config.timeline.tracks[0].clips[0].label = String::new();
    });
    rejects("zero clip duration", |config| {
        config.timeline.tracks[0].clips[0].duration_ms = 0;
    });
    rejects("unsupported clip status", |config| {
        config.timeline.tracks[0].clips[0].status = "final".into();
    });
    rejects("empty reference content", |config| {
        config.references[0].content = Some(String::new());
    });
    rejects("unsupported reference intended use", |config| {
        config.references[0].intended_use = vec!["mood".into()];
    });
    rejects("empty generation job provider id", |config| {
        config.generation_jobs[0].provider_id = Some(String::new());
    });
    rejects("empty generation job error", |config| {
        config.generation_jobs[0].error = Some(String::new());
    });
    rejects("shot tag group id the frontend regex refuses", |config| {
        config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
            "Camera Movement".into(),
            vec!["push-in".into()],
        )]));
    });
    rejects("shot tag id the frontend regex refuses", |config| {
        config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
            "cameraMovement".into(),
            vec!["Push In".into()],
        )]));
    });
    rejects("empty shot tag id", |config| {
        config.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
            "cameraMovement".into(),
            vec![String::new()],
        )]));
    });
}

