use super::values::*;
use crate::project::paths::*;
use crate::project::*;
use std::collections::BTreeSet;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    for job in &mut config.generation_jobs {
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
