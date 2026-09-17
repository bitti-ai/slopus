use crate::project::*;
use std::collections::BTreeSet;
use crate::project::reference_tokens::action_reference_ids;

/** Agent-only semantic checks. The project validator intentionally permits
 * blank references and free-form action text because the editor must be able
 * to save unfinished user work. An agent claiming to have planned a scene has
 * a stronger contract: references it creates are complete, citations compile,
 * and spoken lines use the Speech fields the UI exposes. Failures flow through
 * the normal correction loop, so the model gets three chances to repair them. */
pub(crate) fn validate_agent_scene_conventions(
    before: &ProjectConfig,
    next: &ProjectConfig,
) -> Result<(), String> {
    let new_reference_ids = next
        .references
        .iter()
        .filter(|reference| {
            !before
                .references
                .iter()
                .any(|existing| existing.id == reference.id)
        })
        .map(|reference| reference.id.as_str())
        .collect::<BTreeSet<_>>();

    for reference in next
        .references
        .iter()
        .filter(|reference| new_reference_ids.contains(reference.id.as_str()))
    {
        if reference.kind != "text" {
            return Err(format!(
                "Agent-created reference '{}' must be a text reference. Do not invent a file-backed reference or file path.",
                reference.id
            ));
        }
        let definition = reference
            .content
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(reference.description.as_str());
        if definition.trim().is_empty() {
            return Err(format!(
                "Agent-created reference '{}' needs a complete visual description before it is used in shots.",
                reference.id
            ));
        }
        if reference.intended_use.is_empty() {
            return Err(format!(
                "Agent-created reference '{}' needs an intendedUse such as character, animal, location, or product.",
                reference.id
            ));
        }
    }

    let mut cited_new_references = BTreeSet::new();
    let mut changed_scene = false;
    for job in &next.generation_jobs {
        let before_job = before
            .generation_jobs
            .iter()
            .find(|existing| existing.id == job.id);
        let changed = before_job.is_none_or(|existing| existing != job);
        if !changed {
            continue;
        }
        let Some(shots) = &job.shots else {
            continue;
        };
        changed_scene = true;
        let model = crate::generation::models::for_scene(job.provider_id.as_deref());
        let duration = job.duration_seconds.unwrap_or_else(|| model.unwrap_or_else(crate::generation::models::default_model).defaults.duration_seconds);
        if shots.first().is_none_or(|shot| shot.start_seconds != 0.0) {
            return Err(format!(
                "Scene '{}' must have a first shot that starts at 0 seconds.",
                job.id
            ));
        }
        for pair in shots.windows(2) {
            if pair[1].start_seconds <= pair[0].start_seconds {
                return Err(format!(
                    "Shot '{}' in scene '{}' must start after the preceding shot.",
                    pair[1].id, job.id
                ));
            }
        }
        if let Some(shot) = shots
            .iter()
            .skip(1)
            .find(|shot| shot.start_seconds >= duration)
        {
            return Err(format!(
                "Shot '{}' in scene '{}' must start before the scene ends at {duration} seconds.",
                shot.id, job.id
            ));
        }
        let earliest_shot_id = shots
            .iter()
            .min_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds))
            .map(|shot| shot.id.as_str())
            .unwrap_or_default();
        for shot in shots {
            let before_shot = before_job
                .and_then(|existing| existing.shots.as_ref())
                .and_then(|existing| existing.iter().find(|candidate| candidate.id == shot.id));
            if let Some(model) = model { (model.validate_shot_settings)(before_shot, shot, earliest_shot_id)?; }
            if action_contains_dialogue(&shot.action) {
                return Err(format!(
                    "Shot '{}' in scene '{}' contains dialogue in action. Keep action visual-only and move the exact spoken words into shot.speech with shot.speechLanguage.",
                    shot.id, job.id
                ));
            }
            if shot
                .speech
                .as_deref()
                .is_some_and(|speech| !speech.trim().is_empty())
                && shot.speech_language.is_none()
            {
                return Err(format!(
                    "Shot '{}' in scene '{}' has speech but no speechLanguage. Keep the spoken line in shot.speech and set its language.",
                    shot.id, job.id
                ));
            }
            for reference_id in action_reference_ids(&shot.action)? {
                let reference = next
                    .references
                    .iter()
                    .find(|reference| reference.id == reference_id)
                    .ok_or_else(|| {
                        format!(
                            "Shot '{}' cites unknown reference '{}'. Create the reference first or remove the citation.",
                            shot.id, reference_id
                        )
                    })?;
                if !job.reference_ids.iter().any(|id| id == reference_id) {
                    return Err(format!(
                        "Shot '{}' cites reference '{}', but scene '{}' does not include it in referenceIds.",
                        shot.id, reference_id, job.id
                    ));
                }
                if reference.kind == "text"
                    && reference.images.is_empty()
                    && reference.description.trim().is_empty()
                    && reference
                        .content
                        .as_deref()
                        .is_none_or(|content| content.trim().is_empty())
                {
                    return Err(format!(
                        "Shot '{}' cites text reference '{}', but that reference has no visual description.",
                        shot.id, reference_id
                    ));
                }
                if new_reference_ids.contains(reference_id) {
                    cited_new_references.insert(reference_id);
                }
            }
        }
    }

    if changed_scene {
        for reference in next.references.iter().filter(|reference| {
            new_reference_ids.contains(reference.id.as_str())
                && reference
                    .intended_use
                    .iter()
                    .any(|usage| matches!(usage.as_str(), "character" | "animal" | "location" | "product"))
        }) {
            if !cited_new_references.contains(reference.id.as_str()) {
                return Err(format!(
                    "Agent-created {} reference '{}' is not used by any changed shot. Cite it in shot.action as '@[ref:{}]' and include it in the scene's referenceIds.",
                    reference.intended_use[0], reference.id, reference.id
                ));
            }
        }
    }
    Ok(())
}


fn action_contains_dialogue(action: &str) -> bool {
    let lower = action.to_lowercase();
    if [
        "<d>",
        "</d>",
        "dialogue:",
        "dialog:",
        "speech:",
        "voice-over:",
        "voiceover:",
        "narration:",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    let quoted = action.contains('"') || action.contains('“') || action.contains('”');
    quoted
        && [
            " says",
            " asks",
            " replies",
            " shouts",
            " whispers",
            " narrates",
        ]
        .iter()
        .any(|cue| lower.contains(cue))
}
