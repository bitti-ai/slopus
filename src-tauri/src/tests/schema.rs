use super::*;

#[test]
fn rust_never_emits_a_null_the_frontend_schema_refuses() {
    // The cross-layer direction that went unchecked for nine rounds: Rust
    // WRITING something zod cannot read. Browser mode never touches Rust,
    // so nothing else catches it.
    for (name, config) in [
        ("created", created_fixture()),
        ("complete", fixture()),
        ("scene", scene_fixture()),
    ] {
        let config = validate_and_normalize_config(config).unwrap();
        let found = forbidden_nulls(&config);
        assert!(
            found.is_empty(),
            "{name} fixture serialized nulls that zod's .optional() rejects: {found:?}"
        );
    }

    // Positively: a freshly created draft job carries no clip, and the key
    // must be missing rather than null. `createDraftGenerationJob` never
    // sets clipId, so this is every project that has ever been created.
    let created = validate_and_normalize_config(created_fixture()).unwrap();
    let json = serde_json::to_string_pretty(&created).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let job = object_of(&value["generationJobs"][0], "generationJobs[0]");
    assert!(
        !job.contains_key("clipId"),
        "clipId must be absent, not null: {job:?}"
    );
    assert!(!json.contains("\"clipId\""), "clipId leaked into {json}");
}

// Checks the REAL serialised output of `validate_and_normalize_config`
// against `fixtures/rust-serialized-*.json`, which the frontend test suite
// parses with its own zod schema. This is how the two-validator contract
// stops being hand-maintained: a field added to Rust as an `Option`
// without `skip_serializing_if` (or added to zod as a bare `.optional()`)
// changes these bytes and fails on the frontend side, with nobody having
// to remember to extend `NON_NULLABLE_OPTIONAL_KEYS`.
//
// Normal tests are read-only. Set SLOPUS_UPDATE_FIXTURES=1 to regenerate these
// committed contracts deliberately, then run the frontend schema tests.
//
// The output is deterministic — every input is a checked-in fixture or is
// derived from one. The imported-reference case runs the real product code
// path inside a `tempfile::tempdir()`, but the temp path cannot leak into
// the JSON because references store project-relative paths only
// (`references/<file>`); the assertion below proves it per run.

#[test]
fn serialized_wire_format_matches_frontend_fixtures() {
    fn serialize(config: &ProjectConfig) -> String {
        let mut json = serde_json::to_string_pretty(config).unwrap();
        // Trailing newline so the committed bytes are stable under editors
        // and `git diff` alike.
        json.push('\n');
        json
    }

    fn write_fixture(name: &str, json: &str) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures")
            .join(name);
        if std::env::var("SLOPUS_UPDATE_FIXTURES").as_deref() == Ok("1") {
            fs::write(&path, json).unwrap();
        } else {
            let expected = fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            assert_eq!(
                json,
                expected,
                "{} changed; run with SLOPUS_UPDATE_FIXTURES=1 to update intentionally",
                path.display()
            );
        }
    }

    write_fixture(
        "rust-serialized-created.json",
        &serialize(&validate_and_normalize_config(created_fixture()).unwrap()),
    );
    write_fixture(
        "rust-serialized-complete.json",
        &serialize(&validate_and_normalize_config(fixture()).unwrap()),
    );
    // The external-location shapes: an absolute Windows path, an absolute
    // POSIX one, a UNC share, and a copied image beside them. Rust writes
    // exactly these bytes; the frontend suite parses them with real zod.
    write_fixture(
        "rust-serialized-external-media.json",
        &serialize(&validate_and_normalize_config(external_fixture()).unwrap()),
    );
    // Everything a scene added: shots with start times and per-shot
    // settings, a scene length, and the two sound fields.
    write_fixture(
        "rust-serialized-scene.json",
        &serialize(&validate_and_normalize_config(scene_fixture()).unwrap()),
    );

    // An ACTUALLY IMPORTED reference: produced by the same function the
    // create-project command calls, not a hand-written fixture record.
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("harbor facade.png");
    fs::write(&source, b"\x89PNG\r\n\x1a\n").unwrap();
    let imported = create_project_in_with_references(
        root.path(),
        &created_fixture(),
        std::slice::from_ref(&source),
    )
    .unwrap();
    assert_eq!(
        imported.config.references[0].relative_path.as_deref(),
        Some("references/harbor facade.png"),
        "the imported reference must be stored as a project-relative path"
    );
    let json = serialize(&imported.config);
    // The randomly named temp directory is the only non-deterministic input
    // in this test; if any part of it reached the JSON the committed file
    // would change on every run and dirty the tree at random.
    let temp_marker = root
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        !json.contains(&temp_marker),
        "the temp directory name '{temp_marker}' leaked into the generated fixture: {json}"
    );
    write_fixture("rust-serialized-initial-reference.json", &json);
}

#[test]
fn is_iso_datetime_agrees_with_real_zod_on_every_recorded_case() {
    // fixtures/iso-datetime-cases.json is a differential harness: 932
    // strings (single-character mutations, insertions, deletions and
    // truncations of valid stamps, plus calendar and time boundaries),
    // each labelled with the verdict of the frontend's real
    // `z.string().datetime()` from the installed zod 3.25.76. The
    // hand-written table above documents intent readably; THIS test is the
    // one that proves parity, and it is committed rather than run once as
    // a throwaway so a regression is caught by `cargo test`.
    let cases: Vec<(String, bool)> =
        serde_json::from_str(include_str!("../../../fixtures/iso-datetime-cases.json"))
            .expect("fixtures/iso-datetime-cases.json is not a [string, bool] array");
    assert!(
        cases.len() > 900,
        "the harness lost cases: only {} remain",
        cases.len()
    );

    // Collect every disagreement before failing: one assert per iteration
    // would report a single string and hide the shape of the regression.
    let mut disagreements = Vec::new();
    for (value, zod_accepts) in &cases {
        if is_iso_datetime(value) != *zod_accepts {
            disagreements.push(format!(
                "'{value}': zod {}, rust {}",
                if *zod_accepts { "accepts" } else { "rejects" },
                if *zod_accepts { "rejects" } else { "accepts" }
            ));
        }
    }
    assert!(
        disagreements.is_empty(),
        "{} of {} cases disagree with zod; first {}:\n{}",
        disagreements.len(),
        cases.len(),
        disagreements.len().min(10),
        disagreements
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn both_fixtures_round_trip_losslessly_through_json() {
    for (name, config) in [
        ("created", created_fixture()),
        ("complete", fixture()),
        ("scene", scene_fixture()),
    ] {
        let normalized =
            without_derived_project_state(validate_and_normalize_config(config).unwrap());
        let json = serde_json::to_string_pretty(&normalized).unwrap();
        let reparsed: ProjectConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(
            reparsed, normalized,
            "{name} fixture lost data in a round trip"
        );
        assert_eq!(
            validate_and_normalize_config(reparsed).unwrap(),
            normalized,
            "{name} fixture failed to re-validate after a round trip"
        );
    }
}

#[test]
fn absent_non_nullable_optionals_are_omitted_entirely() {
    let mut config = fixture();
    config.assets[0].duration_ms = None;
    config.assets[0].width = None;
    config.assets[0].height = None;
    config.timeline.tracks[0].clips[0].color = None;
    config.generation_jobs[0].clip_id = None;
    let config = without_derived_project_state(validate_and_normalize_config(config).unwrap());

    let found = forbidden_nulls(&config);
    assert!(found.is_empty(), "emitted forbidden nulls: {found:?}");

    let value = serde_json::to_value(&config).unwrap();
    let asset = object_of(&value["assets"][0], "assets[0]");
    for key in ["durationMs", "width", "height"] {
        assert!(!asset.contains_key(key), "assets[0].{key} must be omitted");
    }
    let clip = object_of(&value["timeline"]["tracks"][0]["clips"][0], "clips[0]");
    assert!(!clip.contains_key("color"), "clip color must be omitted");
    // The clip's OWN durationMs is required and must survive — the omission
    // is per field, not per key name.
    assert_eq!(clip["durationMs"], serde_json::json!(8000));
    let job = object_of(&value["generationJobs"][0], "generationJobs[0]");
    assert!(!job.contains_key("clipId"), "job clipId must be omitted");

    let reparsed: ProjectConfig = serde_json::from_value(value).unwrap();
    assert_eq!(
        reparsed, config,
        "omitted optionals did not come back as None"
    );
}

#[test]
fn nullable_optionals_still_serialize_as_explicit_null() {
    // The guard against "fixing" the clipId break by blanket-adding
    // skip_serializing_if: every field below is `.nullable()` on the
    // frontend, so an explicit null is what zod expects. Dropping the key
    // breaks the other direction just as badly.
    fn assert_explicit_null(parent: &serde_json::Value, path: &str, key: &str) {
        let fields = object_of(parent, path);
        assert!(
            fields.contains_key(key),
            "{path}.{key} is .nullable() on the frontend and must stay present"
        );
        assert!(
            fields[key].is_null(),
            "{path}.{key} must serialize as null when None, got {}",
            fields[key]
        );
    }

    let mut config = fixture();
    config.thumbnail = None;
    config.references[0].content = None;
    config.references[0].relative_path = None;
    config.generation_jobs[0].provider_id = None;
    config.generation_jobs[0].output_relative_path = None;
    config.generation_jobs[0].error = None;
    config
        .provider_settings
        .get_mut("minimax-h3")
        .unwrap()
        .model = None;
    let config = validate_and_normalize_config(config).unwrap();

    let json = serde_json::to_string_pretty(&config).unwrap();
    assert!(
        json.contains("\"thumbnail\": null"),
        "thumbnail must serialize as an explicit null: {json}"
    );
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_explicit_null(&value, "config", "thumbnail");
    assert_explicit_null(&value["references"][0], "references[0]", "content");
    assert_explicit_null(&value["references"][0], "references[0]", "relativePath");
    assert_explicit_null(
        &value["generationJobs"][0],
        "generationJobs[0]",
        "providerId",
    );
    assert_explicit_null(
        &value["generationJobs"][0],
        "generationJobs[0]",
        "outputRelativePath",
    );
    assert_explicit_null(&value["generationJobs"][0], "generationJobs[0]", "error");
    assert_explicit_null(
        &value["providerSettings"]["minimax-h3"],
        "providerSettings['minimax-h3']",
        "model",
    );
}

#[test]
fn iso_datetime_matches_the_frontend_datetime_rules() {
    for value in [
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00.123456789Z",
        "2024-02-29T23:59:59Z",
        "2000-02-29T00:00:00Z",
        "2026-12-31T23:59:59.9Z",
        // zod's seconds group is optional: `(:[0-5]\d(\.\d+)?)?`. Verified
        // against the installed zod 3.25.76, which accepts this. Rejecting
        // it would make a legitimate file unsavable in the desktop app.
        "2026-01-01T00:00Z",
        "2026-12-31T23:59Z",
    ] {
        assert!(is_iso_datetime(value), "rejected valid date-time '{value}'");
    }
    for value in [
        "2026-01-01",
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:00+01:00",
        "2026-01-01t00:00:00z",
        "2026-01-01T00:00:00.Z",
        "",
        "not a date",
        "2026-01-01T00:00:00.000Z ",
        " 2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000ZZ",
        "2026-13-01T00:00:00Z",
        "2026-00-01T00:00:00Z",
        "2026-02-30T00:00:00Z",
        "2026-01-00T00:00:00Z",
        "2025-02-29T00:00:00Z",
        "1900-02-29T00:00:00Z",
        "2026-01-01T24:00:00Z",
        "2026-01-01T00:60:00Z",
        "2026-01-01T00:00:60Z",
        "2026-01-01 00:00:00Z",
        "20260101T000000Z",
        // The fraction belongs to the seconds group, so it cannot follow
        // bare minutes.
        "2026-01-01T00:00.5Z",
        "2026-01-01T00:00",
        "2026-01-01T00:60Z",
        "2026-01-01T24:00Z",
        "2026-01-01T00:00:Z",
    ] {
        assert!(
            !is_iso_datetime(value),
            "accepted invalid date-time '{value}'"
        );
    }
}

#[test]
fn every_date_field_is_checked_the_way_the_frontend_checks_it() {
    // A date Rust accepts and zod refuses is written to disk and the project
    // disappears from the library on the next launch, so every date field
    // has to be covered — not just the two on the config root.
    assert!(validate_and_normalize_config(fixture()).is_ok());
    assert!(validate_and_normalize_config(created_fixture()).is_ok());

    fn rejects(field: &str, break_config: impl FnOnce(&mut ProjectConfig)) {
        let mut config = fixture();
        break_config(&mut config);
        let error = validate_and_normalize_config(config)
            .expect_err(&format!("accepted a {field} the frontend schema rejects"));
        assert!(
            error.contains("ISO date-time"),
            "unexpected error for {field}: {error}"
        );
    }

    rejects("project createdAt", |config| {
        config.created_at = "2026-01-01".into();
    });
    rejects("project updatedAt", |config| {
        config.updated_at = "2026-01-02T03:04:05".into();
    });
    rejects("asset createdAt", |config| {
        config.assets[0].created_at = "2026-01-01T00:10:00+01:00".into();
    });
    rejects("reference createdAt", |config| {
        config.references[0].created_at = "2026-01-01t00:05:00.000z".into();
    });
    rejects("job createdAt", |config| {
        config.generation_jobs[0].created_at = String::new();
    });
    rejects("job updatedAt", |config| {
        config.generation_jobs[0].updated_at = "not a date".into();
    });
    rejects("agent message createdAt", |config| {
        config.agent_conversation.messages[0].created_at = "2026-01-01T00:11:00".into();
    });
}

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
fn sanitizes_folder_names() {
    assert_eq!(safe_folder_name("  Launch: Film?  "), "Launch- Film-");
    assert_eq!(safe_folder_name("..."), "Untitled video");
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
    rejects("invalid project Look", |config| {
        config.settings.default_look = Some("not a look id".into());
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

#[test]
fn validator_accepts_every_boundary_the_frontend_schema_allows() {
    for aspect_ratio in ["16:9", "9:16", "1:1", "4:5"] {
        let mut config = fixture();
        config.settings.aspect_ratio = aspect_ratio.into();
        config.brief.aspect_ratio = aspect_ratio.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid aspect ratio {aspect_ratio}"
        );
    }
    for resolution in [
        "416p", "544p", "640p", "768p", "1088p", "1344p", "720p", "1080p", "4k",
    ] {
        let mut config = fixture();
        config.settings.resolution = resolution.into();
        config.brief.resolution = resolution.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid resolution {resolution}"
        );
    }
    for frame_rate in [24u32, 25, 30, 60] {
        let mut config = fixture();
        config.settings.frame_rate = frame_rate;
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid frame rate {frame_rate}"
        );
    }
    for background_color in ["#000000", "#FFFFFF", "#abcdef", "#ABCDEF", "#10131a"] {
        let mut config = fixture();
        config.settings.background_color = background_color.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid background color {background_color}"
        );
    }
    for seconds in [0u32, 1, 5, 60, 600, 900, 7200] {
        let mut config = fixture();
        config.brief.target_duration_seconds = seconds;
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid target duration {seconds}"
        );
    }
    for status in ["draft", "queued", "generating", "ready", "failed"] {
        let mut config = fixture();
        config.brief.status = status.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid brief status {status}"
        );
    }
    for kind in ["video", "audio", "image", "caption", "generated"] {
        let mut config = fixture();
        config.assets[0].kind = kind.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid asset kind {kind}"
        );
    }
    for kind in ["video", "audio", "caption"] {
        let mut config = fixture();
        config.timeline.tracks[0].kind = kind.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid track kind {kind}"
        );
    }
    for status in ["draft", "generated", "approved"] {
        let mut config = fixture();
        config.timeline.tracks[0].clips[0].status = status.into();
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid clip status {status}"
        );
    }
    for intent in [
        "character",
        "animal",
        "product",
        "location",
        "style",
        "audio",
    ] {
        let mut config = fixture();
        config.references[0].intended_use = vec![intent.into()];
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected valid reference intended use {intent}"
        );
    }

    let mut longest_name = fixture();
    longest_name.name = "n".repeat(120);
    assert!(
        validate_and_normalize_config(longest_name).is_ok(),
        "rejected a 120 character project name"
    );

    let mut sparse = fixture();
    sparse.assets[0].width = None;
    sparse.assets[0].height = None;
    sparse.assets[0].duration_ms = None;
    sparse.references[0].content = None;
    sparse.references[0].intended_use = Vec::new();
    sparse.generation_jobs[0].provider_id = None;
    sparse.generation_jobs[0].error = None;
    assert!(
        validate_and_normalize_config(sparse).is_ok(),
        "rejected a config whose optional fields are absent"
    );
}
