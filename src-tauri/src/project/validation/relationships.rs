use crate::project::*;
use super::values::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    let asset_ids = unique_ids(config.assets.iter().map(|asset| asset.id.as_str()), "asset")?;
    let reference_ids = unique_ids(
        config
            .references
            .iter()
            .map(|reference| reference.id.as_str()),
        "reference",
    )?;
    let track_ids = unique_ids(
        config.timeline.tracks.iter().map(|track| track.id.as_str()),
        "track",
    )?;
    let clip_ids = unique_ids(
        config
            .timeline
            .tracks
            .iter()
            .flat_map(|track| track.clips.iter().map(|clip| clip.id.as_str())),
        "clip",
    )?;
    for track in &config.timeline.tracks {
        for clip in &track.clips {
            if clip.track_id != track.id || !track_ids.contains(clip.track_id.as_str()) {
                return Err(format!(
                    "Clip '{}' is attached to an invalid track.",
                    clip.id
                ));
            }
            if !asset_ids.contains(clip.asset_id.as_str()) {
                return Err(format!("Clip '{}' references an unknown asset.", clip.id));
            }
        }
    }
    for job in &config.generation_jobs {
        if let Some(clip_id) = &job.clip_id {
            if !clip_ids.contains(clip_id.as_str()) {
                return Err(format!(
                    "Generation job '{}' references an unknown clip.",
                    job.id
                ));
            }
        }
        if let Some(reference_id) = job
            .reference_ids
            .iter()
            .find(|reference_id| !reference_ids.contains(reference_id.as_str()))
        {
            return Err(format!(
                "Generation job '{}' references unknown reference '{}'.",
                job.id, reference_id
            ));
        }
        for (edge, frame_id) in [
            ("start", &job.start_frame_reference_id),
            ("end", &job.end_frame_reference_id),
        ] {
            if let Some(start_frame_id) = frame_id {
                let Some(reference) = config
                    .references
                    .iter()
                    .find(|reference| reference.id == *start_frame_id)
                else {
                    return Err(format!(
                        "Generation job '{}' uses unknown {edge}-frame reference '{}'.",
                        job.id, start_frame_id
                    ));
                };
                if reference.kind != "image" && reference.images.is_empty() {
                    return Err(format!(
                        "Generation job '{}' {edge}-frame reference '{}' is not an image.",
                        job.id, start_frame_id
                    ));
                }
            }
        }
    }
    Ok(())
}
