use super::*;

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
    let access = MediaAccess::default();
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
        let imported = import_media_file(&access, &outside.join(name), &project).unwrap();
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
    let image = import_media_file(&access, &outside.join("title card.png"), &project).unwrap();
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
fn external_media_is_readable_only_because_the_project_names_it() {
    let access = MediaAccess::default();
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
        external_media_bytes(&access, folder, &recorded).unwrap(),
        b"rush bytes"
    );

    // A media file next to it that the project does NOT name.
    let error = external_media_bytes(&access, folder, &unlisted.to_string_lossy()).unwrap_err();
    assert!(error.contains("not one of the files this project points at"));

    // And the shape this command must never take: reading anything the
    // caller asks for. A path the project does not carry is refused
    // whatever it points at.
    assert!(external_media_bytes(&access, folder, &secret.to_string_lossy()).is_err());
    assert!(external_media_bytes(&access, folder, "/etc/passwd").is_err());
}

#[test]
fn a_clip_imported_a_moment_ago_previews_before_the_project_is_saved() {
    let access = MediaAccess::default();
    // Saving is a deliberate act, so the project file on disk does not
    // mention a clip the user just imported. Refusing to read it until they
    // press Save would mean every fresh import shows a broken preview.
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    fs::create_dir(&project).unwrap();
    write_project(&project, &created_fixture()).unwrap();
    let clip = root.path().join("just picked.mp4");
    fs::write(&clip, b"fresh rush").unwrap();

    let imported = import_media_file(&access, &clip, &project).unwrap();
    let source = imported.source_path.unwrap();
    assert!(
        recorded_external_paths(&read_project(&project).unwrap().config).is_empty(),
        "the saved project must not know about the import yet"
    );
    assert_eq!(
        external_media_bytes(&access, &project.to_string_lossy(), &source).unwrap(),
        b"fresh rush"
    );

    // The gap it closes is exactly one file wide: a sibling nobody picked
    // is still refused.
    let sibling = root.path().join("never picked.mp4");
    fs::write(&sibling, b"other rush").unwrap();
    assert!(external_media_bytes(
        &access,
        &project.to_string_lossy(),
        &sibling.to_string_lossy()
    )
    .is_err());
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

#[test]
fn a_project_the_user_only_opened_reads_any_media_file_it_names() {
    let access = MediaAccess::default();
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
        external_media_bytes(&access, &folder, &named).unwrap(),
        b"PRIVATE PHOTO BYTES",
        "this is the documented perimeter, not a wish about it"
    );

    // And the two things that DO bound it. Media extensions only, checked
    // on the canonical path — a project file cannot name credentials.
    let crafted = config.assets[1].source_path.clone().unwrap();
    assert!(external_media_bytes(&access, &folder, &crafted)
        .unwrap_err()
        .contains("not a media file"));
    // And only what the project names: not the whole folder around it.
    assert!(
        external_media_bytes(&access, &folder, &unnamed.to_string_lossy())
            .unwrap_err()
            .contains("not one of the files this project points at")
    );
}

// S2: a file picked while project A was open is not project B's to read.
// The session list used to be process-global, so opening a colleague's
// project after importing your own rushes handed their project file a
// reader for your footage — no hand-editing required, the paths were
// already in memory.

#[test]
fn one_project_s_picks_are_not_another_project_s_to_read() {
    let access = MediaAccess::default();
    let root = tempfile::tempdir().unwrap();
    let rushes = root.path().join("Rushes");
    fs::create_dir(&rushes).unwrap();
    let footage = rushes.join("my footage.mp4");
    fs::write(&footage, b"A's footage").unwrap();

    let mine = project_folder_at(&root.path().join("Mine"));
    let theirs = project_folder_at(&root.path().join("Theirs"));

    // Imported into MY project, and not saved yet: only the session list
    // knows about it.
    let imported = import_media_file(&access, &footage, &mine).unwrap();
    let source = imported.source_path.unwrap();
    assert!(recorded_external_paths(&read_project(&mine).unwrap().config).is_empty());

    assert_eq!(
        external_media_bytes(&access, &mine.to_string_lossy(), &source).unwrap(),
        b"A's footage",
        "the project the clip was imported into must still preview it"
    );
    let error = external_media_bytes(&access, &theirs.to_string_lossy(), &source).unwrap_err();
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
    let access = MediaAccess::default();
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
        &access,
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
