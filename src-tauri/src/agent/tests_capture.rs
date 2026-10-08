use super::{capture::*, protocol::parse_turn_result, types::*};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    io::Cursor,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

fn frame() -> CapturedFrame {
    let mut png = Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255]))
        .write_to(&mut png, image::ImageFormat::Png)
        .unwrap();
    CapturedFrame {
        png_base64: STANDARD.encode(png.into_inner()),
        time_ms: 1500.0,
        width: 2,
        height: 2,
    }
}

#[test]
fn capture_contract_is_read_only_and_requires_an_explicit_valid_time() {
    let parsed = parse_turn_result(r#"{"kind":"inspect","requests":[{"op":"timeline.capture","at":1.5},{"op":"generator.list"}]}"#).unwrap();
    assert!(matches!(parsed, AgentTurnResult::Inspect { requests } if requests.len() == 2));
    for request in [
        json!({"op":"timeline.capture"}),
        json!({"op":"timeline.capture","at":-1}),
        json!({"op":"timeline.capture","at":1,"path":"private.png"}),
    ] {
        assert!(
            parse_turn_result(&json!({"kind":"inspect","requests":[request]}).to_string()).is_err()
        );
    }
    assert!(parse_turn_result(
        "{\"op\":\"timeline.capture\",\"at\":1}\n{\"op\":\"commit\",\"summary\":\"Capture\"}"
    )
    .is_err());
}

#[test]
fn capture_bridge_matches_turns_and_discards_cancelled_or_invalid_replies() {
    let bridge = CaptureBridge::default();
    let cancel = AtomicBool::new(false);
    let result = bridge
        .request("one", 1.5, &cancel, |request| {
            assert!(bridge
                .complete(
                    "other".into(),
                    request.capture_id.clone(),
                    Some(frame()),
                    None
                )
                .is_err());
            bridge.complete(
                request.request_id,
                request.capture_id.clone(),
                Some(frame()),
                None,
            )?;
            assert!(bridge
                .complete("one".into(), request.capture_id, Some(frame()), None)
                .is_err());
            Ok(())
        })
        .unwrap();
    assert_eq!(result.time_ms, 1500.0);
    let result = bridge.request("one", 1.5, &cancel, |request| {
        let mut invalid = frame();
        invalid.width = 1537;
        bridge.complete(request.request_id, request.capture_id, Some(invalid), None)
    });
    assert!(result.unwrap_err().contains("oversized"));
    let mut pending = None;
    let result = bridge.request("one", 1.5, &cancel, |request| {
        pending = Some(request);
        cancel.store(true, Ordering::Release);
        Ok(())
    });
    assert!(result.unwrap_err().contains("cancelled"));
    let request = pending.unwrap();
    assert!(bridge
        .complete(request.request_id, request.capture_id, Some(frame()), None)
        .is_err());
    assert!(bridge
        .request("one", 1.5, &AtomicBool::new(false), |_| Err(
            "No window".into()
        ))
        .unwrap_err()
        .contains("No window"));
}

#[test]
fn cli_providers_receive_actual_images_and_codex_files_are_temporary() {
    use super::providers::{cli_provider_for, images::attach_cli_images};
    let config =
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
    let root = std::path::Path::new(".");
    let images = [frame()];
    let mut codex = cli_provider_for(ProviderId::Codex)
        .unwrap()
        .command_spec(root, root, &config, "Inspect", None)
        .unwrap();
    let files = attach_cli_images(ProviderId::Codex, &mut codex, &images)
        .unwrap()
        .unwrap();
    let path = files.path().join("timeline-1.png");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        images[0].png_bytes().unwrap()
    );
    assert!(codex.args.contains(&"--image".into()));
    assert_eq!(codex.args.last().unwrap(), "-");
    assert!(codex.stdin_payload.unwrap().contains("1.500 seconds"));
    drop(files);
    assert!(!path.exists());
    let mut claude = cli_provider_for(ProviderId::Claude)
        .unwrap()
        .command_spec(root, root, &config, "Inspect", None)
        .unwrap();
    assert!(attach_cli_images(ProviderId::Claude, &mut claude, &images)
        .unwrap()
        .is_none());
    assert!(claude.args.contains(&"--input-format".into()));
    let message: Value = serde_json::from_str(&claude.stdin_payload.unwrap()).unwrap();
    assert_eq!(message["type"], "user");
    assert_eq!(
        message["message"]["content"][2]["source"]["data"],
        images[0].png_base64
    );
}

#[test]
fn endpoint_receives_capture_and_keeps_it_on_validation_retries_without_project_writes() {
    let project = tempfile::tempdir().unwrap();
    let fixture = include_str!("../../../fixtures/project-v1-complete.json");
    let project_path = project.path().join("slopus.json");
    std::fs::write(&project_path, fixture).unwrap();
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", server.server_addr());
    let handle = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for result in [
            json!({"kind":"inspect","requests":[{"op":"timeline.capture","at":1.5}]}),
            json!({"kind":"answer","content":""}),
            json!({"kind":"answer","content":"The frame is red."}),
        ] {
            let mut request = server
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .expect("provider request");
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            bodies.push(serde_json::from_str::<Value>(&body).unwrap());
            request
                .respond(tiny_http::Response::from_string(
                    json!({"choices":[{"message":{"content":result.to_string()}}]}).to_string(),
                ))
                .unwrap();
        }
        bodies
    });
    let mut config: crate::project::ProjectConfig = serde_json::from_str(fixture).unwrap();
    config.provider_settings.insert("local".into(), serde_json::from_value(json!({"enabled":true,"model":"vision-model","options":{"endpoint":endpoint,"apiKey":"private-secret"}})).unwrap());
    let capture_count = std::cell::Cell::new(0);
    let result = super::AgentRuntime::default()
        .run_with_capture(
            AgentTurnRequest {
                request_id: "capture-turn".into(),
                scope: super::AgentScope::Project,
                folder_path: project.path().to_string_lossy().into(),
                provider: ProviderId::Local,
                prompt: "Look at 1.5 seconds".into(),
                config,
                conversation: vec![],
                generators: Default::default(),
            },
            |_| {},
            |at, _| {
                assert_eq!(at, 1.5);
                // The provider's failed final answer must reuse the capture, not render again.
                capture_count.set(capture_count.get() + 1);
                Ok(frame())
            },
        )
        .unwrap();
    assert!(matches!(result.result, AgentTurnResult::Answer { .. }));
    assert_eq!(capture_count.get(), 1);
    let bodies = handle.join().unwrap();
    assert!(bodies[0]["messages"][1]["content"].is_string());
    for body in &bodies[1..] {
        let content = &body["messages"][1]["content"];
        assert!(content[0]["text"]
            .as_str()
            .unwrap()
            .contains("start of this agent turn"));
        assert!(content[1]["text"]
            .as_str()
            .unwrap()
            .contains("1.500 seconds"));
        assert_eq!(
            content[2]["image_url"]["url"],
            format!("data:image/png;base64,{}", frame().png_base64)
        );
        assert!(!body.to_string().contains("private-secret"));
    }
    assert_eq!(std::fs::read_to_string(project_path).unwrap(), fixture);
}
