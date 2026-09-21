use super::*;

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
fn shot_tags_normalize_the_same_way_the_frontend_does() {
    // The three steps `normalizeShotTagSelection` performs in
    // src/lib/shot-tags.ts, in the same order. If these drift the same
    // selection serialises differently depending on which layer wrote it
    // last, and every save shows a diff nobody made.
    let mut config = fixture();
    config.generation_jobs[0].shot_tags = Some(BTreeMap::from([
        // A group emptied by unticking its last option: dropped, not stored.
        ("mood".into(), Vec::new()),
        // A repeat: kept once, in first-seen order.
        (
            "lighting".into(),
            vec!["soft-light".into(), "soft-light".into(), "backlight".into()],
        ),
    ]));
    let normalized = validate_and_normalize_config(config).unwrap();
    let tags = normalized.generation_jobs[0].shot_tags.as_ref().unwrap();
    assert!(!tags.contains_key("mood"), "an empty group must be dropped");
    assert_eq!(
        tags["lighting"],
        vec!["soft-light".to_string(), "backlight".to_string()]
    );

    // Nothing left to say -> the key is absent, never `{}` and never null,
    // so a shot built from prose alone writes the file it always wrote.
    let mut emptied = fixture();
    emptied.generation_jobs[0].shot_tags = Some(BTreeMap::from([("mood".into(), Vec::new())]));
    let emptied = validate_and_normalize_config(emptied).unwrap();
    assert_eq!(emptied.generation_jobs[0].shot_tags, None);
    let json = serde_json::to_string(&emptied).unwrap();
    assert!(
        !json.contains("shotTags"),
        "an empty selection must not reach the file: {json}"
    );

    // A tag id this build has never heard of belongs to the user, not to
    // this build: it survives a load and a save untouched.
    let mut future = fixture();
    future.generation_jobs[0].shot_tags = Some(BTreeMap::from([(
        "weather".into(),
        vec!["light-rain".into()],
    )]));
    let future = validate_and_normalize_config(future).unwrap();
    assert_eq!(
        future.generation_jobs[0].shot_tags.as_ref().unwrap()["weather"],
        vec!["light-rain".to_string()]
    );
}

#[test]
fn a_project_written_before_shot_tags_existed_still_opens() {
    // The created fixture is the byte-exact output of createProjectConfig
    // before this field existed; `created_fixture()` still deserialises it
    // because the field is `#[serde(default)]`.
    let created = validate_and_normalize_config(created_fixture()).unwrap();
    assert_eq!(created.generation_jobs[0].shot_tags, None);
    let json = serde_json::to_string_pretty(&created).unwrap();
    assert!(
        !json.contains("shotTags"),
        "a tagless job must not grow a shotTags key: {json}"
    );
}

#[test]
fn a_project_written_before_scenes_existed_still_opens_and_grows_no_scene_keys() {
    // Both pre-scene shapes: the byte-exact output of createProjectConfig,
    // and a fuller project. Neither has `shots`, `durationSeconds`,
    // `soundscape` or `music`, and neither may sprout one — the frontend
    // reads such a job as a single-shot scene without the file changing.
    for (name, config) in [("created", created_fixture()), ("complete", fixture())] {
        let opened = validate_and_normalize_config(config).unwrap();
        let job = &opened.generation_jobs[0];
        assert_eq!(job.shots, None, "{name}");
        assert_eq!(job.duration_seconds, None, "{name}");
        assert_eq!(job.steps, None, "{name}");
        assert_eq!(job.seed, None, "{name}");
        assert_eq!(job.soundscape, None, "{name}");
        assert_eq!(job.music, None, "{name}");
        let json = serde_json::to_string_pretty(&opened).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let serialized_job = object_of(&value["generationJobs"][0], "generationJobs[0]");
        for key in [
            "shots",
            "durationSeconds",
            "steps",
            "seed",
            "soundscape",
            "music",
        ] {
            assert!(
                !serialized_job.contains_key(key),
                "the {name} fixture grew a {key} key it never had: {json}"
            );
        }
    }
}

#[test]
fn a_scene_keeps_its_shots_and_normalizes_them_the_way_the_frontend_does() {
    let scene = validate_and_normalize_config(scene_fixture()).unwrap();
    let job = &scene.generation_jobs[0];
    let shots = job.shots.as_ref().expect("the scene fixture has shots");
    assert_eq!(shots.len(), 3);
    assert_eq!(
        shots
            .iter()
            .map(|shot| shot.start_seconds)
            .collect::<Vec<_>>(),
        vec![0.0, 4.5, 9.0]
    );
    assert_eq!(job.duration_seconds, Some(12.0));
    // Per-shot settings go through the same tidy as the legacy per-job tags.
    assert_eq!(
        shots[0].settings.as_ref().unwrap()["shotSize"],
        vec!["wide"]
    );
    assert_eq!(shots[2].settings, None);
    // Its words are on the shots, and `prompt`/`creativeBrief` mirror them.
    assert!(shots[0].action.contains("@[ref:reference-woman]"));

    // An emptied group is dropped from a SHOT's settings exactly as it is
    // from a job's tags, and an emptied shot list collapses to no key.
    let mut emptied = scene_fixture();
    emptied.generation_jobs[0].shots.as_mut().unwrap()[1].settings =
        Some(BTreeMap::from([("mood".into(), Vec::new())]));
    let emptied = validate_and_normalize_config(emptied).unwrap();
    assert_eq!(
        emptied.generation_jobs[0].shots.as_ref().unwrap()[1].settings,
        None
    );

    let mut no_shots = scene_fixture();
    no_shots.generation_jobs[0].shots = Some(Vec::new());
    let no_shots = validate_and_normalize_config(no_shots).unwrap();
    assert_eq!(no_shots.generation_jobs[0].shots, None);
    let json = serde_json::to_string_pretty(&no_shots).unwrap();
    assert!(
        !json.contains("\"shots\""),
        "an empty shot list must not be written: {json}"
    );
}

#[test]
fn a_scene_may_have_no_words_left_in_its_mirror_but_a_pre_scene_job_may_not() {
    // The words live on the shots, so blanking the mirror is not a loss.
    let mut scene = scene_fixture();
    scene.generation_jobs[0].prompt = String::new();
    scene.generation_jobs[0].creative_brief = String::new();
    assert!(
        validate_and_normalize_config(scene).is_ok(),
        "a scene keeps its words on its shots, so the mirror may be blank"
    );

    // Without shots the mirror IS the only copy, and blanking it would lose
    // them. zod's superRefine on generationJobSchema refuses the same file.
    for blank in [0, 1] {
        let mut legacy = fixture();
        if blank == 0 {
            legacy.generation_jobs[0].prompt = String::new();
        } else {
            legacy.generation_jobs[0].creative_brief = String::new();
        }
        assert!(
            validate_and_normalize_config(legacy).is_err(),
            "a job with no shots must keep its words"
        );
    }
}

#[test]
fn an_empty_scene_survives_the_round_trip_the_plus_button_creates() {
    /* The Generator's + adds a scene holding ONE shot with nothing written
    in it and no words in the mirror — Slopus writes no line for
    anyone. Rust writes that file to disk before the frontend ever parses
    it back, so if this side accepted it and zod did not, the project
    would save and then fail to open. `createDraftGenerationJob("")`
    builds exactly this shape. */
    let mut empty = scene_fixture();
    let job = &mut empty.generation_jobs[0];
    job.prompt = String::new();
    job.creative_brief = String::new();
    job.reference_ids = Vec::new();
    job.shots = Some(vec![SceneShot {
        video_reference_id: None,
        character_reference_id: None,
        character_target: None,
        id: "scene-walk-shot-1".into(),
        name: None,
        start_seconds: 0.0,
        action: String::new(),
        speech: None,
        speech_language: None,
        settings: None,
    }]);

    let normalized = validate_and_normalize_config(empty)
        .expect("an empty scene is a scene waiting to be written, not an invalid one");
    let shots = normalized.generation_jobs[0]
        .shots
        .as_ref()
        .expect("one blank shot is still a shot and must not be dropped");
    assert_eq!(shots.len(), 1);
    assert_eq!(shots[0].action, "");
}

#[test]
fn a_shot_name_survives_the_project_round_trip() {
    let mut config = scene_fixture();
    config.generation_jobs[0].shots.as_mut().unwrap()[0].name = Some("Doorway reveal".into());

    let normalized = validate_and_normalize_config(config).expect("a named shot is valid");
    assert_eq!(
        normalized.generation_jobs[0].shots.as_ref().unwrap()[0]
            .name
            .as_deref(),
        Some("Doorway reveal")
    );
}

#[test]
fn scene_types_and_character_replacement_inputs_survive_save_and_reopen() {
    for scene_type in [
        "first-last-frame",
        "animate",
        "character-replace",
        "extend",
        "bridge",
    ] {
        let mut config = scene_fixture();
        let job = &mut config.generation_jobs[0];
        job.scene_type = Some(scene_type.into());
        job.start_video_reference_id = Some("start-video".into());
        job.end_video_reference_id = Some("end-video".into());
        let shot = &mut job.shots.as_mut().unwrap()[0];
        shot.video_reference_id = Some("source-video".into());
        shot.character_reference_id = Some("new-character".into());
        shot.character_target = Some("the person on the left".into());
        let normalized = validate_and_normalize_config(config).unwrap();
        let saved = serde_json::to_string(&normalized).unwrap();
        let restored: ProjectConfig = serde_json::from_str(&saved).unwrap();
        assert_eq!(
            restored.generation_jobs[0]
                .start_video_reference_id
                .as_deref(),
            Some("start-video")
        );
        assert_eq!(
            restored.generation_jobs[0]
                .end_video_reference_id
                .as_deref(),
            Some("end-video")
        );
        assert_eq!(
            restored.generation_jobs[0].scene_type.as_deref(),
            Some(scene_type)
        );
        assert_eq!(
            normalized.generation_jobs[0].shots,
            restored.generation_jobs[0].shots
        );
        assert!(saved.contains("\"videoReferenceId\":\"source-video\""));
        assert!(saved.contains("\"characterReferenceId\":\"new-character\""));
    }
    let mut config = scene_fixture();
    config.generation_jobs[0].scene_type = Some("unknown".into());
    assert!(validate_and_normalize_config(config).is_err());
}

#[test]
fn shot_speech_and_custom_languages_survive_the_project_round_trip() {
    let mut config = scene_fixture();
    let shot = &mut config.generation_jobs[0].shots.as_mut().unwrap()[0];
    shot.speech = Some("行こう！ Keep this punctuation.".into());
    shot.speech_language = Some("Japanese".into());

    let normalized = validate_and_normalize_config(config).expect("documented H3 speech is valid");
    let shot = &normalized.generation_jobs[0].shots.as_ref().unwrap()[0];
    assert_eq!(
        shot.speech.as_deref(),
        Some("行こう！ Keep this punctuation.")
    );
    assert_eq!(shot.speech_language.as_deref(), Some("Japanese"));

    let mut custom = scene_fixture();
    custom.generation_jobs[0].shots.as_mut().unwrap()[0].speech_language = Some("Klingon".into());
    let normalized = validate_and_normalize_config(custom)
        .expect("custom speech languages are not validator errors");
    assert_eq!(
        normalized.generation_jobs[0].shots.as_ref().unwrap()[0]
            .speech_language
            .as_deref(),
        Some("Klingon")
    );
}

#[test]
fn a_scene_is_bounded_to_fifteen_seconds_on_both_the_length_and_the_cuts() {
    // The frontend spells this `z.number().min(0).max(15)` on both fields.
    for seconds in [0.0, 7.5, 15.0] {
        let mut config = scene_fixture();
        config.generation_jobs[0].duration_seconds = Some(seconds);
        assert!(
            validate_and_normalize_config(config).is_ok(),
            "rejected a valid scene length of {seconds}s"
        );
    }
    for seconds in [-0.5, 15.1, f64::NAN, f64::INFINITY] {
        let mut config = scene_fixture();
        config.generation_jobs[0].duration_seconds = Some(seconds);
        assert!(
            validate_and_normalize_config(config).is_err(),
            "accepted a scene length of {seconds}s"
        );
        let mut cut = scene_fixture();
        cut.generation_jobs[0].shots.as_mut().unwrap()[1].start_seconds = seconds;
        assert!(
            validate_and_normalize_config(cut).is_err(),
            "accepted a cut at {seconds}s"
        );
    }
    // Two shots that share an id would make "the shot with id X" ambiguous
    // in every edit the UI performs. zod refuses the same file.
    let mut twins = scene_fixture();
    twins.generation_jobs[0].shots.as_mut().unwrap()[1].id = "scene-walk-shot-1".into();
    assert!(validate_and_normalize_config(twins).is_err());
}

#[test]
fn scene_generation_controls_match_the_frontend_boundaries() {
    for (steps, seed) in [(2, -1), (20, 0), (50, 9_007_199_254_740_991)] {
        let mut config = scene_fixture();
        config.generation_jobs[0].steps = Some(steps);
        config.generation_jobs[0].seed = Some(seed);
        assert!(validate_and_normalize_config(config).is_ok());
    }

    for (steps, seed) in [(1, -1), (20, -2), (20, 9_007_199_254_740_992)] {
        let mut config = scene_fixture();
        config.generation_jobs[0].steps = Some(steps);
        config.generation_jobs[0].seed = Some(seed);
        assert!(validate_and_normalize_config(config).is_err());
    }
}

#[test]
fn timeline_flags_fall_back_to_the_frontend_defaults() {
    let mut value = serde_json::to_value(fixture()).unwrap();
    value["timeline"]["tracks"][0]
        .as_object_mut()
        .unwrap()
        .remove("locked");
    value["timeline"]["tracks"][0]
        .as_object_mut()
        .unwrap()
        .remove("muted");
    value["timeline"]["tracks"][0]["clips"][0]
        .as_object_mut()
        .unwrap()
        .remove("sourceStartMs");

    let config: ProjectConfig = serde_json::from_value(value).unwrap();
    let track = &config.timeline.tracks[0];
    assert!(!track.locked);
    assert!(!track.muted);
    assert_eq!(track.clips[0].source_start_ms, 0);
    assert!(validate_and_normalize_config(config.clone()).is_ok());
}

/* ── Where a rendered scene is allowed to land ──────────────────────────
The webview names the scene, and the scene names the file. That is the
whole of the caller's influence over this path, and these pin it.
------------------------------------------------------------------- */
