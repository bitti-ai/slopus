use super::{batch::*, effects::Effects, types::ProjectCommand};
use crate::project::*;
pub(super) fn apply(
    project: &mut ProjectConfig,
    command: &ProjectCommand,
    _timestamp: &str,
    effects: &mut Effects,
) -> Result<(), String> {
    match command {
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
                    let scene_ms = seconds_to_ms(
                        job.duration_seconds
                            .unwrap_or(effects.defaults.duration_seconds),
                        "scene duration",
                        true,
                    )?
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
                    sharpen: None,
                    blur: None,
                    color_correction: None,
                    vignette: None,
                    lut: None,
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
        _ => unreachable!("command dispatched to the wrong domain"),
    }
    Ok(())
}
pub(super) fn seconds_to_ms(value: f64, field: &str, allow_zero: bool) -> Result<u64, String> {
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

pub(super) fn find_clip_location(project: &ProjectConfig, id: &str) -> Option<(usize, usize)> {
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

pub(super) fn target_track_index(
    project: &ProjectConfig,
    requested: Option<&str>,
) -> Result<usize, String> {
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

pub(super) fn validate_source_range(
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
