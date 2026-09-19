use super::{
    config::*, events::stage_name, ffi::RequestHandle, h3::*, planning::*, platform::*,
    references::ReferenceVideos, *,
};
use crate::project::{ProviderOption, ProviderSetting};
use std::collections::BTreeMap;

#[test]
fn animate_requires_video_and_prompt_mode_requires_text() {
    let mut configuration = Configuration::from_settings(&BTreeMap::new());
    let mut request = GenerationRequest::default();
    assert!(configuration
        .validate_inputs(&request)
        .unwrap_err()
        .contains("prompt"));
    configuration.animate = true;
    assert!(configuration
        .validate_inputs(&request)
        .unwrap_err()
        .contains("reference video"));
    request.reference_paths.push("image.png".into());
    assert!(configuration.validate_inputs(&request).is_err());
    request.reference_video_ids.push("video".into());
    configuration.validate_inputs(&request).unwrap();
    request.still_image = true;
    assert!(configuration
        .validate_inputs(&request)
        .unwrap_err()
        .contains("video generation"));
}

#[test]
fn animate_recipe_and_audio_selection_reach_bundled_dll() {
    let references = ReferenceVideos::default();
    let root = tempfile::tempdir().unwrap();
    let embedding = root.path().join("conditioning.safetensors");
    crate::conditioning::fixture(&embedding);
    let settings = BTreeMap::from([(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([
                (
                    "generationMode".into(),
                    ProviderOption::String("animate".into()),
                ),
                (
                    "promptEmbedding".into(),
                    ProviderOption::String(embedding.to_string_lossy().into_owned()),
                ),
                ("stepOverride".into(), ProviderOption::Number(4.0)),
            ]),
        },
    )]);
    let configuration = Configuration::from_settings(&settings);
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    let id = references.create_reference_video(2.0, &settings).unwrap();
    let result = (|| -> Result<(), String> {
        references.append_reference_video(&id, &vec![127; 64 * 64 * 4], 64, 64, 0.0)?;
        let request = GenerationRequest {
            job_id: "animate-test".into(),
            frames: 48,
            steps: 20,
            seed: 1,
            prompt: "This scene prompt must be ignored by Animate.".into(),
            canvas_width: 736,
            canvas_height: 416,
            reference_video_ids: vec![id.clone()],
            reference_paths: vec!["repainted.png".into()],
            ..Default::default()
        };
        for preserve_audio in [false, true] {
            if preserve_audio {
                references.set_reference_video_audio(&id, &vec![0; 32_000 * 2 * 4], 1, 32_000)?;
            }
            for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
                for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
                    let handle = RequestHandle::new(&api)?;
                    configure_request(
                        &api,
                        &handle,
                        &request,
                        &configuration,
                        platform,
                        purpose,
                        &references,
                    )?;
                    assert_eq!(api.resolve(&handle)?.num_model_evaluations, 3);
                    let description = api.describe(&handle)?;
                    assert!(description
                        .contains("fixed 362-token embedding; video then repainted image"));
                    assert!(description.contains("reference short edge 416"));
                    assert!(description.contains("video 1.000000 .. 0.600000 (shift 3.0)"));
                    assert!(description.contains(if preserve_audio {
                        "pinned driving soundtrack"
                    } else {
                        "generated; driving reference soundtrack omitted"
                    }));
                    assert!(description.contains(&format!(
                        "prompt              {} characters",
                        ANIMATE_PROMPT.len()
                    )));
                }
            }
        }
        Ok(())
    })();
    references.release_reference_videos(&[id]).unwrap();
    result.unwrap();
}

#[test]
fn animate_duration_limit_resolves_with_bundled_dll() {
    let references = ReferenceVideos::default();
    let root = tempfile::tempdir().unwrap();
    let embedding = root.path().join("conditioning.safetensors");
    crate::conditioning::fixture(&embedding);
    let settings = BTreeMap::new();
    let mut configuration = Configuration::from_settings(&settings);
    configuration.animate = true;
    configuration.prompt_embedding = Some(embedding);
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    let id = references.create_reference_video(15.0, &settings).unwrap();
    let result = (|| -> Result<(), String> {
        references.append_reference_video(&id, &vec![127; 64 * 64 * 4], 64, 64, 0.0)?;
        let mut request = GenerationRequest {
            prompt: "A dancer.".into(),
            steps: 4,
            seed: 1,
            canvas_width: 736,
            canvas_height: 416,
            reference_video_ids: vec![id.clone()],
            reference_paths: vec!["repainted.png".into()],
            ..Default::default()
        };
        for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
            for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
                for (frames, expected) in [
                    (48, 56),
                    (336, 345),
                    (345, 345),
                    (346, 345),
                    (348, 345),
                    (359, 345),
                    (360, 345),
                ] {
                    request.frames = frames;
                    let handle = RequestHandle::new(&api)?;
                    configure_request(
                        &api,
                        &handle,
                        &request,
                        &configuration,
                        platform,
                        purpose,
                        &references,
                    )?;
                    let plan = api.resolve(&handle)?;
                    assert_eq!(plan.aligned_frames, expected, "requested {frames} frames");
                    assert_eq!(plan.duration_seconds, f64::from(expected) / 24.0);
                    assert_eq!(
                        scene_frame_window(&request, plan.aligned_frames)?,
                        (0, expected)
                    );
                }
            }
        }
        request.frames = 361;
        let handle = RequestHandle::new(&api)?;
        configure_request(
            &api,
            &handle,
            &request,
            &configuration,
            ComputePlatform::Cuda13,
            RequestPurpose::Plan,
            &references,
        )?;
        assert!(api
            .resolve(&handle)
            .err()
            .unwrap()
            .contains("at most 15 seconds"));

        // Other generators keep their existing upward alignment at 15 s.
        configuration.animate = false;
        request.frames = 360;
        let handle = RequestHandle::new(&api)?;
        configure_request(
            &api,
            &handle,
            &request,
            &configuration,
            ComputePlatform::Cuda13,
            RequestPurpose::Plan,
            &references,
        )?;
        assert_eq!(api.resolve(&handle)?.aligned_frames, 362);
        Ok(())
    })();
    references.release_reference_videos(&[id]).unwrap();
    result.unwrap();
}

#[test]
fn animate_reports_missing_runtime_api() {
    let mut api = ffi::Api::load(&default_dll_path()).unwrap();
    api.disable_animate_for_test();
    let handle = RequestHandle::new(&api).unwrap();
    assert!(api.set_animate(&handle, true).unwrap_err().contains("1.10"));
}

#[test]
fn continuation_uses_22_frames_and_plans_only_the_new_scene() {
    let references = ReferenceVideos::default();
    // An independent 39-frame, 64x32 archive exercises the real DLL without
    // loading model weights. Its sampling window should be 22 + 34 frames.
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("previous.safetensors");
    let video_bytes = 24 * 96 * 4;
    let audio_bytes = 130 * 32 * 4;
    let mut header = serde_json::json!({
        "__metadata__": { "slopfab_latents": "h3-av-v1", "width": "64", "height": "32", "frames": "39", "fps": "24", "sampled": "1" },
        "video_rows": { "dtype": "F32", "shape": [24, 96], "data_offsets": [0, video_bytes] },
        "audio_rows": { "dtype": "F32", "shape": [130, 32], "data_offsets": [video_bytes, video_bytes + audio_bytes] },
    }).to_string();
    while header.len() % 8 != 0 {
        header.push(' ');
    }
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend_from_slice(header.as_bytes());
    bytes.resize(bytes.len() + video_bytes + audio_bytes, 0);
    std::fs::write(&path, bytes).unwrap();
    let mut request = GenerationRequest {
        job_id: "continued".into(),
        prompt: "The camera keeps moving.".into(),
        frames: 18,
        steps: 4,
        seed: 1,
        canvas_width: 64,
        canvas_height: 32,
        continuation_path: Some(path.clone()),
        save_latents_path: Some(root.path().join("next.safetensors")),
        ..Default::default()
    };
    let settings = BTreeMap::new();
    let configuration = Configuration::from_settings(&settings);
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
        let handle = RequestHandle::new(&api).unwrap();
        configure_request(
            &api,
            &handle,
            &request,
            &configuration,
            platform,
            RequestPurpose::Generate,
            &references,
        )
        .unwrap();
        let raw = api.resolve(&handle).unwrap();
        assert_eq!(raw.aligned_frames, 73);
        assert_eq!(raw.latent_frames, 17); // 56-frame window, including 22 overlap.
        assert_eq!(
            scene_frame_window(&request, raw.aligned_frames).unwrap(),
            (39, 34)
        );
    }
    let plan = resolve_plan(&request, &settings, &references).unwrap();
    assert_eq!(plan.aligned_frames, 34);
    assert!((plan.duration_seconds - 34.0 / 24.0).abs() < 1e-6);
    assert!(!request.save_latents_path.as_ref().unwrap().exists()); // Planning never writes.
    request.canvas_width = 128;
    assert!(resolve_plan(&request, &settings, &references).is_err());
    request.canvas_width = 64;
    std::fs::write(&path, b"invalid archive").unwrap();
    assert!(resolve_plan(&request, &settings, &references).is_err());
}

#[test]
fn continuation_video_and_audio_skip_the_cumulative_source() {
    let mut request = GenerationRequest {
        frames: 119,
        continuation_path: Some("source".into()),
        ..Default::default()
    };
    assert_eq!(scene_frame_window(&request, 243).unwrap(), (124, 119));
    // A further continuation skips the full joined source, not just its last scene.
    assert_eq!(scene_frame_window(&request, 362).unwrap(), (243, 119));
    assert_eq!(
        scene_audio_offset(124, 24.0, 2, 48_000, 972_000).unwrap(),
        496_000
    );
    assert_eq!(
        scene_audio_offset(243, 24.0, 2, 44_100, 2_000_000).unwrap(),
        893_026
    );
    assert_eq!(scene_audio_offset(124, 24.0, 0, 0, 0).unwrap(), 0);
    assert!(scene_audio_offset(124, 24.0, 2, 48_000, 100).is_err());
    assert!(scene_frame_window(&request, 120).is_err());
    request.continuation_path = None;
    assert_eq!(scene_frame_window(&request, 124).unwrap(), (0, 124));
}

#[test]
fn refmods_attach_for_plans_and_icons_or_report_an_older_dll() {
    let references = ReferenceVideos::default();
    let configuration = Configuration::from_settings(&BTreeMap::new());
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("person.safetensors");
    let header = serde_json::json!({
        "__metadata__": { "refmod_meta": serde_json::json!({ "kind": "image", "name": "Person", "_format_version": 4 }).to_string() },
        "latent": { "dtype": "F32", "shape": [1, 24, 1, 2, 2], "data_offsets": [0, 384] }
    }).to_string();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend_from_slice(header.as_bytes());
    for _ in 0..96 {
        bytes.extend_from_slice(&0.25_f32.to_le_bytes());
    }
    std::fs::write(&file, bytes).unwrap();
    let mut request = GenerationRequest {
        job_id: "refmod-test".into(),
        prompt: "A portrait.".into(),
        still_image: true,
        frames: 1,
        steps: 20,
        seed: 1,
        canvas_width: 768,
        canvas_height: 768,
        reference_paths: Vec::new(),
        reference_video_ids: Vec::new(),
        refmods: vec![RefmodInput {
            path: file.to_string_lossy().into_owned(),
            strength: 0.7,
            copies: 2,
        }],
        ..Default::default()
    };
    let probe = RequestHandle::new(&api).unwrap();
    let added = api.add_refmod(&probe, &file, 0.7, 2);
    if let Err(error) = &added {
        assert!(error.contains("does not support refmods"), "{error}");
        eprintln!(
            "Refmod export not yet available in the installed DLL; checked compatibility error."
        );
        assert!(configure_request(
            &api,
            &probe,
            &request,
            &configuration,
            ComputePlatform::Vulkan,
            RequestPurpose::Plan,
            &references
        )
        .unwrap_err()
        .contains("does not support refmods"));
    } else {
        for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
            for still_image in [false, true] {
                request.still_image = still_image;
                request.frames = if still_image { 1 } else { 120 };
                for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
                    let handle = RequestHandle::new(&api).unwrap();
                    configure_request(
                        &api,
                        &handle,
                        &request,
                        &configuration,
                        platform,
                        purpose,
                        &references,
                    )
                    .unwrap();
                    let plan = api.resolve(&handle).unwrap();
                    assert!(plan.aligned_frames >= request.frames);
                }
            }
        }
    }
    request.refmods[0].strength = 0.0;
    std::fs::remove_file(&file).unwrap();
    let handle = RequestHandle::new(&api).unwrap();
    configure_request(
        &api,
        &handle,
        &request,
        &configuration,
        ComputePlatform::Vulkan,
        RequestPurpose::Generate,
        &references,
    )
    .unwrap();
    request.refmods[0].copies = 11;
    assert!(configure_request(
        &api,
        &handle,
        &request,
        &configuration,
        ComputePlatform::Vulkan,
        RequestPurpose::Plan,
        &references
    )
    .is_err());
}

#[test]
fn motion_cache_reaches_cuda_and_vulkan_requests_and_changes_timing_profile() {
    let mut configuration = Configuration::from_settings(&BTreeMap::from([(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([("motionCache".into(), ProviderOption::Boolean(true))]),
        },
    )]));
    assert!(configuration.motion_cache);
    assert!(!Configuration::from_settings(&BTreeMap::new()).motion_cache);
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    let request = GenerationRequest {
        prompt: "A quiet harbour.".into(),
        frames: 120,
        steps: 20,
        seed: 1,
        canvas_width: 736,
        canvas_height: 416,
        ..Default::default()
    };
    for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
        let enabled_profile = configuration.timing_profile("test", platform);
        for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
            let handle = RequestHandle::new(&api).unwrap();
            configure_request(
                &api,
                &handle,
                &request,
                &configuration,
                platform,
                purpose,
                &ReferenceVideos::default(),
            )
            .unwrap();
            let description = api.describe(&handle).unwrap();
            assert!(description.contains("MotionCache"), "{description}");
            assert!(description.contains("threshold 0.150"), "{description}");
            api.set_motion_cache(&handle, false).unwrap();
            assert!(!api.describe(&handle).unwrap().contains("MotionCache"));
        }
        configuration.motion_cache = false;
        assert_ne!(
            enabled_profile,
            configuration.timing_profile("test", platform)
        );
        configuration.motion_cache = true;
    }
    configuration.animate = true;
    assert!(configuration
        .validate_inputs(&request)
        .unwrap_err()
        .contains("MotionCache is unavailable in Animate"));
}

#[test]
fn older_runtimes_work_with_motion_cache_off_and_explain_missing_support() {
    let mut api = ffi::Api::load(&default_dll_path()).unwrap();
    api.disable_motion_cache_for_test();
    let handle = RequestHandle::new(&api).unwrap();
    api.set_motion_cache(&handle, false).unwrap();
    assert!(api
        .set_motion_cache(&handle, true)
        .unwrap_err()
        .contains("does not support MotionCache"));
}

#[test]
fn ordered_loras_and_step_override_reach_cuda_and_vulkan_requests() {
    let references = ReferenceVideos::default();
    let root = tempfile::tempdir().unwrap();
    let paths = [
        root.path().join("style.safetensors"),
        root.path().join("TaoMate.safetensors"),
    ];
    for path in &paths {
        std::fs::write(path, b"planning does not load weights").unwrap();
    }
    let settings = BTreeMap::from([(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([
                (
                    "loras".into(),
                    ProviderOption::String(
                        serde_json::json!([
                            { "path": paths[0], "strength": -0.5 },
                            { "path": paths[1], "strength": 1.0 },
                        ])
                        .to_string(),
                    ),
                ),
                ("stepOverride".into(), ProviderOption::Number(8.0)),
            ]),
        },
    )]);
    let configuration = Configuration::from_settings(&settings);
    let api = ffi::Api::load(&configuration.dll_path).unwrap();
    let request = GenerationRequest {
        job_id: "lora-test".into(),
        prompt: "A quiet harbour.".into(),
        frames: 120,
        still_image: false,
        steps: 20,
        seed: 1,
        canvas_width: 736,
        canvas_height: 416,
        reference_paths: Vec::new(),
        reference_video_ids: Vec::new(),
        refmods: Vec::new(),
        ..Default::default()
    };
    for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
        for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
            let handle = RequestHandle::new(&api).unwrap();
            configure_request(
                &api,
                &handle,
                &request,
                &configuration,
                platform,
                purpose,
                &references,
            )
            .unwrap();
            assert_eq!(api.resolve(&handle).unwrap().num_model_evaluations, 7);
            let description = api.describe(&handle).unwrap();
            assert!(!description.contains("taomate-3step"));
            assert!(
                description.find("style.safetensors").unwrap()
                    < description.find("TaoMate.safetensors").unwrap()
            );
            assert!(description.contains("strength -0.5"));
        }
    }
    let invalid = BTreeMap::from([(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([(
                "loras".into(),
                ProviderOption::String("invalid JSON".into()),
            )]),
        },
    )]);
    assert!(Configuration::from_settings(&invalid).loras.is_err());
    std::fs::remove_file(&paths[0]).unwrap();
    let handle = RequestHandle::new(&api).unwrap();
    assert!(configure_request(
        &api,
        &handle,
        &request,
        &configuration,
        ComputePlatform::Vulkan,
        RequestPurpose::Generate,
        &references
    )
    .unwrap_err()
    .contains("LoRA file is missing"));
}

#[test]
fn vulkan_video_references_prepare_and_attach_for_planning_and_generation() {
    let references = ReferenceVideos::default();
    let settings = BTreeMap::from([(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([(
                "inferenceBackend".into(),
                ProviderOption::String("vulkan".into()),
            )]),
        },
    )]);
    let id = references.create_reference_video(2.0, &settings).unwrap();
    let result = (|| -> Result<(), String> {
        references.append_reference_video(&id, &vec![127; 64 * 64 * 4], 64, 64, 0.0)?;
        references.set_reference_video_audio(&id, &vec![0; 32_000 * 2 * 4], 1, 32_000)?;
        let request = GenerationRequest {
            job_id: "vulkan-reference-test".into(),
            prompt: "A scene using <Video 1>.".into(),
            frames: 120,
            still_image: false,
            steps: 12,
            seed: 1,
            canvas_width: 736,
            canvas_height: 416,
            reference_paths: Vec::new(),
            reference_video_ids: vec![id.clone()],
            refmods: Vec::new(),
            ..Default::default()
        };
        let configuration = Configuration::from_settings(&settings);
        let api = ffi::Api::load(&configuration.dll_path)?;
        for purpose in [RequestPurpose::Plan, RequestPurpose::Generate] {
            let handle = RequestHandle::new(&api)?;
            configure_request(
                &api,
                &handle,
                &request,
                &configuration,
                ComputePlatform::Vulkan,
                purpose,
                &references,
            )?;
            assert!(api.resolve(&handle)?.aligned_frames > 0);
        }
        Ok(())
    })();
    references.release_reference_videos(&[id]).unwrap();
    result.unwrap();
}

#[test]
fn video_reference_c_api_copies_inputs_and_retains_attached_snapshot() {
    let path = default_dll_path();
    let api = ffi::Api::load(&path).unwrap();
    let request = RequestHandle::new(&api).unwrap();
    api.set_prompt(&request, "A scene using <Video 1>.")
        .unwrap();
    api.set_frames(&request, 120).unwrap();
    api.set_resolution(&request, 736, 416).unwrap();
    let mut video =
        ffi::ReferenceVideoHandle::new(ffi::Api::load(&path).unwrap(), 2.0, path.clone()).unwrap();
    let pixels = vec![127_u8; 64 * 64 * 4];
    video.append(&pixels, 64, 64, 0.0).unwrap();
    assert!(video.append(&pixels, 64, 64, 0.0).is_err());
    assert!(video.append(&pixels[..10], 64, 64, 0.5).is_err());
    video.append(&pixels, 64, 64, 1.0).unwrap();
    video.set_audio(&vec![0.0; 32_000 * 2], 1, 32_000).unwrap();
    video.attach(&request, &path).unwrap();
    drop(video);
    drop(pixels);
    // Plan resolution reads the retained video/audio snapshot without a
    // neural model or a CUDA allocation, even after the host releases it.
    let plan = api.resolve(&request).unwrap();
    assert!(plan.aligned_frames > 0);
}

#[test]
fn absent_dll_is_an_explicit_disabled_state() {
    let mut settings = BTreeMap::new();
    settings.insert(
        "slopfab".into(),
        ProviderSetting {
            enabled: true,
            model: None,
            options: BTreeMap::from([(
                "dllPath".into(),
                ProviderOption::String("Z:/definitely-absent/slopfab.dll".into()),
            )]),
        },
    );
    let status = status(&settings);
    assert_eq!(status.state, "runtimeMissing");
}
#[test]
fn compatible_major_version_decodes_from_packed_value() {
    let packed = (1_u32 << 24) | (37 << 12) | 5;
    assert_eq!(packed >> 24, EXPECTED_CAPI_MAJOR);
}
#[test]
fn platform_selection_prefers_supported_cuda_majors_and_falls_back_to_vulkan() {
    assert_eq!(platform_from_cuda_probe(Ok(13)), ComputePlatform::Cuda13);
    assert_eq!(platform_from_cuda_probe(Ok(12)), ComputePlatform::Cuda12);
    assert_eq!(platform_from_cuda_probe(Ok(11)), ComputePlatform::Vulkan);
    assert_eq!(
        platform_from_cuda_probe(Err("no CUDA toolkit".into())),
        ComputePlatform::Vulkan
    );
    assert_eq!(ComputePlatform::Cuda13.backend(), 0);
    assert_eq!(ComputePlatform::Vulkan.backend(), 1);
}

#[test]
fn backend_preference_cannot_enable_cuda_without_cuda_hardware() {
    let mut config = Configuration::from_settings(&BTreeMap::new());
    assert_eq!(
        config.platform(ComputePlatform::Cuda13),
        ComputePlatform::Cuda13
    );
    assert_eq!(
        config.platform(ComputePlatform::Cuda12),
        ComputePlatform::Cuda12
    );
    assert_eq!(
        config.platform(ComputePlatform::Vulkan),
        ComputePlatform::Vulkan
    );
    config.vulkan = true;
    for detected in [
        ComputePlatform::Cuda13,
        ComputePlatform::Cuda12,
        ComputePlatform::Vulkan,
    ] {
        assert_eq!(config.platform(detected), ComputePlatform::Vulkan);
    }
}

#[test]
fn attention_defaults_to_sage_and_is_independent_of_backend() {
    assert_eq!(
        Configuration::from_settings(&BTreeMap::new()).attention,
        "sage2"
    );
    for backend in ["cuda", "vulkan"] {
        for attention in ["exact", "flash2", "sage2", "invalid"] {
            let settings = serde_json::from_value(serde_json::json!({
                "slopfab": { "enabled": true, "model": null,
                    "options": { "inferenceBackend": backend, "attention": attention } }
            }))
            .unwrap();
            let config = Configuration::from_settings(&settings);
            let expected = if attention == "invalid" {
                "sage2"
            } else {
                attention
            };
            assert_eq!(config.attention, expected);
            assert_eq!(config.vulkan, backend == "vulkan");
            assert!(config
                .timing_profile("1.4.0", ComputePlatform::Vulkan)
                .contains(&format!("attention={expected}|")));
        }
    }
}

#[test]
#[cfg(windows)]
fn bundled_dll_reports_a_compatible_api() {
    assert!(
        default_dll_path().is_file(),
        "The build must stage slopfab.dll beside the executable."
    );
    let runtime = status(&BTreeMap::new());
    assert_ne!(runtime.state, "runtimeMissing", "{}", runtime.detail);
    assert_ne!(runtime.state, "incompatible", "{}", runtime.detail);
    assert!(runtime
        .version
        .as_deref()
        .is_some_and(|value| value.starts_with("1.")));
    assert!(matches!(
        runtime.platform,
        Some("CUDA 13" | "CUDA 12" | "Vulkan")
    ));
}
#[test]
fn stage_ids_are_normalized_without_assuming_an_enum() {
    assert_eq!(stage_name(4), "denoising");
    assert_eq!(stage_name(99), "unknown");
}

#[test]
fn installed_dll_resolves_icons_as_one_still_frame_when_present() {
    let references = ReferenceVideos::default();
    if !default_dll_path().is_file() {
        return;
    }
    let request: GenerationRequest = serde_json::from_value(serde_json::json!({
        "jobId": "icon-plan", "prompt": "A red toy car", "frames": 1, "stillImage": true,
        "steps": 20, "seed": 1, "canvasWidth": 768, "canvasHeight": 768
    }))
    .unwrap();
    let plan = resolve_plan(&request, &BTreeMap::new(), &references).unwrap();
    assert_eq!(plan.aligned_frames, 1);
    assert_eq!(plan.latent_frames, 1);
    assert_eq!((plan.canvas_width, plan.canvas_height), (768, 768));
}

#[test]
fn bundled_dll_accepts_all_attention_modes_on_both_backends() {
    let references = ReferenceVideos::default();
    if !default_dll_path().is_file() {
        return;
    }
    let api = ffi::Api::load(&default_dll_path()).unwrap();
    let request: GenerationRequest = serde_json::from_value(serde_json::json!({
        "jobId": "attention-plan", "prompt": "A red toy car", "frames": 1, "stillImage": true,
        "steps": 20, "seed": 1, "canvasWidth": 768, "canvasHeight": 768
    }))
    .unwrap();
    let mut config = Configuration::from_settings(&BTreeMap::new());
    for platform in [ComputePlatform::Cuda13, ComputePlatform::Vulkan] {
        for attention in ["exact", "flash2", "sage2"] {
            config.attention = attention;
            let handle = RequestHandle::new(&api).unwrap();
            configure_request(
                &api,
                &handle,
                &request,
                &config,
                platform,
                RequestPurpose::Plan,
                &references,
            )
            .unwrap();
            assert_eq!(api.resolve(&handle).unwrap().aligned_frames, 1);
        }
    }
}
#[test]
fn generation_seed_accepts_random_and_non_negative_values() {
    assert!(generation_seed(-1).is_ok());
    assert_eq!(generation_seed(0).unwrap(), 0);
    assert_eq!(generation_seed(482_091).unwrap(), 482_091);
    assert!(generation_seed(-2).is_err());
}
