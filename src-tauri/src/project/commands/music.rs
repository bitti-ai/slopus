use super::{patch::Patch, types::ProjectCommand};
use crate::project::{music::MusicSong, ProjectConfig};

pub(super) fn apply(project: &mut ProjectConfig, command: &ProjectCommand, timestamp: &str) -> Result<(), String> {
    match command {
        ProjectCommand::VideoMusicSet { video, song } => {
            let song = project.music_songs.iter().find(|item| item.id == *song).ok_or("Song not found. Use music.list for IDs.")?;
            let audio = project.assets.iter().find(|asset| Some(&asset.id) == song.asset_id.as_ref() && asset.kind == "audio")
                .ok_or("Song has no generated audio. Generate it before assigning it to a video.")?;
            if !audio.relative_path.as_ref().is_some_and(|path| !path.trim().is_empty()) || audio.duration_ms.unwrap_or(0) < 2000 {
                return Err("The song needs saved audio at least two seconds long.".into());
            }
            let target = project.videos.iter_mut().find(|item| item.id == *video).ok_or("Video not found. Use an existing id from videos in the project JSON.")?;
            target.music_source = Some(crate::project::video::VideoSource { kind: "asset".into(), id: audio.id.clone() });
        }
        ProjectCommand::MusicAdd { id, title, style, settings, folder_id, steps, seed } => {
            if id.trim().is_empty() || project.music_songs.iter().any(|s| s.id == *id) { return Err("Song requires a unique id.".into()); }
            project.music_songs.push(MusicSong { id: id.clone(), title: title.clone(), style: style.clone(), settings: settings.clone(),
                folder_id: folder_id.clone(), steps: steps.unwrap_or(slopus_core::slopfab::music::YUE2_DEFAULT_STEPS), seed: seed.unwrap_or(-1), generator_id: String::new(),
                status: "draft".into(), asset_id: None, cover_relative_path: None, error: None, generation: None, created_at: timestamp.into() });
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

    fn video_music_fixture() -> ProjectConfig {
        let p: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let mut p = run(&p, json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz"}])).unwrap();
        p.music_songs[0].asset_id = Some("song-audio".into());
        p.music_songs[0].status = "completed".into();
        p.assets.push(serde_json::from_value(json!({"id":"song-audio","kind":"audio","name":"Intro","relativePath":"media/song.wav","mimeType":"audio/wav","durationMs":30000,"createdAt":p.created_at})).unwrap());
        p.videos = serde_json::from_value(json!([
            {"id":"film","title":"Film","sceneIds":[p.generation_jobs[0].id],"prompt":"Dance","createdAt":p.created_at,
                "musicSource":{"kind":"reference","id":"previous"},"videoSource":{"kind":"reference","id":"visual"}},
            {"id":"other","title":"Other","sceneIds":[],"createdAt":p.created_at}
        ])).unwrap();
        crate::project::validation::validate_and_normalize_config(p).unwrap()
    }

    #[test]
    fn video_music_command_links_saved_audio_and_preserves_other_project_data() {
        let p = video_music_fixture();
        let batch = super::super::parse_jsonl_commands("{\"op\":\"video.music.set\",\"video\":\"film\",\"song\":\"song\"}\n{\"op\":\"commit\",\"summary\":\"Assigned song\"}").unwrap();
        let assigned = super::super::execute_commands_at(&p, &batch.commands, &p.updated_at).unwrap();
        let mut expected = serde_json::to_value(&p).unwrap();
        expected["videos"][0]["musicSource"] = json!({"kind":"asset","id":"song-audio"});
        assert_eq!(serde_json::to_value(&assigned).unwrap(), expected);
        // Reapplying the same assignment cannot create duplicate assets or references.
        let repeated = super::super::execute_commands_at(&assigned, &batch.commands, &p.updated_at).unwrap();
        assert_eq!(serde_json::to_value(&repeated).unwrap(), expected);
        let restored: ProjectConfig = serde_json::from_value(expected).unwrap();
        assert_eq!(restored.videos[0].music_source.as_ref().unwrap().id, "song-audio");
    }

    #[test]
    fn video_music_command_rejects_missing_audio_and_invalid_targets_atomically() {
        let p = video_music_fixture();
        let command = json!([{"op":"video.music.set","video":"film","song":"song"}]);
        for (video, song) in [("missing", "song"), ("film", "missing")] {
            assert!(run(&p, json!([{"op":"video.music.set","video":video,"song":song}])).is_err());
        }
        let audio_index = p.assets.iter().position(|a| a.id == "song-audio").unwrap();
        for scenario in 0..5 {
            let mut invalid = p.clone();
            match scenario {
                0 => invalid.music_songs[0].asset_id = None,
                1 => invalid.assets[audio_index].kind = "image".into(),
                2 => invalid.assets[audio_index].relative_path = None,
                3 => invalid.assets[audio_index].duration_ms = Some(1000),
                _ => invalid.assets[audio_index].duration_ms = None,
            }
            assert!(run(&invalid, command.clone()).is_err());
        }
        assert!(run(&p, json!([
            {"op":"video.music.set","video":"film","song":"song"},
            {"op":"video.music.set","video":"missing","song":"song"}
        ])).is_err());
        assert_eq!(p.videos[0].music_source.as_ref().unwrap().id, "previous");
        for invalid in [
            json!({"op":"video.music.set","video":"film"}),
            json!({"op":"video.music.set","video":"film","song":"song","relativePath":"invented.wav"}),
            json!({"op":"video.music.set","video":"film","song":"song","assetId":"unrelated"}),
        ] {
            assert!(serde_json::from_value::<ProjectCommand>(invalid).is_err());
        }
    }

    #[test]
    fn album_covers_survive_project_round_trips_and_validate_paths() {
        let p: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let mut p = run(&p, json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz"}])).unwrap();
        assert!(p.music_songs[0].cover_relative_path.is_none());
        p.music_songs[0].cover_relative_path = Some("media\\generated\\cover.jpg".into());
        crate::project::music::validate(&mut p).unwrap();
        let encoded = serde_json::to_value(&p).unwrap();
        assert_eq!(encoded["musicSongs"][0]["coverRelativePath"], "media/generated/cover.jpg");
        let reopened: ProjectConfig = serde_json::from_value(encoded).unwrap();
        assert_eq!(reopened.music_songs, p.music_songs);
        for invalid in ["../outside.jpg", "C:/outside.jpg", "/outside.jpg"] {
            p.music_songs[0].cover_relative_path = Some(invalid.into());
            assert!(crate::project::music::validate(&mut p).is_err());
        }
    }
    #[test]
    fn music_commands_are_transactional_and_cannot_forge_results() {
        let p: ProjectConfig = serde_json::from_str(include_str!("../../../../fixtures/project-v1-complete.json")).unwrap();
        let added = run(&p,json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz","settings":{"lyrics":"Hello"}}])).unwrap();
        assert_eq!(added.music_songs[0].settings.lyrics,"Hello");
        assert_eq!(added.music_songs[0].steps,6);
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
