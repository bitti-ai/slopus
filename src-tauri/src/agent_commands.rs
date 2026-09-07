use crate::{
    validate_and_normalize_config, GenerationJob, ProjectAsset, ProjectConfig, ReusableReference,
    SceneShot, TimelineClip,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_COMMANDS_PER_TURN: usize = 100;

/**
 * The provider-facing command vocabulary. It deliberately contains only fields
 * an agent is allowed to author. File locations, generated output, provider
 * settings, project identity, progress, and render state have no representation
 * here, so they cannot be changed accidentally or smuggled through a patch.
 */
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum ProjectCommand {
    #[serde(rename = "project.set")]
    ProjectSet {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
        #[serde(
            default,
            rename = "targetSeconds",
            skip_serializing_if = "Option::is_none"
        )]
        target_seconds: Option<u32>,
        #[serde(
            default,
            rename = "aspectRatio",
            skip_serializing_if = "Option::is_none"
        )]
        aspect_ratio: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resolution: Option<String>,
        #[serde(default, rename = "frameRate", skip_serializing_if = "Option::is_none")]
        frame_rate: Option<u32>,
        #[serde(
            default,
            rename = "backgroundColor",
            skip_serializing_if = "Option::is_none"
        )]
        background_color: Option<String>,
    },
    #[serde(rename = "ref.add")]
    ReferenceAdd {
        id: String,
        name: String,
        #[serde(rename = "text")]
        description: String,
        #[serde(rename = "use")]
        intended_use: Vec<String>,
    },
    #[serde(rename = "ref.set")]
    ReferenceSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, rename = "text", skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(default, rename = "use", skip_serializing_if = "Option::is_none")]
        intended_use: Option<Vec<String>>,
    },
    #[serde(rename = "ref.remove")]
    ReferenceRemove { id: String },
    #[serde(rename = "scene.add")]
    SceneAdd {
        id: String,
        title: String,
        #[serde(rename = "seconds")]
        duration_seconds: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sound: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        music: Option<String>,
        #[serde(
            default,
            rename = "startFrame",
            skip_serializing_if = "Option::is_none"
        )]
        start_frame_reference_id: Option<String>,
    },
    #[serde(rename = "scene.set")]
    SceneSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, rename = "seconds", skip_serializing_if = "Option::is_none")]
        duration_seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        steps: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seed: Option<i64>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        sound: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        music: Option<Option<String>>,
        #[serde(
            default,
            rename = "startFrame",
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        start_frame_reference_id: Option<Option<String>>,
    },
    #[serde(rename = "scene.remove")]
    SceneRemove { id: String },
    #[serde(rename = "scene.move")]
    SceneMove {
        id: String,
        #[serde(default)]
        before: Option<String>,
    },
    #[serde(rename = "shot.add")]
    ShotAdd {
        scene: String,
        id: String,
        #[serde(rename = "at")]
        start_seconds: f64,
        action: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        speech: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        language: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settings: Option<BTreeMap<String, Vec<String>>>,
    },
    #[serde(rename = "shot.set")]
    ShotSet {
        scene: String,
        id: String,
        #[serde(default, rename = "at", skip_serializing_if = "Option::is_none")]
        start_seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        name: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        speech: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        language: Option<Option<String>>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_nullable_patch"
        )]
        settings: Option<Option<BTreeMap<String, Vec<String>>>>,
    },
    #[serde(rename = "shot.remove")]
    ShotRemove { scene: String, id: String },
    #[serde(rename = "clip.add")]
    ClipAdd {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scene: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        asset: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        #[serde(default, rename = "sourceAt", skip_serializing_if = "Option::is_none")]
        source_at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "clip.set")]
    ClipSet {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        track: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        #[serde(default, rename = "sourceAt", skip_serializing_if = "Option::is_none")]
        source_at: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    #[serde(rename = "clip.remove")]
    ClipRemove { id: String },
}

fn deserialize_nullable_patch<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandBatch {
    pub summary: String,
    pub commands: Vec<ProjectCommand>,
}

#[derive(Deserialize)]
struct Operation {
    op: String,
}

#[derive(Deserialize)]
struct CommitLine {
    op: String,
    summary: String,
}

/** Parse the line protocol without weakening it into a general JSON patch. */
pub fn parse_jsonl_commands(raw: &str) -> Result<CommandBatch, String> {
    let clean = strip_code_fence(raw);
    let lines = clean
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Err("Agent command stream is empty.".into());
    }

    let mut commands = Vec::new();
    let mut summary = None;
    for (index, line) in lines.iter().enumerate() {
        let line_number = index + 1;
        let operation: Operation = serde_json::from_str(line).map_err(|error| {
            format!("Agent command line {line_number} is not one JSON object: {error}")
        })?;
        if operation.op == "commit" {
            if line_number != lines.len() {
                return Err("The commit line must be the final line of the command stream.".into());
            }
            let commit: CommitLine = serde_json::from_str(line).map_err(|error| {
                format!("Agent commit line does not match the command contract: {error}")
            })?;
            if commit.op != "commit" || commit.summary.trim().is_empty() {
                return Err("Agent commit summary cannot be empty.".into());
            }
            summary = Some(commit.summary);
            continue;
        }
        if summary.is_some() {
            return Err("No command may appear after commit.".into());
        }
        let command: ProjectCommand = serde_json::from_str(line).map_err(|error| {
            format!(
                "Agent command line {line_number} does not match '{}': {error}",
                operation.op
            )
        })?;
        commands.push(command);
        if commands.len() > MAX_COMMANDS_PER_TURN {
            return Err(format!(
                "Agent command stream exceeds the limit of {MAX_COMMANDS_PER_TURN} commands."
            ));
        }
    }
    let summary = summary.ok_or_else(|| {
        "Agent command stream must end with {\"op\":\"commit\",\"summary\":\"...\"}.".to_string()
    })?;
    if commands.is_empty() {
        return Err("Agent command stream must contain at least one command before commit.".into());
    }
    Ok(CommandBatch { summary, commands })
}

fn strip_code_fence(raw: &str) -> &str {
    let trimmed = raw.trim();
    let without_open = ["```jsonl", "```json", "```"]
        .iter()
        .find_map(|prefix| trimmed.strip_prefix(prefix))
        .unwrap_or(trimmed);
    without_open
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
}

/** Apply a complete batch to a clone. Callers validate agent conventions after
 * this returns; neither a command error nor a validator error mutates input. */
pub fn execute_commands(
    current: &ProjectConfig,
    commands: &[ProjectCommand],
) -> Result<ProjectConfig, String> {
    execute_commands_at(current, commands, &current.updated_at)
}

pub fn execute_commands_at(
    current: &ProjectConfig,
    commands: &[ProjectCommand],
    timestamp: &str,
) -> Result<ProjectConfig, String> {
    if commands.is_empty() {
        return Err("Agent command batch cannot be empty.".into());
    }
    if commands.len() > MAX_COMMANDS_PER_TURN {
        return Err(format!(
            "Agent command batch exceeds the limit of {MAX_COMMANDS_PER_TURN} commands."
        ));
    }
    let mut next = current.clone();
    for (index, command) in commands.iter().enumerate() {
        apply_command(&mut next, command, timestamp).map_err(|error| {
            format!("Command {} ({}): {error}", index + 1, command_name(command))
        })?;
    }
    sync_changed_scenes(&mut next, commands)?;
    validate_and_normalize_config(next)
}

fn command_name(command: &ProjectCommand) -> &'static str {
    match command {
        ProjectCommand::ProjectSet { .. } => "project.set",
        ProjectCommand::ReferenceAdd { .. } => "ref.add",
        ProjectCommand::ReferenceSet { .. } => "ref.set",
        ProjectCommand::ReferenceRemove { .. } => "ref.remove",
        ProjectCommand::SceneAdd { .. } => "scene.add",
        ProjectCommand::SceneSet { .. } => "scene.set",
        ProjectCommand::SceneRemove { .. } => "scene.remove",
        ProjectCommand::SceneMove { .. } => "scene.move",
        ProjectCommand::ShotAdd { .. } => "shot.add",
        ProjectCommand::ShotSet { .. } => "shot.set",
        ProjectCommand::ShotRemove { .. } => "shot.remove",
        ProjectCommand::ClipAdd { .. } => "clip.add",
        ProjectCommand::ClipSet { .. } => "clip.set",
        ProjectCommand::ClipRemove { .. } => "clip.remove",
    }
}

fn apply_command(
    project: &mut ProjectConfig,
    command: &ProjectCommand,
    timestamp: &str,
) -> Result<(), String> {
    match command {
        ProjectCommand::ProjectSet {
            name,
            prompt,
            target_seconds,
            aspect_ratio,
            resolution,
            frame_rate,
            background_color,
        } => {
            ensure_any(
                [
                    name.is_some(),
                    prompt.is_some(),
                    target_seconds.is_some(),
                    aspect_ratio.is_some(),
                    resolution.is_some(),
                    frame_rate.is_some(),
                    background_color.is_some(),
                ],
                "has no fields to change",
            )?;
            if let Some(value) = name {
                project.name = value.clone();
            }
            if let Some(value) = prompt {
                project.brief.prompt = value.clone();
            }
            if let Some(value) = target_seconds {
                project.brief.target_duration_seconds = *value;
            }
            if let Some(value) = aspect_ratio {
                project.settings.aspect_ratio = value.clone();
                project.brief.aspect_ratio = value.clone();
            }
            if let Some(value) = resolution {
                project.settings.resolution = value.clone();
                project.brief.resolution = value.clone();
            }
            if let Some(value) = frame_rate {
                project.settings.frame_rate = *value;
            }
            if let Some(value) = background_color {
                project.settings.background_color = value.clone();
            }
        }
        ProjectCommand::ReferenceAdd {
            id,
            name,
            description,
            intended_use,
        } => {
            if project
                .references
                .iter()
                .any(|reference| reference.id == *id)
            {
                return Err(format!("reference '{id}' already exists"));
            }
            project.references.push(ReusableReference {
                id: id.clone(),
                kind: "text".into(),
                name: name.clone(),
                description: description.clone(),
                content: None,
                relative_path: None,
                source_path: None,
                images: Vec::new(),
                intended_use: intended_use.clone(),
                subcategory: None,
                icon_relative_path: None,
                created_at: timestamp.into(),
            });
        }
        ProjectCommand::ReferenceSet {
            id,
            name,
            description,
            intended_use,
        } => {
            ensure_any(
                [
                    name.is_some(),
                    description.is_some(),
                    intended_use.is_some(),
                ],
                "has no fields to change",
            )?;
            let reference = project
                .references
                .iter_mut()
                .find(|reference| reference.id == *id)
                .ok_or_else(|| format!("reference '{id}' was not found"))?;
            if let Some(value) = name {
                reference.name = value.clone();
            }
            if let Some(value) = description {
                reference.description = value.clone();
                reference.content = None;
            }
            if let Some(value) = intended_use {
                if reference.intended_use != *value {
                    reference.subcategory = None;
                }
                reference.intended_use = value.clone();
            }
        }
        ProjectCommand::ReferenceRemove { id } => {
            let at = project
                .references
                .iter()
                .position(|reference| reference.id == *id)
                .ok_or_else(|| format!("reference '{id}' was not found"))?;
            let token = format!("@[ref:{id}]");
            if project.generation_jobs.iter().any(|job| {
                job.start_frame_reference_id.as_deref() == Some(id)
                    || job
                        .shots
                        .as_ref()
                        .is_some_and(|shots| shots.iter().any(|shot| shot.action.contains(&token)))
            }) {
                return Err(format!(
                    "reference '{id}' is still used by a scene; update that scene before removing it"
                ));
            }
            project.references.remove(at);
            for job in &mut project.generation_jobs {
                job.reference_ids.retain(|reference_id| reference_id != id);
            }
        }
        ProjectCommand::SceneAdd {
            id,
            title,
            duration_seconds,
            steps,
            seed,
            sound,
            music,
            start_frame_reference_id,
        } => {
            if project.generation_jobs.iter().any(|job| job.id == *id) {
                return Err(format!("scene '{id}' already exists"));
            }
            let now = timestamp.to_string();
            project.generation_jobs.push(GenerationJob {
                id: id.clone(),
                title: title.clone(),
                prompt: String::new(),
                status: "draft".into(),
                stage: "queued".into(),
                progress: 0.0,
                provider_id: Some("minimax-h3".into()),
                creative_brief: String::new(),
                compiled_prompt: String::new(),
                generation_snapshot: None,
                reference_ids: Vec::new(),
                start_frame_reference_id: start_frame_reference_id.clone(),
                shot_tags: None,
                shots: Some(Vec::new()),
                duration_seconds: Some(*duration_seconds),
                steps: *steps,
                seed: *seed,
                soundscape: sound.clone(),
                music: music.clone(),
                clip_id: None,
                output_relative_path: None,
                error: None,
                created_at: now.clone(),
                updated_at: now,
            });
        }
        ProjectCommand::SceneSet {
            id,
            title,
            duration_seconds,
            steps,
            seed,
            sound,
            music,
            start_frame_reference_id,
        } => {
            ensure_any(
                [
                    title.is_some(),
                    duration_seconds.is_some(),
                    steps.is_some(),
                    seed.is_some(),
                    sound.is_some(),
                    music.is_some(),
                    start_frame_reference_id.is_some(),
                ],
                "has no fields to change",
            )?;
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, id)?;
            if let Some(value) = title {
                job.title = value.clone();
            }
            if let Some(value) = duration_seconds {
                job.duration_seconds = Some(*value);
            }
            if let Some(value) = steps {
                job.steps = Some(*value);
            }
            if let Some(value) = seed {
                job.seed = Some(*value);
            }
            if let Some(value) = sound {
                job.soundscape = value.clone();
            }
            if let Some(value) = music {
                job.music = value.clone();
            }
            if let Some(value) = start_frame_reference_id {
                job.start_frame_reference_id = value.clone();
            }
            job.updated_at = updated_at;
        }
        ProjectCommand::SceneRemove { id } => {
            let at = project
                .generation_jobs
                .iter()
                .position(|job| job.id == *id)
                .ok_or_else(|| format!("scene '{id}' was not found"))?;
            project.generation_jobs.remove(at);
        }
        ProjectCommand::SceneMove { id, before } => {
            let at = project
                .generation_jobs
                .iter()
                .position(|job| job.id == *id)
                .ok_or_else(|| format!("scene '{id}' was not found"))?;
            if before.as_deref() == Some(id) {
                return Err("a scene cannot be moved before itself".into());
            }
            let moving = project.generation_jobs.remove(at);
            let destination = match before {
                Some(before_id) => project
                    .generation_jobs
                    .iter()
                    .position(|job| job.id == *before_id)
                    .ok_or_else(|| format!("destination scene '{before_id}' was not found"))?,
                None => project.generation_jobs.len(),
            };
            project.generation_jobs.insert(destination, moving);
        }
        ProjectCommand::ShotAdd {
            scene,
            id,
            start_seconds,
            action,
            name,
            speech,
            language,
            settings,
        } => {
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shots = job.shots.get_or_insert_with(Vec::new);
            if shots.iter().any(|shot| shot.id == *id) {
                return Err(format!("shot '{id}' already exists in scene '{scene}'"));
            }
            shots.push(SceneShot {
                id: id.clone(),
                name: name.clone(),
                start_seconds: *start_seconds,
                action: action.clone(),
                speech: speech.clone(),
                speech_language: language.clone(),
                settings: settings.clone(),
            });
            job.updated_at = updated_at;
        }
        ProjectCommand::ShotSet {
            scene,
            id,
            start_seconds,
            action,
            name,
            speech,
            language,
            settings,
        } => {
            ensure_any(
                [
                    start_seconds.is_some(),
                    action.is_some(),
                    name.is_some(),
                    speech.is_some(),
                    language.is_some(),
                    settings.is_some(),
                ],
                "has no fields to change",
            )?;
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shot = job
                .shots
                .get_or_insert_with(Vec::new)
                .iter_mut()
                .find(|shot| shot.id == *id)
                .ok_or_else(|| format!("shot '{id}' was not found in scene '{scene}'"))?;
            if let Some(value) = start_seconds {
                shot.start_seconds = *value;
            }
            if let Some(value) = action {
                shot.action = value.clone();
            }
            if let Some(value) = name {
                shot.name = value.clone();
            }
            if let Some(value) = speech {
                shot.speech = value.clone();
            }
            if let Some(value) = language {
                shot.speech_language = value.clone();
            }
            if let Some(value) = settings {
                shot.settings = value.clone();
            }
            job.updated_at = updated_at;
        }
        ProjectCommand::ShotRemove { scene, id } => {
            let updated_at = timestamp.to_string();
            let job = find_scene_mut(project, scene)?;
            let shots = job.shots.get_or_insert_with(Vec::new);
            let at = shots
                .iter()
                .position(|shot| shot.id == *id)
                .ok_or_else(|| format!("shot '{id}' was not found in scene '{scene}'"))?;
            shots.remove(at);
            job.updated_at = updated_at;
        }
        ProjectCommand::ClipAdd {
            id,
            scene,
            asset,
            track,
            at,
            seconds,
            source_at,
            label,
        } => {
            if find_clip_location(project, id).is_some() {
                return Err(format!("clip '{id}' already exists"));
            }
            if scene.is_some() == asset.is_some() {
                return Err("exactly one of scene or asset is required".into());
            }

            let (asset_id, default_label, default_duration_ms, status, from_scene) =
                if let Some(scene_id) = scene {
                    let job = project
                        .generation_jobs
                        .iter()
                        .find(|job| job.id == *scene_id)
                        .cloned()
                        .ok_or_else(|| format!("scene '{scene_id}' was not found"))?;
                    let planned_id = format!("asset-{scene_id}");
                    let existing = project.assets.iter().position(|candidate| {
                        candidate.id == planned_id
                            || job.output_relative_path.is_some()
                                && candidate.kind == "generated"
                                && candidate.relative_path == job.output_relative_path
                    });
                    let frame_ms = (1000.0 / f64::from(project.settings.frame_rate)).round() as u64;
                    let scene_ms =
                        seconds_to_ms(job.duration_seconds.unwrap_or(6.0), "scene duration", true)?
                            .max(frame_ms.max(1));
                    let asset_id = if let Some(index) = existing {
                        project.assets[index].id.clone()
                    } else {
                        project.assets.push(ProjectAsset {
                            id: planned_id.clone(),
                            kind: "generated".into(),
                            name: job.title.clone(),
                            relative_path: job.output_relative_path.clone(),
                            source_path: None,
                            mime_type: "video/mp4".into(),
                            duration_ms: Some(scene_ms),
                            width: None,
                            height: None,
                            has_audio: None,
                            created_at: job.created_at.clone(),
                        });
                        planned_id
                    };
                    let status = if job.status == "completed" && job.output_relative_path.is_some()
                    {
                        "generated"
                    } else {
                        "draft"
                    };
                    (asset_id, job.title, scene_ms, status, true)
                } else {
                    let asset_id = asset.as_ref().expect("asset checked above");
                    let media = project
                        .assets
                        .iter()
                        .find(|candidate| candidate.id == *asset_id)
                        .ok_or_else(|| format!("asset '{asset_id}' was not found"))?;
                    if media.kind == "caption" {
                        return Err(format!(
                            "asset '{asset_id}' cannot be placed on an audiovisual track"
                        ));
                    }
                    (
                        media.id.clone(),
                        media.name.clone(),
                        media.duration_ms.unwrap_or(5_000).max(1),
                        "approved",
                        false,
                    )
                };

            let track_index = target_track_index(project, track.as_deref())?;
            let target = &project.timeline.tracks[track_index];
            if from_scene && target.kind != "video" {
                return Err(format!(
                    "scene clips require a video track, not '{}'",
                    target.id
                ));
            }
            let start_ms = match at {
                Some(value) => seconds_to_ms(*value, "clip start", true)?,
                None => target
                    .clips
                    .iter()
                    .try_fold(0u64, |end, clip| {
                        clip.start_ms
                            .checked_add(clip.duration_ms)
                            .map(|clip_end| end.max(clip_end))
                    })
                    .ok_or_else(|| "timeline position is too large".to_string())?,
            };
            let duration_ms = match seconds {
                Some(value) => seconds_to_ms(*value, "clip duration", false)?,
                None => default_duration_ms,
            };
            let source_start_ms = match source_at {
                Some(value) => seconds_to_ms(*value, "clip source start", true)?,
                None => 0,
            };
            validate_source_range(project, &asset_id, source_start_ms, duration_ms)?;
            let label = label.clone().unwrap_or(default_label);
            if label.trim().is_empty() {
                return Err("clip label cannot be empty".into());
            }
            let track_id = project.timeline.tracks[track_index].id.clone();
            project.timeline.tracks[track_index]
                .clips
                .push(TimelineClip {
                    id: id.clone(),
                    asset_id,
                    track_id,
                    start_ms,
                    duration_ms,
                    source_start_ms,
                    label,
                    color: None,
                    status: status.into(),
                    transform: None,
                    look: None,
                    chroma_key: None,
                    transition: None,
                });
        }
        ProjectCommand::ClipSet {
            id,
            track,
            at,
            seconds,
            source_at,
            label,
        } => {
            ensure_any(
                [
                    track.is_some(),
                    at.is_some(),
                    seconds.is_some(),
                    source_at.is_some(),
                    label.is_some(),
                ],
                "has no fields to change",
            )?;
            let (source_track_index, clip_index) = find_clip_location(project, id)
                .ok_or_else(|| format!("clip '{id}' was not found"))?;
            if project.timeline.tracks[source_track_index].locked {
                return Err(format!(
                    "track '{}' is locked",
                    project.timeline.tracks[source_track_index].id
                ));
            }
            let target_track_index = match track {
                Some(track_id) => target_track_index(project, Some(track_id))?,
                None => source_track_index,
            };
            let mut clip = project.timeline.tracks[source_track_index].clips[clip_index].clone();
            if let Some(value) = at {
                clip.start_ms = seconds_to_ms(*value, "clip start", true)?;
            }
            if let Some(value) = seconds {
                clip.duration_ms = seconds_to_ms(*value, "clip duration", false)?;
            }
            if let Some(value) = source_at {
                clip.source_start_ms = seconds_to_ms(*value, "clip source start", true)?;
            }
            if let Some(value) = label {
                if value.trim().is_empty() {
                    return Err("clip label cannot be empty".into());
                }
                clip.label = value.clone();
            }
            validate_source_range(
                project,
                &clip.asset_id,
                clip.source_start_ms,
                clip.duration_ms,
            )?;
            clip.track_id = project.timeline.tracks[target_track_index].id.clone();
            project.timeline.tracks[source_track_index]
                .clips
                .remove(clip_index);
            project.timeline.tracks[target_track_index].clips.push(clip);
        }
        ProjectCommand::ClipRemove { id } => {
            let (track_index, clip_index) = find_clip_location(project, id)
                .ok_or_else(|| format!("clip '{id}' was not found"))?;
            if project.timeline.tracks[track_index].locked {
                return Err(format!(
                    "track '{}' is locked",
                    project.timeline.tracks[track_index].id
                ));
            }
            project.timeline.tracks[track_index]
                .clips
                .remove(clip_index);
            for job in &mut project.generation_jobs {
                if job.clip_id.as_deref() == Some(id) {
                    job.clip_id = None;
                }
            }
        }
    }
    Ok(())
}

fn find_scene_mut<'a>(
    project: &'a mut ProjectConfig,
    id: &str,
) -> Result<&'a mut GenerationJob, String> {
    project
        .generation_jobs
        .iter_mut()
        .find(|job| job.id == id)
        .ok_or_else(|| format!("scene '{id}' was not found"))
}

fn ensure_any<const N: usize>(fields: [bool; N], error: &str) -> Result<(), String> {
    fields
        .into_iter()
        .any(|field| field)
        .then_some(())
        .ok_or_else(|| error.into())
}

fn seconds_to_ms(value: f64, field: &str, allow_zero: bool) -> Result<u64, String> {
    if !value.is_finite() || value < 0.0 || (!allow_zero && value == 0.0) {
        return Err(format!(
            "{field} must be {} finite seconds",
            if allow_zero {
                "non-negative"
            } else {
                "positive"
            }
        ));
    }
    let milliseconds = (value * 1000.0).round();
    if milliseconds > u64::MAX as f64 || (!allow_zero && milliseconds < 1.0) {
        return Err(format!("{field} is outside the supported range"));
    }
    Ok(milliseconds as u64)
}

fn find_clip_location(project: &ProjectConfig, id: &str) -> Option<(usize, usize)> {
    project
        .timeline
        .tracks
        .iter()
        .enumerate()
        .find_map(|(track_index, track)| {
            track
                .clips
                .iter()
                .position(|clip| clip.id == id)
                .map(|clip_index| (track_index, clip_index))
        })
}

fn target_track_index(project: &ProjectConfig, requested: Option<&str>) -> Result<usize, String> {
    let index = match requested {
        Some(id) => project
            .timeline
            .tracks
            .iter()
            .position(|track| track.id == id)
            .ok_or_else(|| format!("track '{id}' was not found"))?,
        None => project
            .timeline
            .tracks
            .iter()
            .position(|track| track.kind == "video" && !track.locked)
            .ok_or_else(|| "no unlocked video track is available".to_string())?,
    };
    if project.timeline.tracks[index].locked {
        return Err(format!(
            "track '{}' is locked",
            project.timeline.tracks[index].id
        ));
    }
    Ok(index)
}

fn validate_source_range(
    project: &ProjectConfig,
    asset_id: &str,
    source_start_ms: u64,
    duration_ms: u64,
) -> Result<(), String> {
    let asset = project
        .assets
        .iter()
        .find(|asset| asset.id == asset_id)
        .ok_or_else(|| format!("asset '{asset_id}' was not found"))?;
    if asset.kind == "image" {
        return Ok(());
    }
    if let Some(source_duration_ms) = asset.duration_ms {
        let end = source_start_ms
            .checked_add(duration_ms)
            .ok_or_else(|| "clip source range is too large".to_string())?;
        if end > source_duration_ms {
            return Err(format!(
                "clip source range ends at {end}ms, after asset '{asset_id}' ends at {source_duration_ms}ms"
            ));
        }
    }
    Ok(())
}

fn sync_changed_scenes(
    project: &mut ProjectConfig,
    commands: &[ProjectCommand],
) -> Result<(), String> {
    let changed = commands
        .iter()
        .filter_map(|command| match command {
            ProjectCommand::ShotAdd { scene, .. }
            | ProjectCommand::ShotSet { scene, .. }
            | ProjectCommand::ShotRemove { scene, .. } => Some(scene.as_str()),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let reference_ids = project
        .references
        .iter()
        .map(|reference| reference.id.clone())
        .collect::<Vec<_>>();
    for job in &mut project.generation_jobs {
        if !changed.contains(job.id.as_str()) {
            continue;
        }
        let Some(shots) = job.shots.as_mut() else {
            continue;
        };
        shots.sort_by(|left, right| left.start_seconds.total_cmp(&right.start_seconds));
        let text = shots
            .iter()
            .map(|shot| shot.action.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        job.prompt = text.clone();
        job.creative_brief = text;
        job.shot_tags = None;
        for shot in shots {
            for reference_id in action_reference_ids(&shot.action)? {
                if reference_ids.contains(&reference_id)
                    && !job.reference_ids.contains(&reference_id)
                {
                    job.reference_ids.push(reference_id);
                }
            }
        }
    }
    Ok(())
}

fn action_reference_ids(action: &str) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    let mut rest = action;
    while let Some(start) = rest.find("@[ref:") {
        let after_prefix = &rest[start + "@[ref:".len()..];
        let end = after_prefix.find(']').ok_or_else(|| {
            "a shot contains an unfinished @[ref:<reference-id>] token".to_string()
        })?;
        let id = &after_prefix[..end];
        if id.trim().is_empty() {
            return Err("a shot contains an empty @[ref:<reference-id>] token".into());
        }
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
        rest = &after_prefix[end + 1..];
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> ProjectConfig {
        serde_json::from_str(include_str!("../../fixtures/project-v1-complete.json")).unwrap()
    }

    #[test]
    fn parses_jsonl_and_preserves_explicit_null_patches() {
        let batch = parse_jsonl_commands(
            r#"```jsonl
{"op":"scene.set","id":"job-01","sound":null}
{"op":"commit","summary":"Removed the sound design."}
```"#,
        )
        .unwrap();
        assert_eq!(batch.summary, "Removed the sound design.");
        assert!(matches!(
            &batch.commands[0],
            ProjectCommand::SceneSet {
                sound: Some(None),
                ..
            }
        ));
    }

    #[test]
    fn requires_a_final_non_empty_commit() {
        assert!(
            parse_jsonl_commands(r#"{"op":"scene.remove","id":"job-01"}"#)
                .unwrap_err()
                .contains("must end")
        );
        assert!(parse_jsonl_commands(r#"{"op":"commit","summary":""}"#)
            .unwrap_err()
            .contains("summary"));
    }

    #[test]
    fn executes_reference_scene_and_shot_commands_as_one_batch() {
        let commands = parse_jsonl_commands(
            r#"{"op":"ref.add","id":"ref-mara","name":"Mara","text":"A woman in her thirties with cropped black hair, a rust wool jacket, charcoal trousers, and black leather boots.","use":["character"]}
{"op":"scene.add","id":"scene-opening","title":"Workshop arrival","seconds":8}
{"op":"shot.add","scene":"scene-opening","id":"shot-wide","at":0,"action":"@[ref:ref-mara] opens the workshop door and stops beside the workbench."}
{"op":"clip.add","id":"clip-workshop","scene":"scene-opening"}
{"op":"commit","summary":"Added Mara and the opening scene to the timeline."}"#,
        )
        .unwrap()
        .commands;
        let next = execute_commands(&fixture(), &commands).unwrap();
        let scene = next
            .generation_jobs
            .iter()
            .find(|job| job.id == "scene-opening")
            .unwrap();
        assert_eq!(scene.prompt, scene.creative_brief);
        assert_eq!(scene.reference_ids, ["ref-mara"]);
        assert_eq!(scene.shots.as_ref().unwrap()[0].id, "shot-wide");
        assert_eq!(scene.status, "draft");
        assert!(scene.output_relative_path.is_none());
        let clip = next
            .timeline
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .find(|clip| clip.id == "clip-workshop")
            .unwrap();
        assert_eq!(
            clip.start_ms, 8_000,
            "default placement appends after the existing clip"
        );
        assert_eq!(clip.duration_ms, 8_000);
        assert_eq!(clip.asset_id, "asset-scene-opening");
        assert_eq!(clip.status, "draft");
        assert!(next
            .assets
            .iter()
            .any(|asset| asset.id == "asset-scene-opening"));
    }

    #[test]
    fn timeline_commands_support_explicit_arrangements_and_removal() {
        let current = validate_and_normalize_config(fixture()).unwrap();
        let commands = parse_jsonl_commands(
            r#"{"op":"clip.add","id":"clip-macro-second-layer","asset":"asset-imported","track":"track-v2","at":2,"seconds":3,"sourceAt":1,"label":"Macro insert"}
{"op":"clip.set","id":"clip-macro-second-layer","track":"track-v3","at":4}
{"op":"commit","summary":"Placed and moved the macro insert."}"#,
        )
        .unwrap()
        .commands;
        let arranged = execute_commands(&current, &commands).unwrap();
        let clip = arranged.timeline.tracks[2]
            .clips
            .iter()
            .find(|clip| clip.id == "clip-macro-second-layer")
            .unwrap();
        assert_eq!(clip.start_ms, 4_000);
        assert_eq!(clip.duration_ms, 3_000);
        assert_eq!(clip.source_start_ms, 1_000);
        assert_eq!(clip.label, "Macro insert");

        let clip_id = clip.id.clone();
        let removed =
            execute_commands(&arranged, &[ProjectCommand::ClipRemove { id: clip_id }]).unwrap();
        assert!(find_clip_location(&removed, "clip-macro-second-layer").is_none());
    }

    #[test]
    fn a_failed_command_does_not_mutate_the_input() {
        let current = fixture();
        let original = current.clone();
        let commands = vec![
            ProjectCommand::ProjectSet {
                name: Some("Changed".into()),
                prompt: None,
                target_seconds: None,
                aspect_ratio: None,
                resolution: None,
                frame_rate: None,
                background_color: None,
            },
            ProjectCommand::SceneRemove {
                id: "missing-scene".into(),
            },
        ];
        let error = execute_commands(&current, &commands).unwrap_err();
        assert!(error.contains("Command 2 (scene.remove)"));
        assert_eq!(current, original);
    }

    #[test]
    fn a_small_scene_patch_preserves_render_owned_fields() {
        let current = fixture();
        let before = current
            .generation_jobs
            .iter()
            .find(|job| job.id == "job-opener")
            .unwrap()
            .clone();
        let commands = parse_jsonl_commands(
            r#"{"op":"scene.set","id":"job-opener","title":"Warmer opener"}
{"op":"commit","summary":"Renamed the opener."}"#,
        )
        .unwrap()
        .commands;
        let next = execute_commands_at(&current, &commands, "2026-09-02T20:00:00.000Z").unwrap();
        let after = next
            .generation_jobs
            .iter()
            .find(|job| job.id == "job-opener")
            .unwrap();
        assert_eq!(after.title, "Warmer opener");
        assert_eq!(after.status, before.status);
        assert_eq!(after.output_relative_path, before.output_relative_path);
        assert_eq!(after.generation_snapshot, before.generation_snapshot);
        assert_eq!(after.updated_at, "2026-09-02T20:00:00.000Z");
    }

    #[test]
    fn commands_cannot_deserialize_protected_scene_fields() {
        let error = serde_json::from_str::<ProjectCommand>(
            r#"{"op":"scene.set","id":"job-01","outputRelativePath":"outside.mp4"}"#,
        )
        .unwrap_err();
        assert!(error.to_string().contains("unknown field"), "{error}");
    }
}
