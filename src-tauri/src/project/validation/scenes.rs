use super::values::*;
use crate::project::paths::*;
use crate::project::*;
use std::collections::BTreeSet;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    validate_jobs(&mut config.generation_jobs)
}

fn validate_jobs(jobs: &mut [GenerationJob]) -> Result<(), String> {
    let mut previous_id = None;
    for job in jobs {
        validate_history(job)?;
        if job.generator_template_id.as_ref().is_some_and(|id| id.trim().is_empty()) { return Err("Scene generator template id cannot be empty.".into()); }
        if job.use_previous_scene_last_frame == Some(true)
            && matches!(job.scene_type.as_deref(), None | Some("first-last-frame")) {
            job.scene_type = Some("continue".into());
            job.continuation_scene_id = previous_id.clone();
            job.continuation_overlap_frames = Some(22);
            job.continuation_from = Some("end".into());
            job.use_previous_scene_last_frame = None;
        }
        previous_id = Some(job.id.clone());
        if job.ending_prompt.as_ref().is_some_and(|prompt| prompt.chars().count() > 30000) {
            return Err(format!("Scene '{}' has an ending prompt longer than 30000 characters.", job.id));
        }
        if job.continuation_scene_id.as_deref() == Some("")
            || job.continuation_strength.is_some_and(|strength| !strength.is_finite() || !(0.0..=0.99).contains(&strength))
            || job.continuation_from.as_deref().is_some_and(|value| !matches!(value, "start" | "end"))
            || job.continuation_overlap_frames.is_some_and(|frames| !(22..=362).contains(&frames) || frames % 17 != 5) {
            return Err(format!("Scene '{}' has invalid continuation settings. Overlap must be 22, 39, 56, … frames.", job.id));
        }
        if job.scene_type.as_deref().is_some_and(|value| {
            !matches!(
                value,
                "prompt" | "single-shot" | "first-last-frame" | "continue" | "animate" | "pose" | "character-replace" | "extend" | "bridge" | "backdrop" | "long-shot"
            )
        }) {
            return Err(format!("Scene '{}' has an unsupported scene type.", job.id));
        }
        if [job.bridge_left_margin, job.bridge_right_margin].iter().flatten().any(|margin| !(0..=340).contains(margin) || margin % 17 != 0) {
            return Err(format!("Scene '{}' has invalid Long Shot margins. Use multiples of 17 from 0 to 340 frames.", job.id));
        }
        if job.backdrop_color.as_deref().is_some_and(|value| !matches!(value, "green" | "blue" | "black" | "white")) {
            return Err(format!("Scene '{}' has an unsupported backdrop color.", job.id));
        }
        if [
            &job.start_video_reference_id,
            &job.end_video_reference_id,
            &job.pose_video_reference_id,
        ]
        .iter()
        .any(|id| id.as_deref() == Some(""))
        {
            return Err(format!(
                "Scene '{}' has an empty video reference id.",
                job.id
            ));
        }
        let limits = crate::generation::models::for_scene(job.provider_id.as_deref())
            .unwrap_or_else(crate::generation::models::default_model)
            .capabilities;
        let max_seconds = limits.max_scene_seconds;
        /* Normalise the scene BEFORE anything is judged, so both layers judge
        the same thing. An empty `shots` array collapses to no key at all —
        the same three-step tidy `normalize_shot_tags` performs, for the same
        reason: two builds must write the same bytes for the same scene. The
        ORDER of the shots is left exactly as given; the frontend orders them
        by start time when it reads them (`normalizeSceneShots`), and a layer
        that reordered on write would produce a spurious diff on every save.
        Both layers ACCEPT the same files either way, which is the contract. */
        if let Some(shots) = job.shots.as_mut() {
            let mut seen: BTreeSet<String> = BTreeSet::new();
            for shot in shots.iter_mut() {
                if [&shot.video_reference_id, &shot.character_reference_id]
                    .iter()
                    .any(|id| id.as_deref() == Some(""))
                {
                    return Err(format!("Shot '{}' has an empty reference id.", shot.id));
                }
                if shot.id.trim().is_empty() {
                    return Err(format!("Scene '{}' has a shot with an empty id.", job.id));
                }
                if !seen.insert(shot.id.clone()) {
                    return Err(format!(
                        "Scene '{}' has two shots with the id '{}'.",
                        job.id, shot.id
                    ));
                }
                if shot.name.as_deref().is_some_and(str::is_empty) {
                    return Err(format!(
                        "Shot '{}' in scene '{}' has an empty name.",
                        shot.id, job.id
                    ));
                }
                if !shot.start_seconds.is_finite()
                    || !(0.0..=max_seconds).contains(&shot.start_seconds)
                {
                    return Err(format!(
                        "Shot '{}' in scene '{}' starts at {} seconds, outside the 0-{max_seconds} second scene.",
                        shot.id, job.id, shot.start_seconds
                    ));
                }
                shot.settings = normalize_shot_tags(shot.settings.take())
                    .map_err(|reason| format!("Shot '{}' {reason}", shot.id))?;
            }
        }
        if job.shots.as_ref().is_some_and(|shots| shots.is_empty()) {
            job.shots = None;
        }
        if let Some(seconds) = job.duration_seconds {
            if !seconds.is_finite() || !(0.0..=max_seconds).contains(&seconds) {
                return Err(format!(
                    "Scene '{}' is {seconds} seconds long, outside the 0-{max_seconds} second range.",
                    job.id
                ));
            }
        }
        if job.steps.is_some_and(|steps| steps < limits.min_steps) {
            return Err(format!(
                "Scene '{}' must use at least {} generation steps.",
                job.id, limits.min_steps
            ));
        }
        if job.audio_steps.is_some_and(|steps| !(2..=1_000_000).contains(&steps)) {
            return Err(format!("Scene '{}' must use 2 to 1000000 audio steps.", job.id));
        }
        if let Some(effects) = &job.generation_effects { effects.validate()?; }
        for shift in [job.video_sigma_shift, job.audio_sigma_shift].into_iter().flatten() {
            if !shift.is_finite() || shift < f32::from_bits(1) as f64 || shift > f32::MAX as f64 {
                return Err(format!("Scene '{}' sigma shifts must be finite, positive float32 values.", job.id));
            }
        }
        if job.seed.is_some_and(|seed| seed < -1) {
            return Err(format!("Scene '{}' has a seed below -1.", job.id));
        }
        if job.seed.is_some_and(|seed| seed > 9_007_199_254_740_991) {
            return Err(format!(
                "Scene '{}' has a seed too large to preserve exactly.",
                job.id
            ));
        }
        // Blank is the same as unset for both of these; the compiler falls back
        // to its own line, and writing `""` would be a key zod has to tolerate
        // for no gain.
        for field in [&mut job.soundscape, &mut job.music] {
            if field.as_deref().is_some_and(|text| text.trim().is_empty()) {
                *field = None;
            }
        }
        /* The words live in ONE of two places. A scene keeps them on its shots,
        so `prompt` and `creativeBrief` are only its mirror and may be blank;
        a job with no shots — every project written before scenes existed —
        keeps them here, where blank would mean the user's words were lost.
        `generationJobSchema.superRefine` in src/lib/project.ts is this rule. */
        let has_shots = job.shots.as_ref().is_some_and(|shots| !shots.is_empty());
        if job.id.trim().is_empty()
            || job.title.trim().is_empty()
            || (!has_shots
                && (job.prompt.trim().is_empty() || job.creative_brief.trim().is_empty()))
        {
            return Err(
                "Generation job id, title, prompt, and creative brief cannot be empty.".into(),
            );
        }
        if !matches!(
            job.status.as_str(),
            "draft" | "queued" | "generating" | "ready" | "completed" | "failed" | "cancelled"
        ) {
            return Err(format!(
                "Unsupported generation job status '{}'.",
                job.status
            ));
        }
        if !matches!(
            job.stage.as_str(),
            "queued" | "preparing" | "generating" | "encoding" | "completed" | "failed"
        ) || !(0.0..=1.0).contains(&job.progress)
        {
            return Err(format!(
                "Invalid generation stage or progress for job '{}'.",
                job.id
            ));
        }
        if job
            .provider_id
            .as_deref()
            .is_some_and(|provider_id| provider_id.is_empty())
        {
            return Err(format!(
                "Generation job '{}' cannot have an empty provider id.",
                job.id
            ));
        }
        if job
            .error
            .as_deref()
            .is_some_and(|message| message.is_empty())
        {
            return Err(format!(
                "Generation job '{}' cannot have an empty error message.",
                job.id
            ));
        }
        check_iso_datetime(
            &format!("Generation job '{}' createdAt", job.id),
            &job.created_at,
        )?;
        check_iso_datetime(
            &format!("Generation job '{}' updatedAt", job.id),
            &job.updated_at,
        )?;
        job.shot_tags = normalize_shot_tags(job.shot_tags.take())
            .map_err(|reason| format!("Generation job '{}' {reason}", job.id))?;
        job.output_relative_path = job
            .output_relative_path
            .as_deref()
            .map(normalize_project_path)
            .transpose()?;
        job.latent_relative_path = job
            .latent_relative_path
            .as_deref()
            .map(normalize_project_path)
            .transpose()?;
    }
    Ok(())
}


fn validate_input(input: &serde_json::Value) -> Result<(), String> {
    let object = input.as_object().ok_or("Scene history inputs must be an object.")?;
    if ["title", "prompt", "creativeBrief"].iter().any(|key| !input[*key].is_string()) || !object.contains_key("providerId") {
        return Err("Scene history inputs need their title, prompts and provider.".into());
    }
    if ["generationHistory", "id", "status", "stage", "progress", "outputRelativePath", "latentRelativePath", "clipId", "generationSnapshot", "error", "createdAt", "updatedAt"]
        .iter().any(|key| object.contains_key(*key)) { return Err("Scene history inputs cannot contain identity, outputs or nested history.".into()); }
    // Reuse the current scene validator, including future model controls.
    let draft = GenerationJob::draft("history-input", "History", "2026-01-01T00:00:00.000Z", crate::generation::models::default_model().defaults);
    let mut value = serde_json::to_value(draft).map_err(|e| e.to_string())?;
    value.as_object_mut().unwrap().extend(object.clone());
    let mut job: GenerationJob = serde_json::from_value(value).map_err(|e| format!("Invalid scene history input: {e}"))?;
    validate_jobs(std::slice::from_mut(&mut job))
}

fn validate_history(job: &mut GenerationJob) -> Result<(), String> {
    let Some(history) = &mut job.generation_history else { return Ok(()); };
    let mut ids = BTreeSet::new();
    for version in &mut history.versions {
        if version.id.trim().is_empty() || !ids.insert(version.id.clone()) { return Err("Scene generation IDs must be nonempty and unique.".into()); }
        check_iso_datetime("Scene generation createdAt", &version.created_at)?;
        validate_input(&version.scene)?;
        let media = &mut version.media;
        if media.kind != "generated" || media.mime_type != "video/mp4" || media.id.trim().is_empty() || media.name.trim().is_empty()
            || media.source_path.is_some() || media.motion.is_some() || media.image_generation.is_some() || media.image_editing.is_some()
            || media.width == Some(0) || media.height == Some(0) || media.duration_ms == Some(0) {
            return Err("Scene generations require a saved video asset.".into());
        }
        check_iso_datetime("Scene generation media createdAt", &media.created_at)?;
        media.relative_path = Some(normalize_project_path(media.relative_path.as_deref().ok_or("Scene generation video path is missing.")?)?);
        version.latent_relative_path = version.latent_relative_path.as_deref().map(normalize_project_path).transpose()?;
        if let Some(segments) = &mut media.scene_segments {
            let mut end = 0u64;
            for segment in segments {
                if segment.scene_id.trim().is_empty() || segment.frame_count == 0 || u64::from(segment.start_frame) < end { return Err("Invalid scene generation segment.".into()); }
                segment.latent_relative_path = normalize_project_path(&segment.latent_relative_path)?;
                end = u64::from(segment.start_frame) + u64::from(segment.frame_count);
            }
        }
    }
    if [&history.primary_id, &history.selected_id].iter().any(|id| id.as_ref().is_some_and(|id| !ids.contains(id))) {
        return Err("Scene history selection must name a saved generation.".into());
    }
    if let Some(draft) = &history.draft { validate_input(draft)?; }
    Ok(())
}


#[cfg(test)]
mod history_tests {
    use super::*;
    #[test]
    fn single_shot_fields_survive_native_project_roundtrip() {
        let mut config: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        config.generation_jobs[0].scene_type = Some("single-shot".into());
        config.generation_jobs[0].ending_prompt = Some("@[ref:hero] waves goodbye".into());
        config.generation_jobs[0].continuation_scene_id = Some("start".into());
        config.generation_jobs[0].continuation_strength = Some(0.65);
        validate(&mut config).unwrap();
        let restored: ProjectConfig = serde_json::from_slice(&serde_json::to_vec(&config).unwrap()).unwrap();
        assert_eq!(restored.generation_jobs[0].ending_prompt, config.generation_jobs[0].ending_prompt);
        assert_eq!(restored.generation_jobs[0].scene_type.as_deref(), Some("single-shot"));
        assert_eq!(restored.generation_jobs[0].continuation_scene_id.as_deref(), Some("start"));
        assert_eq!(restored.generation_jobs[0].continuation_strength, Some(0.65));
        config.generation_jobs[0].continuation_strength = Some(1.0);
        assert!(validate(&mut config).is_err());
    }
    fn project_with_history() -> ProjectConfig {
        let mut config: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let job = &mut config.generation_jobs[0];
        let mut input = serde_json::to_value(&job).unwrap();
        for key in ["id", "status", "stage", "progress", "generationSnapshot", "clipId", "outputRelativePath", "latentRelativePath", "error", "createdAt", "updatedAt"] { input.as_object_mut().unwrap().remove(key); }
        job.generator_template_id = Some("generator-original".into());
        job.generation_history = Some(SceneGenerationHistory {
            versions: vec![SceneGenerationVersion { id: "take-one".into(), created_at: job.created_at.clone(), scene: input.clone(),
                media: config.assets.iter().find(|a| a.kind == "generated").unwrap().clone(), generation_snapshot: Some("saved-inputs".into()), latent_relative_path: Some("latents/one.safetensors".into()) }],
            primary_id: Some("take-one".into()), selected_id: None, draft: Some(input),
        });
        config
    }
    #[test]
    fn scene_history_and_draft_round_trip_without_a_four_take_schema_limit() {
        let mut config = project_with_history();
        let history = config.generation_jobs[0].generation_history.as_mut().unwrap();
        let version = history.versions[0].clone();
        for i in 2..=6 { let mut take = version.clone(); take.id = format!("take-{i}"); history.versions.push(take); }
        validate(&mut config).unwrap();
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["generationJobs"][0]["generationHistory"]["versions"].as_array().unwrap().len(), 6);
        let mut restored: ProjectConfig = serde_json::from_value(json).unwrap(); validate(&mut restored).unwrap();
        assert_eq!(restored.generation_jobs[0].generation_history, config.generation_jobs[0].generation_history);
        assert_eq!(restored.generation_jobs[0].generator_template_id.as_deref(), Some("generator-original"));
    }
    #[test]
    fn history_rejects_unsafe_paths_invalid_settings_and_nested_history() {
        for kind in ["path", "settings", "nested", "selection", "duplicate"] {
            let mut config = project_with_history();
            let history = config.generation_jobs[0].generation_history.as_mut().unwrap();
            match kind {
                "path" => history.versions[0].media.relative_path = Some("../outside.mp4".into()),
                "settings" => history.versions[0].scene["steps"] = serde_json::json!(-1),
                "nested" => history.versions[0].scene["generationHistory"] = serde_json::json!({}),
                "selection" => history.selected_id = Some("missing".into()),
                _ => history.versions.push(history.versions[0].clone()),
            }
            assert!(validate(&mut config).is_err(), "{kind}");
        }
    }
}
