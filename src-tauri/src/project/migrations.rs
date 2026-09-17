use super::{ProjectConfig, TimelineTrack};
use std::collections::BTreeSet;

/// Normalize legacy tracks into the editor's three audiovisual layers.
pub(crate) fn normalize_timeline(config: &mut ProjectConfig) -> Result<(), String> {
    // The timeline is three audiovisual layers. Clips from old separate audio
    // tracks (and excess video tracks) are retained and moved onto those lanes.
    let old_tracks = std::mem::take(&mut config.timeline.tracks);
    for track in &old_tracks {
        if !matches!(track.kind.as_str(), "video" | "audio" | "caption") {
            return Err(format!("Unsupported track kind '{}'.", track.kind));
        }
    }
    let mut used_track_ids: BTreeSet<String> =
        old_tracks.iter().map(|track| track.id.clone()).collect();
    let mut video_tracks: Vec<TimelineTrack> = old_tracks
        .iter()
        .filter(|track| track.kind == "video")
        .take(3)
        .cloned()
        .collect();
    let retained_track_ids: BTreeSet<String> =
        video_tracks.iter().map(|track| track.id.clone()).collect();
    let retired_tracks: Vec<TimelineTrack> = old_tracks
        .into_iter()
        .filter(|track| !retained_track_ids.contains(&track.id))
        .collect();
    let original_layer_count = video_tracks.len();
    for (index, preferred) in ["track-story", "track-v2", "track-v3"].iter().enumerate() {
        if video_tracks.len() > index {
            continue;
        }
        let mut id = (*preferred).to_string();
        let mut suffix = 2;
        while used_track_ids.contains(&id) {
            id = format!("{preferred}-{suffix}");
            suffix += 1;
        }
        used_track_ids.insert(id.clone());
        video_tracks.push(TimelineTrack {
            id,
            kind: "video".into(),
            name: format!("Track {}", index + 1),
            locked: false,
            muted: false,
            clips: Vec::new(),
        });
    }
    for (index, mut track) in retired_tracks.into_iter().enumerate() {
        let target_index = std::cmp::min(2, original_layer_count + index);
        let target_id = video_tracks[target_index].id.clone();
        if target_index >= original_layer_count && video_tracks[target_index].clips.is_empty() {
            video_tracks[target_index].locked = track.locked;
            video_tracks[target_index].muted = track.muted;
        } else if target_index >= original_layer_count {
            video_tracks[target_index].name = format!("Track {}", target_index + 1);
            video_tracks[target_index].locked &= track.locked;
            video_tracks[target_index].muted &= track.muted;
        }
        for clip in &mut track.clips {
            clip.track_id = target_id.clone();
        }
        video_tracks[target_index].clips.extend(track.clips);
    }
    config.timeline.tracks = video_tracks;
    Ok(())
}
