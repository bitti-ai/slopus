use super::*;
#[test]
fn stored_paths_are_normalized_and_escaping_paths_are_rejected() {
    let mut normalized = fixture();
    normalized.assets[0].relative_path = Some(".\\media\\imported//macro.mp4".into());
    assert_eq!(
        validate_and_normalize_config(normalized).unwrap().assets[0]
            .relative_path
            .as_deref(),
        Some("media/imported/macro.mp4")
    );

    for path in [
        "/etc/passwd",
        "\\Windows\\system.ini",
        "C:\\Users\\creator\\clip.mp4",
        "https://example.com/clip.mp4",
        "media/../../outside.mp4",
        "references/../outside.png",
    ] {
        let mut escaping = fixture();
        escaping.assets[0].relative_path = Some(path.into());
        assert!(
            validate_and_normalize_config(escaping).is_err(),
            "accepted escaping path {path}"
        );
    }

    let mut thumbnail = fixture();
    thumbnail.thumbnail = Some("../thumbnail.webp".into());
    let mut reference = fixture();
    reference.references[1].relative_path = Some("../product.png".into());
    let mut job = fixture();
    job.generation_jobs[0].output_relative_path = Some("C:\\output.mp4".into());
    for config in [thumbnail, reference, job] {
        assert!(validate_and_normalize_config(config).is_err());
    }
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

    let error =
        create_project_at_with_references(selected.path(), &fixture(), &[]).unwrap_err();

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
        .encode(&vec![128; 256 * 256 * 3], 256, 256, jpeg_encoder::ColorType::Rgb)
        .unwrap();
    assert_eq!(jpeg, expected);
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    assert_eq!(&jpeg[jpeg.len() - 2..], &[0xff, 0xd9]);
    let frame = jpeg.windows(2).position(|bytes| bytes == [0xff, 0xc0]).unwrap();
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
        assert_eq!(reference.icon_relative_path.as_deref(), Some("references/icons/example.jpg"));
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
fn the_windows_verbatim_prefix_never_reaches_the_user() {
    // `\\?\D:\tmp\news\News broadcast` is what canonicalize hands back and
    // what the library rendered under every project. The prefix is an
    // OS-level escape hatch; the user's path is the rest of it.
    assert_eq!(
        display_path(Path::new(r"\\?\D:\tmp\news\News broadcast")),
        r"D:\tmp\news\News broadcast"
    );
    // A verbatim UNC path names a share. Stripping only `\\?\` would leave
    // `UNC\studio-nas\shared`, which points at nothing.
    assert_eq!(
        display_path(Path::new(r"\\?\UNC\studio-nas\shared\Footage")),
        r"\\studio-nas\shared\Footage"
    );
    // Everything else is already what it should be, prefix-shaped or not.
    for path in [
        r"D:\tmp\news",
        "/home/nn/projects/news",
        r"\\studio-nas\shared",
        "relative/is/left/alone",
        r"D:\?\odd\but\real",
    ] {
        assert_eq!(display_path(Path::new(path)), path);
    }
    // And the stripped form is what every command re-canonicalises, so a
    // real project folder still opens by the name the user was shown.
    let root = tempfile::tempdir().unwrap();
    let created = create_project_in(root.path(), &fixture()).unwrap();
    assert!(
        !created.folder_path.starts_with(r"\\?\"),
        "a verbatim path reached the frontend: {}",
        created.folder_path
    );
    assert!(read_project(Path::new(&created.folder_path)).is_ok());
}

#[test]
fn video_and_audio_are_recorded_where_they_are_and_images_are_copied() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    let outside = root.path().join("Rushes");
    fs::create_dir(&outside).unwrap();

    for (name, bytes) in [
        ("news broadcast.mp4", &b"video"[..]),
        ("room tone.wav", &b"audio"[..]),
        ("title card.png", &b"\x89PNG\r\n\x1a\n"[..]),
    ] {
        fs::write(outside.join(name), bytes).unwrap();
    }

    // A rush is not duplicated to make a folder "portable": the project
    // records where it already is.
    for name in ["news broadcast.mp4", "room tone.wav"] {
        let imported = import_media_file(&outside.join(name), &project).unwrap();
        assert_eq!(imported.relative_path, None, "{name} was copied");
        let source = imported.source_path.expect("external media needs a path");
        assert!(
            !source.starts_with(r"\\?\"),
            "a verbatim path was stored: {source}"
        );
        assert_eq!(
            normalize_external_path(&source).unwrap(),
            source,
            "{name} stored a path the schema would reject"
        );
        assert!(Path::new(&source).is_file());
    }
    // A picture is small, and a project's own artwork should travel with it.
    let image = import_media_file(&outside.join("title card.png"), &project).unwrap();
    assert_eq!(image.relative_path.as_deref(), Some("media/title card.png"));
    assert_eq!(image.source_path, None);
    assert!(project.join("media/title card.png").is_file());

    // Nothing but the image ever landed inside the project folder.
    let copied: Vec<_> = fs::read_dir(project.join("media"))
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(copied, ["title card.png"]);
}

#[test]
fn a_video_reference_is_pointed_at_while_an_image_reference_is_copied() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    let video = root.path().join("reference cut.mov");
    fs::write(&video, b"video").unwrap();
    let image = root.path().join("harbor facade.png");
    fs::write(&image, b"\x89PNG\r\n\x1a\n").unwrap();

    let referenced = import_reference_file(&video, &project).unwrap();
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

    let copied = import_reference_file(&image, &project).unwrap();
    assert_eq!(copied.kind, "image");
    assert_eq!(
        copied.relative_path.as_deref(),
        Some("references/harbor facade.png")
    );
    assert_eq!(copied.source_path, None);
    assert!(project.join("references/harbor facade.png").is_file());
}

#[test]
fn external_media_is_readable_only_because_the_project_names_it() {
    let root = tempfile::tempdir().unwrap();
    let outside = root.path().join("Rushes");
    fs::create_dir(&outside).unwrap();
    let clip = outside.join("rush-01.mp4");
    fs::write(&clip, b"rush bytes").unwrap();
    let secret = outside.join("id_rsa");
    fs::write(&secret, b"private key").unwrap();
    let unlisted = outside.join("rush-02.mp4");
    fs::write(&unlisted, b"another rush").unwrap();

    let mut config = created_fixture();
    config.assets.push(ProjectAsset {
        id: "asset-external".into(),
        kind: "video".into(),
        name: "Rush 01".into(),
        relative_path: None,
        source_path: Some(external_source_path(&clip).unwrap()),
        mime_type: "video/mp4".into(),
        duration_ms: None,
        width: None,
        height: None,
        has_audio: None,
        created_at: config.created_at.clone(),
    });
    let created = create_project_in(root.path(), &config).unwrap();
    let folder = created.folder_path.as_str();
    let recorded = created.config.assets[0].source_path.clone().unwrap();

    // The file the user picked, which the project now names.
    assert_eq!(
        external_media_bytes(folder, &recorded).unwrap(),
        b"rush bytes"
    );

    // A media file next to it that the project does NOT name.
    let error = external_media_bytes(folder, &unlisted.to_string_lossy()).unwrap_err();
    assert!(error.contains("not one of the files this project points at"));

    // And the shape this command must never take: reading anything the
    // caller asks for. A path the project does not carry is refused
    // whatever it points at.
    assert!(external_media_bytes(folder, &secret.to_string_lossy()).is_err());
    assert!(external_media_bytes(folder, "/etc/passwd").is_err());
}

#[test]
fn a_clip_imported_a_moment_ago_previews_before_the_project_is_saved() {
    // Saving is a deliberate act, so the project file on disk does not
    // mention a clip the user just imported. Refusing to read it until they
    // press Save would mean every fresh import shows a broken preview.
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    write_project(&project, &created_fixture()).unwrap();
    let clip = root.path().join("just picked.mp4");
    fs::write(&clip, b"fresh rush").unwrap();

    let imported = import_media_file(&clip, &project).unwrap();
    let source = imported.source_path.unwrap();
    assert!(
        recorded_external_paths(&read_project(&project).unwrap().config).is_empty(),
        "the saved project must not know about the import yet"
    );
    assert_eq!(
        external_media_bytes(&project.to_string_lossy(), &source).unwrap(),
        b"fresh rush"
    );

    // The gap it closes is exactly one file wide: a sibling nobody picked
    // is still refused.
    let sibling = root.path().join("never picked.mp4");
    fs::write(&sibling, b"other rush").unwrap();
    assert!(
        external_media_bytes(&project.to_string_lossy(), &sibling.to_string_lossy()).is_err()
    );
}

// S5: the window shipped with `"csp": null`, which is not a policy — it is
// the absence of one, and it is what made every other fence here matter so
// much. The policy has to stay narrow in the direction that costs an
// attacker something (no inline or eval'd script, nothing off-origin) and
// stay open in the two directions media previews genuinely need: `blob:`
// URLs for imported footage and `data:` URIs for thumbnails.
#[test]
fn the_window_ships_a_policy_that_previews_still_work_under() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("the webview must ship a Content-Security-Policy");
    let directive = |name: &str| {
        csp.split(';')
            .map(str::trim)
            .find(|part| part.split_whitespace().next() == Some(name) || part.trim() == name)
            .unwrap_or_else(|| panic!("the policy says nothing about {name}: {csp}"))
            .to_string()
    };

    // Scripts: same origin only, and nothing the page can talk itself into.
    let script = directive("script-src");
    assert!(script.contains("'self'"), "{script}");
    for hole in ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:"] {
        assert!(
            !script.split_whitespace().any(|source| source == hole),
            "script-src allows {hole}: {script}"
        );
    }
    assert!(directive("default-src").contains("'self'"));
    assert!(directive("object-src").contains("'none'"));

    // Previews: a blob URL is how every imported clip and image reaches an
    // <img> or a <video>, and a data URI is how thumbnails do. A policy
    // that forbids these does not secure the app, it breaks it.
    for name in ["img-src", "media-src"] {
        let sources = directive(name);
        assert!(
            sources.contains("blob:"),
            "{name} blocks previews: {sources}"
        );
        assert!(
            sources.contains("data:"),
            "{name} blocks thumbnails: {sources}"
        );
    }
    // invoke() reaches Rust over the ipc protocol.
    assert!(directive("connect-src").contains("ipc:"));
}

// The window must NOT take the OS drag-and-drop handler.
//
// Tauri defaults `dragDropEnabled` to true, which on Windows makes wry
// call `RegisterDragDrop` on the window and own the OLE drop target. That
// is the same channel WebView2 needs for HTML5 drag-and-drop *inside* the
// page, so with it on, a drag started in the media panel fires `dragstart`
// and then `dragend` immediately — no `dragover`, no `drop`, no clip. The
// user reported exactly that and the jsdom tests could not see it, because
// jsdom has no OS drag loop and a browser has no Tauri window.
//
// Turning it off costs nothing the app uses: files come in through the
// Import button's native dialog, not by dropping them on the window.
#[test]
fn the_window_leaves_drag_and_drop_to_the_webview() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let window = &config["app"]["windows"][0];
    assert_eq!(
        window["dragDropEnabled"],
        serde_json::Value::Bool(false),
        "the window must set dragDropEnabled: false, or dragging media onto \
         a track silently does nothing in the desktop app: {window}"
    );
}

// Writes a minimal real project folder and returns it, so a test can say
// "a folder that holds a project" without the create ceremony.

