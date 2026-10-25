use super::{patch::Patch, types::ProjectCommand};
use crate::project::{music::MusicSong, ProjectConfig};

pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str) -> Result<(), String> {
    match command {
        ProjectCommand::MusicAdd { id, title, style, settings, folder_id, steps, seed } => {
            if id.trim().is_empty() || project.music_songs.iter().any(|s| s.id == *id) { return Err("Song requires a unique id.".into()); }
            project.music_songs.push(MusicSong { id: id.clone(), title: title.clone(), style: style.clone(), settings: settings.clone(),
                folder_id: folder_id.clone(), steps: steps.unwrap_or(32), seed: seed.unwrap_or(-1), generator_id: String::new(),
                status: "draft".into(), asset_id: None, error: None, generation: None, created_at: timestamp.into() });
        }
        ProjectCommand::MusicSet { id, title, style, settings, folder_id, steps, seed } => {
            let song = project.music_songs.iter_mut().find(|s| s.id == *id).ok_or("Song not found.")?;
            if matches!(song.status.as_str(), "queued" | "generating") { return Err("Wait for song generation before editing it.".into()); }
            if let Some(value) = title { song.title = value.clone(); }
            if let Some(value) = style { song.style = value.clone(); }
            if let Some(value) = settings { song.settings = value.clone(); }
            if let Some(value) = steps { song.steps = *value; }
            if let Some(value) = seed { song.seed = *value; }
            match folder_id { Patch::Unchanged => {}, Patch::Clear => song.folder_id = None, Patch::Set(value) => song.folder_id = Some(value.clone()) }
        }
        ProjectCommand::MotionSync { id, song, bpm, beat_offset_seconds, beats_per_bar, clip, audio_clip } => {
            let meter = beats_per_bar.unwrap_or(4);
            if !bpm.is_finite() || !(20.0..=300.0).contains(bpm) || !beat_offset_seconds.is_finite()
                || !(0.0..=600.0).contains(beat_offset_seconds) || !(1..=16).contains(&meter) { return Err("Use BPM 20–300, offset 0–600 seconds and 1–16 beats per bar.".into()); }
            let song = project.music_songs.iter().find(|s| s.id == *song).ok_or("Song not found.")?;
            let audio = project.assets.iter().find(|a| Some(&a.id) == song.asset_id.as_ref() && a.kind == "audio").ok_or("Song has no generated audio.")?;
            let audio_id = audio.id.clone();
            let mut duration_ms = audio.duration_ms.ok_or("Song duration is unknown.")?;
            if *beat_offset_seconds >= duration_ms as f64 / 1000.0 { return Err("Beat offset must be inside the song.".into()); }
            let mut source_at = 0.0;
            let mut timeline_start = None;
            if clip.is_some() != audio_clip.is_some() { return Err("Provide both clip and audioClip, or neither.".into()); }
            if let Some(audio_clip) = audio_clip {
                let source = project.timeline.tracks.iter().flat_map(|t| &t.clips).find(|c| c.id == *audio_clip && c.asset_id == audio_id).ok_or("Song audio clip not found.")?;
                if source.playback_rate.unwrap_or(1.0) != 1.0 { return Err("Music sync requires audio playback speed 1.".into()); }
                duration_ms = source.duration_ms;
                source_at = source.source_start_ms as f64 / 1000.0;
                timeline_start = Some(source.start_ms);
            }
            if !(100..=600_000).contains(&duration_ms) { return Err("Motion duration must be 0.1–600 seconds.".into()); }
            if let Some(clip_id) = clip {
                let track = project.timeline.tracks.iter_mut().find(|t| t.clips.iter().any(|c| c.id == *clip_id && c.asset_id == *id)).ok_or("Motion clip not found.")?;
                if track.locked { return Err("Motion track is locked.".into()); }
                let target = track.clips.iter_mut().find(|c| c.id == *clip_id).unwrap();
                target.start_ms = timeline_start.unwrap(); target.duration_ms = duration_ms;
                target.source_start_ms = 0; target.playback_rate = Some(1.0);
            }
            let asset = project.assets.iter_mut().find(|a| a.id == *id && a.kind == "motion").ok_or("Motion not found.")?;
            let motion = asset.motion.as_mut().ok_or("Motion document missing.")?;
            motion["duration"] = serde_json::json!(duration_ms as f64 / 1000.0);
            motion["music"] = serde_json::json!({"songId":song.id,"assetId":audio_id,"bpm":bpm,"beatOffsetSeconds":beat_offset_seconds,"beatsPerBar":meter,"sourceAt":source_at});
            crate::project::motion::validate(motion)?;
            asset.duration_ms = Some(duration_ms);
        }
        _ => return Err("Unsupported music command.".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn run(p: &ProjectConfig, commands: Value) -> Result<ProjectConfig, String> {
        super::super::execute_commands_at(p, &serde_json::from_value::<Vec<ProjectCommand>>(commands).unwrap(), &p.updated_at)
    }
    #[test]
    fn music_commands_are_transactional_and_cannot_forge_results() {
        let p: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let added = run(&p,json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz","settings":{"lyrics":"Hello"}}])).unwrap();
        assert_eq!(added.music_songs[0].settings.lyrics,"Hello");
        assert_eq!(added.music_songs[0].steps,32);
        assert!(run(&added,json!([{"op":"music.set","id":"song","title":"Changed"},{"op":"music.set","id":"song","steps":1000}])).is_err());
        assert_eq!(added.music_songs[0].title,"Intro");
        assert!(run(&p,json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz","folderId":"missing"}])).is_err());
        assert!(serde_json::from_value::<ProjectCommand>(json!({"op":"music.set","id":"song","assetId":"fake"})).is_err());
        let command: ProjectCommand = serde_json::from_value(json!({"op":"music.set","id":"song","title":"Title"})).unwrap();
        assert!(serde_json::to_value(command).unwrap().get("folderId").is_none());
    }
    #[test]
    fn motion_sync_aligns_trimmed_clips_and_rejects_locked_tracks() {
        let p: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let mut p = run(&p,json!([
            {"op":"music.add","id":"song","title":"Intro","style":"Jazz"},
            {"op":"motion.add","id":"motion","name":"Pulse","motion":{"version":1,"space":"2d","width":320,"height":180,"duration":5,"source":"","nodes":[],"parameters":[]}}
        ])).unwrap();
        p.music_songs[0].asset_id = Some("audio".into());
        p.assets.push(serde_json::from_value(json!({"id":"audio","kind":"audio","name":"Song","durationMs":30000,"mimeType":"audio/wav","relativePath":"song.wav","createdAt":p.created_at})).unwrap());
        p.timeline.tracks = serde_json::from_value(json!([
            {"id":"v","kind":"video","name":"Motion","clips":[{"id":"mc","assetId":"motion","trackId":"v","startMs":0,"durationMs":5000,"label":"Pulse"}]},
            {"id":"a","kind":"audio","name":"Song","clips":[{"id":"ac","assetId":"audio","trackId":"a","startMs":10000,"durationMs":8000,"sourceStartMs":5000,"label":"Intro"}]}
        ])).unwrap();
        p = crate::project::validation::validate_and_normalize_config(p).unwrap();
        let cmd = json!([{"op":"motion.sync","id":"motion","song":"song","bpm":120,"beatOffsetSeconds":0.25,"clip":"mc","audioClip":"ac"}]);
        let synced = run(&p,cmd.clone()).unwrap();
        let motion = synced.assets.iter().find(|a| a.id == "motion").unwrap();
        assert_eq!(motion.motion.as_ref().unwrap()["music"]["sourceAt"],5.0);
        assert_eq!(motion.duration_ms,Some(8000));
        assert_eq!(synced.timeline.tracks[0].clips[0].start_ms,10000);
        assert_eq!(synced.timeline.tracks[0].clips[0].source_start_ms,0);
        assert_eq!(synced.timeline.tracks[1],p.timeline.tracks[1]);
        p.timeline.tracks[0].locked = true;
        assert!(run(&p,cmd.clone()).unwrap_err().contains("locked"));
        p.timeline.tracks[0].locked = false; p.timeline.tracks[1].clips[0].playback_rate = Some(2.0);
        assert!(run(&p,cmd).unwrap_err().contains("speed"));
    }
}
