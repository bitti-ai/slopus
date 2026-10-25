//! Bounded, read-only music metadata and audio timing observations.
use crate::project::{paths::ProjectRoot, ProjectConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, path::Path, sync::atomic::{AtomicBool, Ordering}};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum MusicRead {
    #[serde(rename = "music.list")] List {},
    #[serde(rename = "music.get")] Get { song: String },
    #[serde(rename = "music.analyze")] Analyze { song: String },
    #[serde(rename = "music.beats")] Beats { song: String, bpm: f64, #[serde(default, rename = "offsetSeconds")] offset_seconds: f64,
        #[serde(default, rename = "beatsPerBar")] beats_per_bar: Option<u32> },
}

pub(super) fn read(config: &ProjectConfig, folder: &Path, request: &MusicRead, cancel: &AtomicBool) -> Result<Value, String> {
    if cancel.load(Ordering::SeqCst) { return Err("Music inspection cancelled.".into()); }
    let id = match request {
        MusicRead::List {} => return Ok(json!({"folders":config.music_folders,"songs":config.music_songs.iter().map(|s|
            json!({"id":s.id,"title":s.title,"folderId":s.folder_id,"status":s.status,"assetId":s.asset_id,"generatorId":s.generator_id})).collect::<Vec<_>>()})),
        MusicRead::Get { song } | MusicRead::Analyze { song } | MusicRead::Beats { song, .. } => song,
    };
    let song = config.music_songs.iter().find(|s| s.id == *id).ok_or("Song not found. Use music.list for IDs.")?;
    let asset = config.assets.iter().find(|a| Some(&a.id) == song.asset_id.as_ref() && a.kind == "audio");
    if matches!(request, MusicRead::Get { .. }) {
        let clips: Vec<_> = config.timeline.tracks.iter().flat_map(|t| &t.clips).filter(|c| Some(&c.asset_id) == song.asset_id.as_ref()).collect();
        return Ok(json!({"song":song,"asset":asset,"clips":clips,"generationInputsKnown":song.generation.is_some(),
            "lyricsNote":"Lyrics are supplied generation text, not a transcription or word timing. Songs without a generation snapshot have unknown original inputs."}));
    }
    let asset = asset.ok_or("Song has no generated audio.")?;
    if let MusicRead::Beats { bpm, offset_seconds, beats_per_bar, .. } = request {
        return Ok(json!({"song":id,"assetId":asset.id,"timing":"supplied BPM, not detected beats",
            "beats":beats(asset.duration_ms.ok_or("Song duration unknown.")? as f64 / 1000.0, *bpm, *offset_seconds, beats_per_bar.unwrap_or(4))?}));
    }
    let root = ProjectRoot::from_directory(folder)?;
    let path = root.existing(asset.relative_path.as_deref().ok_or("Song file missing.")?)?;
    const LIMIT: u64 = 128 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > LIMIT { return Err("Music analysis is limited to 128 MiB WAV files.".into()); }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT { return Err("Music file exceeds analysis limit.".into()); }
    let mut result = analyze_wav(&bytes, cancel)?;
    result["song"] = json!(id); result["assetId"] = json!(asset.id);
    Ok(result)
}

fn beats(duration: f64, bpm: f64, offset: f64, meter: u32) -> Result<Vec<Value>, String> {
    if !duration.is_finite() || !(0.1..=600.0).contains(&duration) || !bpm.is_finite() || !(20.0..=300.0).contains(&bpm)
        || !offset.is_finite() || offset < 0.0 || offset >= duration || !(1..=16).contains(&meter) {
        return Err("Use BPM 20–300, 1–16 beats per bar and an offset inside the song (maximum duration 600 seconds).".into());
    }
    Ok((0..3000).map(|i| (i, offset + i as f64 * 60.0 / bpm)).take_while(|(_, t)| *t < duration)
        .map(|(i, t)| json!({"index":i,"at":t,"bar":i / meter,"beatInBar":i % meter})).collect())
}

fn analyze_wav(bytes: &[u8], cancel: &AtomicBool) -> Result<Value, String> {
    let invalid = || "Music analysis needs a valid PCM or float WAV file (up to 600 seconds).".to_string();
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" { return Err(invalid()); }
    let u16_at = |b: &[u8], i| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32_at = |b: &[u8], i| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    let end = 8usize.checked_add(u32_at(bytes, 4) as usize).filter(|n| *n <= bytes.len()).ok_or_else(invalid)?;
    let (mut fmt, mut data) = (None, None);
    let mut at = 12;
    while at + 8 <= end {
        let size = u32_at(bytes, at + 4) as usize;
        let next = (at + 8).checked_add(size).filter(|n| *n <= end).ok_or_else(invalid)?;
        match &bytes[at..at + 4] { b"fmt " => fmt = Some(&bytes[at + 8..next]), b"data" => data = Some(&bytes[at + 8..next]), _ => {} }
        at = next + size % 2;
    }
    let fmt = fmt.filter(|f| f.len() >= 16).ok_or_else(invalid)?;
    let data = data.ok_or_else(invalid)?;
    let (format, channels, rate, align, bits) = (u16_at(fmt, 0), u16_at(fmt, 2) as usize, u32_at(fmt, 4) as usize, u16_at(fmt, 12) as usize, u16_at(fmt, 14));
    let width = bits as usize / 8;
    if !(1..=2).contains(&channels) || !(8000..=192000).contains(&rate) || !matches!((format,bits), (1,16|24|32)|(3,32))
        || align != channels * width || data.is_empty() || data.len() % align != 0 { return Err(invalid()); }
    let frames = data.len() / align;
    let duration = frames as f64 / rate as f64;
    if duration > 600.0 { return Err(invalid()); }
    let block = rate / 100; // 10 ms energy windows, stereo energy avoids phase cancellation.
    let mut rms = Vec::new();
    for (index, window) in data.chunks(block * align).enumerate() {
        if index % 100 == 0 && cancel.load(Ordering::SeqCst) { return Err("Music inspection cancelled.".into()); }
        let mut sum = 0.0;
        for sample in window.chunks_exact(width) {
            let value = match (format, bits) {
                (3, 32) => f32::from_le_bytes(sample.try_into().unwrap()) as f64,
                (1, 16) => i16::from_le_bytes(sample.try_into().unwrap()) as f64 / 32768.0,
                (1, 24) => ((sample[0] as i32 | (sample[1] as i32) << 8 | (sample[2] as i32) << 16) << 8 >> 8) as f64 / 8388608.0,
                _ => i32::from_le_bytes(sample.try_into().unwrap()) as f64 / 2147483648.0,
            };
            if !value.is_finite() { return Err(invalid()); }
            sum += value.clamp(-1.0, 1.0).powi(2);
        }
        rms.push((sum / (window.len() / width) as f64).sqrt());
    }
    let dt = block as f64 / rate as f64;
    let onset: Vec<f64> = rms.iter().enumerate().map(|(i, v)| (v - if i == 0 { 0.0 } else { rms[i - 1] }).max(0.0)).collect();
    let peak = onset.iter().copied().fold(0.0, f64::max);
    let mut best = (0usize, 0.0f64);
    // A deliberately approximate onset autocorrelation; half/double tempo ambiguity remains.
    if duration >= 4.0 && peak > 0.001 {
        for lag in (0.3 / dt).ceil() as usize..=(1.0 / dt).floor() as usize {
            let pairs = onset.iter().skip(lag).zip(&onset);
            let (mut dot, mut a, mut b) = (0.0, 0.0, 0.0);
            for (x,y) in pairs { dot += x*y; a += x*x; b += y*y; }
            let score = dot / (a*b).sqrt().max(1e-12);
            if score > best.1 { best = (lag,score); }
        }
    }
    let mut last = -1.0;
    let onsets: Vec<f64> = onset.iter().enumerate().filter_map(|(i,v)| {
        let at = i as f64 * dt;
        if *v > 0.001 && *v >= peak * 0.3 && at - last >= 0.15 { last = at; Some(at) } else { None }
    }).take(512).collect();
    let stride = rms.len().div_ceil(256).max(1);
    let envelope: Vec<_> = rms.chunks(stride).enumerate().map(|(i, values)| json!({"at":i as f64 * stride as f64 * dt,
        "rms":(values.iter().map(|x| x*x).sum::<f64>() / values.len() as f64).sqrt()})).collect();
    Ok(json!({"duration":duration,"sampleRate":rate,"channels":channels,"energy":envelope,"onsets":onsets,
        "tempo":if best.1 >= 0.15 { Some(json!({"bpm":60.0/(best.0 as f64 * dt),"confidence":best.1,"offsetSeconds":onsets.first().copied().unwrap_or(0.0)})) } else { None },
        "timing":"Estimated onset/tempo timing; half/double tempo and downbeat ambiguity. No lyric alignment. Use explicit BPM/offset when known.",
        "energyWindowSeconds":stride as f64 * dt,"onsetsTruncated":onsets.len() == 512}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav(pulses: bool) -> Vec<u8> {
        let rate = 8000u32;
        let samples: Vec<i16> = (0..rate * 8).map(|i| if pulses && i % 4000 < 80 { 16000 } else { 0 }).collect();
        let size = samples.len() as u32 * 2;
        let mut out = b"RIFF".to_vec(); out.extend((size + 36).to_le_bytes()); out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes()); out.extend(1u16.to_le_bytes()); out.extend(1u16.to_le_bytes());
        out.extend(rate.to_le_bytes()); out.extend((rate*2).to_le_bytes()); out.extend(2u16.to_le_bytes()); out.extend(16u16.to_le_bytes());
        out.extend(b"data"); out.extend(size.to_le_bytes());
        for sample in samples { out.extend(sample.to_le_bytes()); }
        out
    }
    #[test]
    fn detects_click_tempo_and_bounds_energy_without_inventing_silent_beats() {
        let cancel = AtomicBool::new(false);
        let result = analyze_wav(&wav(true), &cancel).unwrap();
        assert_eq!(result["duration"], 8.0);
        assert_eq!(result["tempo"]["bpm"], 120.0);
        assert_eq!(result["onsets"][1], 0.5);
        assert!(result["energy"].as_array().unwrap().len() <= 256);
        assert!(analyze_wav(&wav(false), &cancel).unwrap()["tempo"].is_null());
        assert!(analyze_wav(&wav(true), &AtomicBool::new(true)).unwrap_err().contains("cancelled"));
        let mut broken = wav(true); broken[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(analyze_wav(&broken, &cancel).is_err());
        for n in [0, 4, 11, 12, 24, 40, 50] { assert!(analyze_wav(&wav(true)[..n], &cancel).is_err()); }
    }
    #[test]
    fn explicit_beat_grid_uses_source_seconds_and_validates_ranges() {
        let grid = beats(3.0, 120.0, 0.25, 3).unwrap();
        assert_eq!(grid.len(), 6); assert_eq!(grid[3], json!({"index":3,"at":1.75,"bar":1,"beatInBar":0}));
        assert!(beats(30.0, 0.0, 0.0, 4).is_err());
        assert!(beats(30.0, 120.0, 30.0, 4).is_err());
        assert!(beats(30.0, f64::NAN, 0.0, 4).is_err());
    }
    #[test]
    fn reads_song_inputs_audio_and_clips_and_confines_file_access() {
        let mut config: ProjectConfig = serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap();
        let commands: Vec<crate::project::commands::ProjectCommand> = serde_json::from_value(json!([{"op":"music.add","id":"song","title":"Song","style":"Jazz","settings":{"lyrics":"Hello"}}])).unwrap();
        config = crate::project::commands::execute_commands_at(&config, &commands, &config.updated_at).unwrap();
        let root = tempfile::tempdir().unwrap(); let cancel = AtomicBool::new(false);
        let result = read(&config, root.path(), &MusicRead::Get { song: "song".into() }, &cancel).unwrap();
        assert_eq!(result["song"]["settings"]["lyrics"], "Hello");
        assert_eq!(result["generationInputsKnown"], false);
        assert!(read(&config, root.path(), &MusicRead::Analyze { song:"song".into() }, &cancel).is_err());
        config.assets.push(serde_json::from_value(json!({"id":"audio","name":"Song","kind":"audio","relativePath":"song.wav","durationMs":8000,"mimeType":"audio/wav","createdAt":config.created_at})).unwrap());
        config.music_songs[0].asset_id = Some("audio".into());
        std::fs::write(root.path().join("song.wav"), wav(true)).unwrap();
        assert_eq!(read(&config, root.path(), &MusicRead::Analyze { song:"song".into() }, &cancel).unwrap()["tempo"]["bpm"],120.0);
        config.assets.last_mut().unwrap().relative_path = Some("../outside.wav".into());
        assert!(read(&config, root.path(), &MusicRead::Analyze { song:"song".into() }, &cancel).is_err());
        for op in ["music.list", "music.get", "music.analyze", "music.beats"] {
            assert!(serde_json::from_value::<MusicRead>(json!({"op":op,"song":"song","path":"outside.wav"})).is_err());
        }
    }

    #[test]
    fn endpoint_inspects_music_then_returns_a_generation_request_without_writing_project() {
        use crate::agent::{AgentRuntime, AgentScope, AgentTurnRequest, AgentTurnResult, ProviderId};
        let project = tempfile::tempdir().unwrap();
        let fixture = include_str!("../../../fixtures/project-v1-complete.json");
        std::fs::write(project.path().join("slopus.json"),fixture).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1",server.server_addr());
        let handle = std::thread::spawn(move || {
            for (index,result) in [
                json!({"kind":"inspect","requests":[{"op":"music.list"},{"op":"music.get","song":"song"}]}),
                json!({"kind":"generation","summary":"Generate the song","command":{"op":"music.generate","song":"song","template":"yue"}})
            ].into_iter().enumerate() {
                let mut request = server.recv_timeout(std::time::Duration::from_secs(10)).unwrap().expect("provider request");
                let mut body = String::new(); request.as_reader().read_to_string(&mut body).unwrap();
                if index == 1 {
                    let body: Value = serde_json::from_str(&body).unwrap();
                    let content = body["messages"][1]["content"].as_str().unwrap();
                    assert!(content.contains("generationInputsKnown"));
                    assert!(content.contains("Hello song"));
                    assert!(content.contains("Music API reference"));
                }
                request.respond(tiny_http::Response::from_string(json!({"choices":[{"message":{"content":result.to_string()}}]}).to_string())).unwrap();
            }
        });
        let mut config: ProjectConfig = serde_json::from_str(fixture).unwrap();
        let commands: Vec<crate::project::commands::ProjectCommand> = serde_json::from_value(json!([{"op":"music.add","id":"song","title":"Intro","style":"Jazz","settings":{"lyrics":"Hello song"}}])).unwrap();
        config = crate::project::commands::execute_commands_at(&config,&commands,&config.updated_at).unwrap();
        config.provider_settings.insert("local".into(),serde_json::from_value(json!({"enabled":true,"model":"test","options":{"endpoint":endpoint}})).unwrap());
        let result = AgentRuntime::default().run_with_capture(AgentTurnRequest { request_id:"music-turn".into(),scope:AgentScope::Project,
            folder_path:project.path().to_string_lossy().into(), provider:ProviderId::Local,prompt:"Read song inputs and generate".into(),config,conversation:vec![],
            generators: super::super::generators::GeneratorContext { settings:json!({"templates":[{"id":"yue","modelType":"yue2"}]}),..Default::default() }
        }, |_| {}, |_,_| panic!("Music reads must not capture frames")).unwrap();
        assert!(matches!(result.result,AgentTurnResult::Generation { .. })); handle.join().unwrap();
        assert_eq!(std::fs::read_to_string(project.path().join("slopus.json")).unwrap(),fixture);
    }
}
