use super::runtime::{without_endpoint_provider_settings, DEFAULT_TIMEOUT_SECONDS};
use super::*;
use super::{
    discovery::*, process::*, prompt::*, protocol::*, providers::compatible::*,
    providers::output::*, providers::*, retry::*,
};
use crate::generation::models::h3::validate_agent_shot_settings;
use crate::project::storage::PROJECT_FILE_NAME;
use crate::project::*;
use serde_json::Value;
use std::fs;
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{atomic::AtomicBool, Arc, Mutex},
    time::Duration,
};
use std::{path::PathBuf, sync::atomic::Ordering};

#[test]
fn parses_answer_question_and_validates_empty_content() {
    assert!(matches!(
        parse_turn_result(r#"{"kind":"answer","content":"Done"}"#).unwrap(),
        AgentTurnResult::Answer { .. }
    ));
    assert!(matches!(
        parse_turn_result(
            r#"```json
{"kind":"question","content":"Which shot?"}
```"#,
        )
        .unwrap(),
        AgentTurnResult::Question { .. }
    ));
    assert!(parse_turn_result(r#"{"kind":"answer","content":""}"#).is_err());
    assert!(matches!(
        parse_turn_result(
            r#"{"op":"scene.remove","id":"scene-old"}
    {"op":"commit","summary":"Removed the old scene."}"#
        )
        .unwrap(),
        AgentTurnResult::Commands { commands, .. } if commands.len() == 1
    ));
}

#[test]
fn validator_failures_are_returned_for_three_correction_rounds() {
    assert!(MAX_RETRIES_PER_VALIDATION_ISSUE >= 3);
    let prompt = validation_retry_prompt(
        "Create four shots",
        r#"{"op":"shot.add"}"#,
        "Shot 4 starts at 18 seconds.",
        2,
    );
    assert!(prompt.contains("Correction round 2 of 3 for this issue"));
    assert!(prompt.contains("Shot 4 starts at 18 seconds."));
    assert!(prompt.contains("Create four shots"));
    assert!(prompt.contains(r#"{"op":"shot.add"}"#));
    assert!(full_agent_system_prompt().contains("seconds must be between 0 and 15"));
}

#[test]
fn validation_events_use_the_frontend_field_name() {
    let event = serde_json::to_value(AgentEvent::Validation {
        round: 1,
        max_rounds: 3,
        text: "Fix the reference type.".into(),
    })
    .unwrap();

    assert_eq!(event["maxRounds"], 3);
    assert!(event.get("max_rounds").is_none());
}

#[test]
fn scene_planning_prompt_requires_reference_first_shots_and_structured_speech() {
    let system_prompt = full_agent_system_prompt();
    assert!(system_prompt.contains("plan reusable visual references before writing the shots"));
    for required in [
        "physical detail",
        "clothing",
        "location reference",
        "product or prop reference",
        "@[ref:<reference-id>]",
        "shot.speech",
        "shot.speechLanguage",
        "Never place spoken words",
        "Commands cannot invent paths or image entries",
        "concrete, time-bounded visual beat",
        "startSeconds to the next shot's startSeconds",
        "one readable action or reaction",
        "spoken text short enough",
        "Continue the supplied prior conversation",
        "Look is the scene-wide visualStyle setting",
        "Sound is the scene.add or scene.set sound field",
        "Music is the scene.add or scene.set music field",
        "Use shot.settings when a supported setting materially clarifies",
        "Start with no settings",
        "Most shots should use zero to three setting groups",
        "Never fill categories merely because options are available",
        "A non-static cameraMovement must also have one cameraSpeed and one cameraAmplitude",
        "visualStyle: live-action-cinematic",
        "shotSize: extreme-wide",
        "clip.add",
        "appends the clip directly after the last clip",
        "Timeline clips and scene shots are different",
    ] {
        assert!(system_prompt.contains(required), "missing: {required}");
    }
}

fn agent_scene_fixture() -> (ProjectConfig, ProjectConfig) {
    let before: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let mut next = before.clone();
    next.references.push(ReusableReference {
        id: "reference-mara".into(),
        kind: "text".into(),
        name: "Mara".into(),
        description: "A tall woman in her thirties with a square face, cropped black hair, a rust wool jacket, charcoal trousers, and black leather boots.".into(),
        content: None,
        relative_path: None,
        source_path: None,
        images: Vec::new(),
        refmods: Vec::new(),
            video: None,
        intended_use: vec!["character".into()],
        subcategory: None,
        icon_relative_path: None,
        created_at: "2026-01-02T04:00:00.000Z".into(),
    });
    let job = &mut next.generation_jobs[0];
    job.reference_ids.push("reference-mara".into());
    job.soundscape =
        Some("Quiet workshop ventilation under the click of metal tools on the bench.".into());
    job.music = Some("Sparse felt piano at a slow tempo with restrained dynamics.".into());
    job.shots = Some(vec![SceneShot {
        video_reference_id: None,
        character_reference_id: None,
        character_target: None,
        id: "shot-mara-turns".into(),
        name: Some("Mara turns".into()),
        start_seconds: 0.0,
        action: "Medium shot of @[ref:reference-mara] turning from the workbench and placing both hands flat on its edge before the cut.".into(),
        speech: Some("The prototype is ready.".into()),
        speech_language: Some("English".into()),
        settings: Some(BTreeMap::from([
            ("visualStyle".into(), vec!["live-action-cinematic".into()]),
            ("shotSize".into(), vec!["medium".into()]),
            ("cameraMovement".into(), vec!["push-in".into()]),
            ("cameraSpeed".into(), vec!["slow".into()]),
            ("cameraAmplitude".into(), vec!["small".into()]),
        ])),
    }]);
    (before, next)
}

#[test]
fn agent_scene_conventions_accept_described_cited_references_and_speech_fields() {
    let (before, next) = agent_scene_fixture();
    validate_agent_scene_conventions(&before, &next).unwrap();
}

#[test]
fn agent_scene_conventions_reject_dialogue_in_action_and_broken_reference_binding() {
    let (before, mut dialogue) = agent_scene_fixture();
    dialogue.generation_jobs[0].shots.as_mut().unwrap()[0].action =
        "Mara says, \"The prototype is ready.\"".into();
    assert!(validate_agent_scene_conventions(&before, &dialogue)
        .unwrap_err()
        .contains("contains dialogue in action"));

    let (_, mut unbound) = agent_scene_fixture();
    unbound.generation_jobs[0]
        .reference_ids
        .retain(|id| id != "reference-mara");
    assert!(validate_agent_scene_conventions(&before, &unbound)
        .unwrap_err()
        .contains("does not include it in referenceIds"));

    let (_, mut missing_language) = agent_scene_fixture();
    missing_language.generation_jobs[0].shots.as_mut().unwrap()[0].speech_language = None;
    assert!(validate_agent_scene_conventions(&before, &missing_language)
        .unwrap_err()
        .contains("speech but no speechLanguage"));
}

#[test]
fn agent_shot_settings_reject_unknown_ids_and_invalid_camera_combinations() {
    let shot = |id: &str, settings: BTreeMap<String, Vec<String>>| SceneShot {
        video_reference_id: None,
        character_reference_id: None,
        character_target: None,
        id: id.into(),
        name: None,
        start_seconds: 0.0,
        action: "A subject turns.".into(),
        speech: None,
        speech_language: None,
        settings: Some(settings),
    };
    let unknown = shot(
        "shot-first",
        BTreeMap::from([("shotSize".into(), vec!["invented-size".into()])]),
    );
    assert!(validate_agent_shot_settings(None, &unknown, "shot-first")
        .unwrap_err()
        .contains("unsupported Settings option"));

    let unqualified_move = shot(
        "shot-first",
        BTreeMap::from([("cameraMovement".into(), vec!["push-in".into()])]),
    );
    assert!(
        validate_agent_shot_settings(None, &unqualified_move, "shot-first")
            .unwrap_err()
            .contains("cameraSpeed and cameraAmplitude")
    );

    let late_look = shot(
        "shot-later",
        BTreeMap::from([("visualStyle".into(), vec!["watercolor".into()])]),
    );
    assert!(validate_agent_shot_settings(None, &late_look, "shot-first")
        .unwrap_err()
        .contains("earliest shot only"));
}

#[test]
fn normalizes_claude_and_codex_event_lines() {
    let lines = vec![r#"{"type":"assistant","message":{"content":[{"type":"text","text":"{\"kind\":\"answer\",\"content\":\"Claude\"}"}]}}"#.into()];
    assert!(extract_provider_output(&lines).unwrap().contains("Claude"));
    let lines = vec![r#"{"type":"item.completed","item":{"type":"agent_message","text":"{\"kind\":\"answer\",\"content\":\"Codex\"}"}}"#.into()];
    assert!(extract_provider_output(&lines).unwrap().contains("Codex"));
}

#[test]
fn provider_specs_are_argument_vectors_and_confined_to_root() {
    let root = tempfile::tempdir().unwrap();
    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let claude = ClaudeProvider
        .command_spec(
            root.path(),
            Path::new("claude"),
            &config,
            "hello; rm -rf .",
            None,
        )
        .unwrap();
    assert_eq!(claude.current_dir, root.path());
    // `--bare` refuses OAuth and keychain credentials, so a subscription
    // login could never run a turn through it.
    assert!(!claude.args.iter().any(|arg| arg == "--bare"));
    assert!(claude.args.iter().any(|arg| arg == "--print"));
    assert_eq!(
        claude
            .args
            .iter()
            .filter(|arg| *arg == "hello; rm -rf .")
            .count(),
        0
    );
    assert!(claude
        .stdin_payload
        .as_deref()
        .unwrap()
        .contains("hello; rm -rf ."));
    assert!(claude.args.iter().any(|arg| arg
        .to_string_lossy()
        .contains("Sound is the scene.add or scene.set sound field")));
    let codex = CodexProvider
        .command_spec(root.path(), Path::new("codex"), &config, "hello", None)
        .unwrap();
    assert!(codex
        .args
        .windows(2)
        .any(|pair| pair[0] == "--sandbox" && pair[1] == "read-only"));
    assert!(codex
        .stdin_payload
        .as_deref()
        .unwrap()
        .contains("Use shot.settings when a supported setting materially clarifies"));
}

/// `claude --print --output-format stream-json` exits 1 before it reaches
/// the model — "When using --print, --output-format=stream-json requires
/// --verbose" — so the flag is load-bearing, not decoration. Verified
/// against claude 2.1.234.
#[test]
fn claude_stream_json_is_invoked_with_the_verbose_flag_it_requires() {
    let root = tempfile::tempdir().unwrap();
    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let spec = ClaudeProvider
        .command_spec(root.path(), Path::new("claude"), &config, "hello", None)
        .unwrap();
    let args: Vec<String> = spec
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    assert_eq!(
        args[..6],
        [
            "--print",
            "--verbose",
            "--output-format",
            "stream-json",
            "--tools",
            ""
        ]
    );
    // `--tools` takes a variadic list, so another flag must terminate it.
    let tools = args.iter().position(|arg| arg == "--tools").unwrap();
    assert!(args[tools + 2].starts_with("--"));
    assert!(!args.iter().any(|arg| arg.contains("hello")));
    assert!(spec.stdin_payload.as_deref().unwrap().contains("hello"));
}

/// `--skip-git-repo-check` and `--json` exist only on `codex exec`; the
/// top-level `codex` command rejects them. Order matters
/// twice over: after the subcommand, before the stdin marker.
/// Verified against codex-cli 0.147.0.
#[test]
fn codex_flags_sit_between_the_exec_subcommand_and_the_stdin_marker() {
    let root = tempfile::tempdir().unwrap();
    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let spec = CodexProvider
        .command_spec(root.path(), Path::new("codex"), &config, "hello", None)
        .unwrap();
    let args: Vec<String> = spec
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();

    assert_eq!(args[0], "exec");
    let stdin_marker = args.len() - 1;
    assert_eq!(args[stdin_marker], "-");
    assert!(spec.stdin_payload.as_deref().unwrap().contains("hello"));
    for flag in ["--skip-git-repo-check", "--json", "--ephemeral"] {
        let at = args
            .iter()
            .position(|arg| arg == flag)
            .unwrap_or_else(|| panic!("{flag} is missing from the codex invocation"));
        assert!(at > 0 && at < stdin_marker, "{flag} is out of position");
    }
    // The provider receives all project data over stdin and only proposes
    // commands, so it never needs write access to the project folder.
    let sandbox = args.iter().position(|arg| arg == "--sandbox").unwrap();
    assert_eq!(args[sandbox + 1], "read-only");
    assert!(sandbox < stdin_marker);
}

#[test]
fn follow_up_prompts_name_the_prior_conversation_explicitly() {
    let mut config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    config.agent_conversation.messages = vec![
        AgentMessage {
            id: "message-user".into(),
            role: "user".into(),
            content: "Make a sitcom scene.".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
        },
        AgentMessage {
            id: "message-assistant".into(),
            role: "assistant".into(),
            content: "Which people should enter?".into(),
            created_at: "2026-01-01T00:00:01.000Z".into(),
        },
    ];

    let context = context_prompt(&config, "Leonard and Penny.").unwrap();
    assert!(context.contains("Prior conversation JSON:"));
    assert!(context.contains("Which people should enter?"));
    assert!(context.contains("Current user reply or request:\nLeonard and Penny."));
    assert_eq!(context.matches("Which people should enter?").count(), 1);
    for persisted_section in [
        "\"settings\"",
        "\"assets\"",
        "\"timeline\"",
        "\"references\"",
        "\"generationJobs\"",
        "\"providerSettings\"",
    ] {
        assert!(
            context.contains(persisted_section),
            "missing: {persisted_section}"
        );
    }
    assert!(full_agent_system_prompt().contains(
        "A field may be useful context even when no agent command is allowed to modify it"
    ));
    assert!(DEFAULT_TIMEOUT_SECONDS >= 300);
}

#[test]
fn large_requests_are_piped_instead_of_crossing_the_windows_command_line_limit() {
    let root = tempfile::tempdir().unwrap();
    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let request = "long validation retry ".repeat(4_000);

    for spec in [
        ClaudeProvider
            .command_spec(root.path(), Path::new("claude"), &config, &request, None)
            .unwrap(),
        CodexProvider
            .command_spec(root.path(), Path::new("codex"), &config, &request, None)
            .unwrap(),
    ] {
        let command_line_units = spec
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().encode_utf16().count() + 1)
            .sum::<usize>();
        assert!(command_line_units < 32_000);
        assert!(!spec
            .args
            .iter()
            .any(|arg| arg.to_string_lossy().contains("long validation retry")));
        assert!(spec.stdin_payload.as_deref().unwrap().contains(&request));
    }
}

/// `canonicalize` returns `\\?\C:\...` on Windows. Windows normalises that
/// away for a child's working directory, but Codex is handed its root a
/// second time as a plain `-C <DIR>` argument, where the verbatim form is
/// nobody's contract.
#[test]
fn the_working_directory_is_the_plain_project_folder() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join(PROJECT_FILE_NAME), "{}").unwrap();
    let confined = confined_project_root(root.path()).unwrap();

    assert!(!confined.to_string_lossy().starts_with(r"\\?\"));
    assert!(confined.join(PROJECT_FILE_NAME).is_file());

    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let claude = ClaudeProvider
        .command_spec(&confined, Path::new("claude"), &config, "hi", None)
        .unwrap();
    let codex = CodexProvider
        .command_spec(&confined, Path::new("codex"), &config, "hi", None)
        .unwrap();
    assert_eq!(claude.current_dir, confined);
    assert_eq!(codex.current_dir, confined);
    // Codex is told the same folder a second time, as an argument.
    let cd = codex.args.iter().position(|arg| arg == "-C").unwrap();
    assert_eq!(Path::new(&codex.args[cd + 1]), confined);
}

/// A real `--verbose` transcript, trimmed of payload but structurally
/// intact: an init record, a rate-limit record, an assistant turn whose
/// only content block is `thinking` (no `text` key at all), the assistant
/// turn that carries the answer, and the terminal `result`.
#[test]
fn verbose_stream_records_do_not_hide_the_final_result() {
    let lines: Vec<String> = vec![
        r#"{"type":"system","subtype":"init","cwd":"C:\\Projects\\Film","tools":[]}"#.into(),
        r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}"#.into(),
        r#"{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}"#.into(),
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"","signature":"CAIS"}]}}"#.into(),
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"{\"kind\":\"answer\",\"content\":\"streamed\"}"}]}}"#.into(),
        r#"{"is_error":false,"subtype":"success","type":"result","result":"{\"kind\":\"answer\",\"content\":\"streamed\"}"}"#.into(),
    ];
    assert!(matches!(
        parse_turn_result(&extract_provider_output(&lines).unwrap()).unwrap(),
        AgentTurnResult::Answer { content } if content == "streamed"
    ));
}

/// A command turn is JSONL rather than one JSON value, so Codex's strict
/// structured-output mode cannot represent it. Passing an output schema
/// would reject the request before the model was reached.
#[test]
fn codex_is_not_handed_an_output_schema_it_cannot_satisfy() {
    let root = tempfile::tempdir().unwrap();
    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let spec = CodexProvider
        .command_spec(root.path(), Path::new("codex"), &config, "hello", None)
        .unwrap();
    assert!(!spec.args.iter().any(|arg| arg == "--output-schema"));
    // And nothing is left behind in the project folder to feed it.
    assert!(!root.path().join("cache").exists());
}

/// Codex writes "Reading additional input from stdin..." to stderr on
/// every run, so the last stderr line is never the reason it failed. That
/// notice once stood in for a rejected request the provider had spelled
/// out on stdout.
#[test]
fn a_failure_is_explained_from_stdout_not_the_last_stderr_line() {
    let lines: Vec<String> = vec![
        r#"{"type":"thread.started","thread_id":"01a0"}"#.into(),
        r#"{"type":"error","message":"invalid_json_schema: additionalProperties is required"}"#
            .into(),
        r#"{"type":"turn.failed","error":{"message":"invalid_json_schema: additionalProperties is required"}}"#.into(),
    ];
    let detail = structured_failure(&lines).unwrap();
    assert!(detail.contains("invalid_json_schema"), "{detail}");
    assert!(structured_failure(&["not json".to_string()]).is_none());
}

#[test]
fn codex_stdin_notice_is_not_reported_as_an_error() {
    assert!(is_benign_provider_diagnostic(
        ProviderId::Codex,
        "Reading additional input from stdin..."
    ));
    assert!(!is_benign_provider_diagnostic(
        ProviderId::Claude,
        "Reading additional input from stdin..."
    ));
    assert!(!is_benign_provider_diagnostic(
        ProviderId::Codex,
        "A real provider failure"
    ));
}

#[test]
fn an_in_band_failure_is_reported_as_a_failure() {
    // Claude still exits 0 for this, so the exit status cannot catch it.
    let lines: Vec<String> = vec![
        r#"{"type":"system","subtype":"init","cwd":"C:\\Projects\\Film"}"#.into(),
        r#"{"is_error":true,"subtype":"error_during_execution","type":"result","result":"Credit balance is too low"}"#.into(),
    ];
    let error = extract_provider_output(&lines).unwrap_err();
    assert!(error.contains("Credit balance is too low"), "{error}");
}

#[cfg(windows)]
#[test]
fn fake_provider_executable_streams_a_normalized_result() {
    let root = tempfile::tempdir().unwrap();
    // A .bat run by cmd.exe rather than a PowerShell script. This test
    // spawns a REAL child and reads its stdout; the interpreter is
    // incidental to what it checks, but PowerShell's startup is not — on a
    // loaded machine it has taken minutes here, and a 5-second budget then
    // reports a defect in the pipe reader that does not exist. cmd starts
    // in ~25ms. Keep the JSON clear of `& < > | ^ %`, which `echo` eats.
    let script = root.path().join("fake-provider.bat");
    fs::write(
        &script,
        "@echo {\"kind\":\"answer\",\"content\":\"fixture provider\"}\r\n",
    )
    .unwrap();
    let executable = discover_executable("cmd", None).expect("cmd.exe fixture host");
    let spec = CommandSpec {
        executable,
        args: vec!["/c".into(), script.into_os_string()],
        current_dir: root.path().into(),
        stdin_payload: None,
    };
    let streamed = std::cell::RefCell::new(Vec::new());
    let (_, output) = run_subprocess(
        spec,
        ProviderId::Codex,
        Arc::new(AtomicBool::new(false)),
        // Generous because it is timing nothing: the child prints one line
        // and exits.
        Duration::from_secs(30),
        &|event| streamed.borrow_mut().push(event.clone()),
    )
    .unwrap();
    assert!(streamed
        .borrow()
        .iter()
        .any(|event| matches!(event, AgentEvent::Message { .. })));
    assert!(matches!(
        streamed.borrow().last(),
        Some(AgentEvent::Completed)
    ));
    assert!(matches!(
        parse_turn_result(&output).unwrap(),
        AgentTurnResult::Answer { content } if content == "fixture provider"
    ));
}

#[cfg(windows)]
#[test]
fn discovery_never_selects_a_shell_script_shim() {
    for name in ["claude", "codex"] {
        if let Some(path) = discover_executable(name, None) {
            let extension = path.extension().unwrap_or_default().to_string_lossy();
            assert!(extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com"));
        }
    }
}

#[test]
fn a_probe_sweep_is_reused_until_the_settings_or_the_ttl_change() {
    use std::sync::atomic::AtomicUsize;

    let cache: Mutex<Option<CachedProbe>> = Mutex::new(None);
    let sweeps = AtomicUsize::new(0);
    let sweep = || {
        sweeps.fetch_add(1, Ordering::AcqRel);
        Vec::new()
    };
    let ttl = Duration::from_secs(60);

    cached_or_probe(&cache, "claude-default".into(), ttl, sweep);
    cached_or_probe(&cache, "claude-default".into(), ttl, sweep);
    // Four child processes, not eight: the app shell mounting twice must
    // not launch the CLIs twice.
    assert_eq!(sweeps.load(Ordering::Acquire), 1);

    // A provider actually reconfigured is a different question.
    cached_or_probe(&cache, "claude-disabled".into(), ttl, sweep);
    assert_eq!(sweeps.load(Ordering::Acquire), 2);

    // And an expired answer is no answer.
    cached_or_probe(&cache, "claude-disabled".into(), Duration::ZERO, sweep);
    assert_eq!(sweeps.load(Ordering::Acquire), 3);
}

#[test]
fn engine_paths_do_not_invalidate_the_agent_probe() {
    // The engine settings ride in the same map and change whenever the
    // settings screen is touched. Keying on them re-ran the CLI sweep for
    // a change that cannot affect its answer.
    let mut with_engine = BTreeMap::new();
    with_engine.insert(
        "slopfab".to_string(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::new(),
        },
    );
    assert_eq!(
        provider_probe_key(&BTreeMap::new()),
        provider_probe_key(&with_engine)
    );
}

#[test]
fn installed_provider_probes_end_in_ready_or_auth_required() {
    for status in provider_statuses(&ProviderDiscovery::default(), &BTreeMap::new()) {
        if status.executable.is_some() {
            assert!(
                matches!(status.state, "ready" | "authRequired"),
                "{}: {}",
                status.label,
                status.detail
            );
        }
    }
}

#[test]
fn claude_readiness_probes_the_oauth_capable_auth_boundary() {
    // `--bare` never reads OAuth or the keychain, so probing (and running)
    // through it reported `authRequired` for every subscription login.
    let mut probes = Vec::new();
    let status = installed_provider_status(
        ProviderId::Claude,
        &ClaudeProvider,
        PathBuf::from("claude"),
        |_, args, _| {
            probes.push(
                args.iter()
                    .map(|arg| (*arg).to_string())
                    .collect::<Vec<_>>(),
            );
            match args {
                ["--version"] => Ok("Claude Code fixture".into()),
                ["auth", "status"] => Ok("ordinary session is logged in".into()),
                _ => Err(format!("unexpected probe: {args:?}")),
            }
        },
    );

    assert_eq!(status.state, "ready");
    assert_eq!(probes, vec![vec!["--version"], vec!["auth", "status"]]);
}

fn endpoint_setting(endpoint: &str, api_key: &str, model: Option<&str>) -> ProviderSetting {
    let mut options = BTreeMap::new();
    options.insert(
        "endpoint".into(),
        crate::project::ProviderOption::String(endpoint.into()),
    );
    if !api_key.is_empty() {
        options.insert(
            "apiKey".into(),
            crate::project::ProviderOption::String(api_key.into()),
        );
    }
    ProviderSetting {
        enabled: true,
        model: model.map(str::to_string),
        options,
    }
}

#[test]
fn endpoint_providers_require_complete_settings_and_use_openai_resource_paths() {
    let openrouter = endpoint_setting(
        "https://openrouter.ai/api/v1/",
        "sk-or-test",
        Some("openai/gpt-test"),
    );
    assert!(compatible_setting_is_configured(
        ProviderId::Openrouter,
        &openrouter
    ));
    assert_eq!(
        compatible_resource_url(&openrouter, "chat/completions").unwrap(),
        "https://openrouter.ai/api/v1/chat/completions"
    );
    assert_eq!(
        compatible_resource_url(&openrouter, "models").unwrap(),
        "https://openrouter.ai/api/v1/models"
    );

    let no_key = endpoint_setting("https://openrouter.ai/api/v1", "", Some("model"));
    assert!(!compatible_setting_is_configured(
        ProviderId::Openrouter,
        &no_key
    ));
    assert!(compatible_setting_is_configured(ProviderId::Local, &no_key));
}

#[test]
fn openai_compatible_responses_expose_assistant_content() {
    let value = serde_json::json!({
        "choices": [{ "message": { "role": "assistant", "content": "{\"kind\":\"answer\",\"content\":\"Done\"}" } }]
    });
    assert_eq!(
        compatible_message_content(&value).unwrap(),
        r#"{"kind":"answer","content":"Done"}"#
    );

    let config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let body = compatible_chat_body(&config, "Create a scene", "test-model").unwrap();
    let system = body
        .pointer("/messages/0/content")
        .and_then(Value::as_str)
        .unwrap();
    assert!(system.contains("Look is the scene-wide visualStyle setting"));
    assert!(system.contains("Music is the scene.add or scene.set music field"));
}

#[test]
fn endpoint_credentials_are_removed_from_project_context() {
    let mut config: ProjectConfig =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    config.provider_settings.insert(
        "openrouter".into(),
        endpoint_setting(
            "https://openrouter.ai/api/v1",
            "secret-key",
            Some("openai/gpt-test"),
        ),
    );
    let clean = without_endpoint_provider_settings(config);
    assert!(!clean.provider_settings.contains_key("openrouter"));
    assert!(!serde_json::to_string(&clean)
        .unwrap()
        .contains("secret-key"));
}

#[test]
fn http_turn_cancels_while_waiting_for_a_response() {
    use std::{net::TcpListener, sync::mpsc, thread, time::Instant};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (accepted_tx, accepted_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        accepted_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
        drop(socket);
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let canceller = thread::spawn(move || {
        accepted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        flag.store(true, Ordering::Release);
    });
    let config =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let started = Instant::now();
    let result = run_compatible_endpoint(
        ProviderId::Local,
        &config,
        "Hello",
        &endpoint_setting(&endpoint, "", Some("model")),
        cancel,
        Duration::from_secs(20),
        &|_| {},
    );
    let _ = release_tx.send(());
    server.join().unwrap();
    canceller.join().unwrap();
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(started.elapsed() < Duration::from_secs(5));
}
