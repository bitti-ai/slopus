use super::{generators::*, protocol::parse_turn_result, types::*, weights};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::atomic::AtomicBool};

fn tensor_file(path: &Path, key: &str) {
    let header = json!({key:{"dtype":"F32","shape":[1],"data_offsets":[0,4]},"__metadata__":{"architecture":"test-model"}}).to_string();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header.as_bytes());
    bytes.extend([0; 4]);
    fs::write(path, bytes).unwrap();
}

fn command(value: Value) -> GeneratorCommand {
    serde_json::from_value(value).unwrap()
}

#[test]
fn scans_headers_recursively_and_keeps_ambiguous_weights_unassigned() {
    let dir = tempfile::tempdir().unwrap();
    let child = dir.path().join("weights with spaces");
    fs::create_dir(&child).unwrap();
    tensor_file(
        &child.join("adapter.safetensors"),
        "diffusion.blocks.0.lora_A.weight",
    );
    tensor_file(&child.join("unknown.safetensors"), "encoder.weight");
    tensor_file(&child.join("audio_vae.safetensors"), "encoder.weight");
    fs::write(child.join("tokenizer.json"), "{}").unwrap();
    fs::write(child.join("opaque.bin"), "not a pickle to execute").unwrap();
    fs::write(child.join("ignored.txt"), "SECRET must not be read").unwrap();
    let result = weights::scan(dir.path().to_str().unwrap(), &AtomicBool::new(false)).unwrap();
    let files = result["files"].as_array().unwrap();
    assert_eq!(files.len(), 4);
    let adapter = files
        .iter()
        .find(|f| f["path"].as_str().unwrap().ends_with("adapter.safetensors"))
        .unwrap();
    assert_eq!(adapter["roleHints"], json!(["lora"]));
    assert_eq!(adapter["header"]["tensors"][0]["shape"], json!([1]));
    assert_eq!(adapter["header"]["tensorCount"], 1);
    assert_eq!(result["tokenizerDirectories"].as_array().unwrap().len(), 1);
    assert!(!result.to_string().contains("SECRET"));
    assert!(files
        .iter()
        .find(|f| f["path"].as_str().unwrap().ends_with("unknown.safetensors"))
        .unwrap()["roleHints"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(weights::scan("relative", &AtomicBool::new(false)).is_err());
    assert!(
        weights::scan(dir.path().to_str().unwrap(), &AtomicBool::new(true))
            .unwrap_err()
            .contains("cancelled")
    );
}

#[test]
fn malformed_headers_are_reported_without_loading_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("bad.safetensors");
    let mut budget = u64::MAX;
    fs::write(&path, u64::MAX.to_le_bytes()).unwrap();
    assert!(weights::inspect(&path, &mut budget)
        .unwrap()
        .get("inspectionError")
        .is_some());
    tensor_file(&path, "weight");
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(fs::metadata(&path).unwrap().len() - 1)
        .unwrap();
    assert!(
        weights::inspect(&path, &mut budget).unwrap()["inspectionError"]
            .as_str()
            .unwrap()
            .contains("offsets")
    );
}

#[test]
fn command_batches_preserve_other_settings_and_are_atomic() {
    let add = command(
        json!({"op":"generator.add","id":"custom","settings":{"name":"Custom","paths":{"transformer":"https://example.com/model.safetensors"}}}),
    );
    let mut context = prepare(&GeneratorContext::default(), &[add.clone()]).unwrap();
    context.settings["templates"][0]["sources"] = json!({"transformer":[{"url":"https://example.com/model.safetensors","gpuModel":"","minVramGb":0}],"audioVae":[{"url":"https://example.com/audio.bin"}]});
    context.settings["templates"][0]["additionalSafetensors"] =
        json!([{"id":"conditioning","url":"https://example.com/fixed.safetensors"}]);
    let original = context.settings.clone();
    let edit = command(
        json!({"op":"generator.set","id":"custom","settings":{"name":"Renamed","paths":{"transformer":""}}}),
    );
    let changed = prepare(&context, &[edit.clone()]).unwrap();
    assert_eq!(changed.settings["templates"][0]["name"], "Renamed");
    assert_eq!(changed.settings["templates"][0]["defaultSteps"], 20);
    assert!(changed.settings["templates"][0]["sources"]
        .get("transformer")
        .is_none());
    assert_eq!(
        changed.settings["templates"][0]["sources"]["audioVae"],
        original["templates"][0]["sources"]["audioVae"]
    );
    assert_eq!(
        changed.settings["templates"][0]["additionalSafetensors"],
        original["templates"][0]["additionalSafetensors"]
    );
    assert!(prepare(&context, &[edit, add]).is_err());
    assert_eq!(context.settings, original);
    let info = read(
        &context,
        &GeneratorRead::Get {
            id: "custom".into(),
        },
        &AtomicBool::new(false),
    )
    .unwrap();
    assert_eq!(info["paths"]["transformer"]["state"], "downloadUrl");
    assert!(read(
        &context,
        &GeneratorRead::Get {
            id: "missing".into()
        },
        &AtomicBool::new(false)
    )
    .is_err());
}

#[test]
fn validates_roles_paths_ranges_and_lora_registration() {
    let dir = tempfile::tempdir().unwrap();
    let lora = dir.path().join("adapter.safetensors");
    tensor_file(&lora, "blocks.0.lora_down.weight");
    for settings in [
        json!({"name":"Bad","defaultSteps":1}),
        json!({"name":"Bad","attention":"imaginary"}),
        json!({"name":"Bad","modelType":"unrelated"}),
        json!({"name":"Bad","paths":{"unknown":""}}),
        json!({"name":"Bad","paths":{"transformer":"relative.bin"}}),
        json!({"name":"Bad","paths":{"transformer":lora}}),
    ] {
        let add = command(json!({"op":"generator.add","id":"bad","settings":settings}));
        assert!(prepare(&GeneratorContext::default(), &[add]).is_err());
    }
    let registered = prepare(&GeneratorContext::default(),&[
        command(json!({"op":"generator.lora.add","id":"adapter","name":"Adapter","path":lora,"stepOverride":4})),
        command(json!({"op":"generator.add","id":"custom","settings":{"name":"Custom","loras":[{"loraId":"adapter","enabled":true,"strength":0.8}]}})),
    ]).unwrap();
    assert_eq!(registered.loras[0]["needsPreparation"], true);
    assert_eq!(
        registered.settings["templates"][0]["loras"][0]["loraId"],
        "adapter"
    );
    assert!(prepare(
        &registered,
        &[command(
            json!({"op":"generator.set","id":"custom","settings":{},"makeDefault":true})
        )]
    )
    .is_err());
}

#[test]
fn parses_generator_contract_and_rejects_unknown_fields() {
    assert!(matches!(
        parse_turn_result(r#"{"kind":"inspect","requests":[{"op":"generator.list"}]}"#).unwrap(),
        AgentTurnResult::Inspect { .. }
    ));
    let raw = r#"{"kind":"generatorCommands","summary":"Created","commands":[{"op":"generator.add","id":"a","settings":{"name":"A"}}]}"#;
    assert!(matches!(
        parse_turn_result(raw).unwrap(),
        AgentTurnResult::GeneratorCommands { .. }
    ));
    assert!(parse_turn_result(&raw.replace("\"name\":\"A\"", "\"apiKey\":\"secret\"")).is_err());
    assert!(parse_turn_result(r#"{"kind":"inspect","requests":[]}"#).is_err());
    assert!(
        parse_turn_result(r#"{"kind":"generatorCommands","summary":"Empty","commands":[]}"#)
            .is_err()
    );
    assert!(parse_turn_result(r#"{"kind":"inspect","requests":[{"op":"generator.scan","folder":"D:/weights","execute":true}]}"#).is_err());
}

#[test]
fn endpoint_turn_inspects_weights_then_corrects_and_returns_generator_commands() {
    use crate::project::{ProjectConfig, ProviderOption, ProviderSetting};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };
    let dir = tempfile::tempdir().unwrap();
    let fixture = include_str!("../../../fixtures/project-v1-complete.json");
    fs::write(
        dir.path().join(crate::project::storage::PROJECT_FILE_NAME),
        fixture,
    )
    .unwrap();
    tensor_file(
        &dir.path().join("minimax_h3.safetensors"),
        "blocks.0.weight",
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let folder = dir.path().to_string_lossy().to_string();
    let server = thread::spawn(move || {
        let mut bodies = Vec::new();
        for reply in [
            json!({"kind":"inspect","requests":[{"op":"generator.scan","folder":folder}]}),
            json!({"kind":"generatorCommands","summary":"Invalid","commands":[{"op":"generator.add","id":"new","settings":{"name":"New","defaultSteps":1}}]}),
            json!({"kind":"generatorCommands","summary":"Created","commands":[{"op":"generator.add","id":"new","settings":{"name":"New","defaultSteps":20}}]}),
        ] {
            let started = std::time::Instant::now();
            let (mut socket, _) = loop {
                match listener.accept() {
                    Ok(socket) => break socket,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            started.elapsed() < Duration::from_secs(10),
                            "Timed out awaiting provider request"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
                assert!(!line.is_empty());
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            bodies.push(serde_json::from_slice::<Value>(&bytes).unwrap());
            let body =
                json!({"choices":[{"message":{"role":"assistant","content":reply.to_string()}}]})
                    .to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
        bodies
    });
    let mut config: ProjectConfig = serde_json::from_str(fixture).unwrap();
    config.provider_settings.insert(
        "local".into(),
        ProviderSetting {
            enabled: true,
            model: Some("test-model".into()),
            options: std::collections::BTreeMap::from([
                ("endpoint".into(), ProviderOption::String(endpoint)),
                (
                    "apiKey".into(),
                    ProviderOption::String("private-secret".into()),
                ),
            ]),
        },
    );
    let request = AgentTurnRequest {
        request_id: "generator-test".into(),
        folder_path: dir.path().to_string_lossy().into(),
        provider: ProviderId::Local,
        prompt: "Inspect this folder and create a generator".into(),
        config,
        conversation: vec![],
        generators: GeneratorContext::default(),
    };
    let response = super::AgentRuntime::default().run(request, |_| {}).unwrap();
    assert!(matches!(
        response.result,
        AgentTurnResult::GeneratorCommands { .. }
    ));
    assert!(response
        .events
        .iter()
        .any(|event| matches!(event, AgentEvent::Validation { .. })));
    let bodies = server.join().unwrap();
    for body in &bodies[1..] {
        let prompt = body["messages"][1]["content"].as_str().unwrap();
        assert!(prompt.contains("minimax_h3.safetensors"));
        assert!(prompt.contains("tensorCount"));
        assert!(!prompt.contains("private-secret"));
    }
    assert!(bodies[2].to_string().contains("defaultSteps must be"));
    // Inspection and provider validation never write settings or the project.
    assert_eq!(
        fs::read_to_string(dir.path().join(crate::project::storage::PROJECT_FILE_NAME)).unwrap(),
        fixture
    );
}
