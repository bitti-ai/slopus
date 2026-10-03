//! Select opening latents without changing the source archive or runtime ABI.
//! The native setter owns its snapshot, so the temporary archive can be dropped
//! immediately after attachment. End selection uses the original archive.
use super::types::GenerationRequest;
use serde_json::{json, Value};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
};

pub(super) fn validate(request: &GenerationRequest) -> Result<(), String> {
    let overlap = request.continuation_overlap_frames.unwrap_or(22);
    if !(22..=362).contains(&overlap) || overlap % 17 != 5 {
        return Err("Continuation overlap must be 22, 39, 56, … frames (at most 362).".into());
    }
    if request
        .continuation_from
        .as_deref()
        .is_some_and(|value| !matches!(value, "start" | "end"))
    {
        return Err("Choose the beginning or end of the source scene.".into());
    }
    if request
        .continuation_source_frames
        .is_some_and(|frames| frames < overlap)
    {
        return Err("The selected scene is shorter than the continuation overlap.".into());
    }
    Ok(())
}

fn integer(meta: &Value, key: &str) -> Result<usize, String> {
    meta[key]
        .as_str()
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| format!("Invalid latent archive {key}."))
}

fn read_rows(
    file: &mut File,
    data_start: u64,
    header: &Value,
    name: &str,
    rows: usize,
    columns: usize,
    start: usize,
    count: usize,
) -> Result<Vec<u8>, String> {
    let tensor = &header[name];
    if tensor["dtype"] != "F32" || tensor["shape"] != json!([rows, columns]) {
        return Err(format!("Invalid {name} latent geometry."));
    }
    let begin = tensor["data_offsets"][0]
        .as_u64()
        .ok_or("Invalid latent offsets.")?;
    let end = tensor["data_offsets"][1]
        .as_u64()
        .ok_or("Invalid latent offsets.")?;
    let row_bytes = columns.checked_mul(4).ok_or("Latent row size overflow.")?;
    let size = rows
        .checked_mul(row_bytes)
        .ok_or("Latent tensor size overflow.")?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    if end.checked_sub(begin) != Some(size as u64)
        || start.checked_add(count).is_none_or(|n| n > rows)
        || data_start.checked_add(end).is_none_or(|n| n > file_size)
    {
        return Err("Truncated or invalid latent tensor.".into());
    }
    let offset = data_start
        .checked_add(begin)
        .and_then(|n| n.checked_add((start * row_bytes) as u64))
        .ok_or("Latent offset overflow.")?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![
        0;
        count
            .checked_mul(row_bytes)
            .ok_or("Latent slice size overflow.")?
    ];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub(super) fn opening_archive(
    request: &GenerationRequest,
) -> Result<Option<tempfile::TempPath>, String> {
    validate(request)?;
    if request.continuation_from.as_deref() != Some("start") {
        return Ok(None);
    }
    let path = request
        .continuation_path
        .as_ref()
        .ok_or("The continuation source has not been resolved.")?;
    let mut source = File::open(path).map_err(|e| format!("Could not read source latents: {e}"))?;
    let mut length = [0; 8];
    source.read_exact(&mut length).map_err(|e| e.to_string())?;
    let header_len = u64::from_le_bytes(length);
    if header_len > 1024 * 1024 {
        return Err("Invalid latent archive header length.".into());
    }
    let mut bytes = vec![0; header_len as usize];
    source.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let header: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let mut meta = header["__metadata__"].clone();
    if meta["slopfab_latents"] != "h3-av-v1" || meta["fps"] != "24" || meta["sampled"] != "1" {
        return Err("Continue requires completed H3 video latents.".into());
    }
    let frames = integer(&meta, "frames")?;
    let width = integer(&meta, "width")?;
    let height = integer(&meta, "height")?;
    if frames < 22
        || frames > i32::MAX as usize
        || frames % 17 != 5
        || width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || width % 32 != 0
        || height % 32 != 0
    {
        return Err("Invalid source latent geometry.".into());
    }
    let overlap = request.continuation_overlap_frames.unwrap_or(22) as usize;
    let scene_frames = request
        .continuation_source_frames
        .map(|n| n as usize)
        .unwrap_or(frames);
    if scene_frames < overlap || scene_frames > frames {
        return Err("Overlap exceeds the selected source scene.".into());
    }
    let latent_frames = |count: usize| (count - 5) / 17 * 5 + 2;
    let video_frames = latent_frames(frames);
    // Continued archives include earlier scenes. New frames add five latent
    // frames per 17 video frames; start at this scene's own latent contribution.
    let first_video = if scene_frames == frames {
        0
    } else {
        if scene_frames % 17 != 0 {
            return Err("Invalid continued scene length.".into());
        }
        video_frames
            .checked_sub(scene_frames / 17 * 5)
            .ok_or("Invalid scene latent range.")?
    };
    let row_frames = (width / 32)
        .checked_mul(height / 32)
        .ok_or("Latent canvas overflow.")?;
    let all_video = video_frames
        .checked_mul(row_frames)
        .ok_or("Latent geometry overflow.")?;
    let selected_video = latent_frames(overlap)
        .checked_mul(row_frames)
        .ok_or("Latent geometry overflow.")?;
    let audio_frames = frames
        .checked_mul(5)
        .and_then(|n| n.checked_add(1))
        .ok_or("Latent audio overflow.")?
        / 3;
    let first_audio = ((frames - scene_frames) * 5 + 1) / 3;
    let selected_audio = (overlap * 5 + 1) / 3;
    let video = read_rows(
        &mut source,
        header_len + 8,
        &header,
        "video_rows",
        all_video,
        96,
        first_video * row_frames,
        selected_video,
    )?;
    // Audio rows are planar stereo, not interleaved: crop each channel.
    let mut audio = read_rows(
        &mut source,
        header_len + 8,
        &header,
        "audio_rows",
        audio_frames * 2,
        32,
        first_audio,
        selected_audio,
    )?;
    audio.extend(read_rows(
        &mut source,
        header_len + 8,
        &header,
        "audio_rows",
        audio_frames * 2,
        32,
        audio_frames + first_audio,
        selected_audio,
    )?);
    meta["frames"] = json!(overlap.to_string());
    let mut output_header = json!({
        "__metadata__": meta,
        "video_rows": { "dtype": "F32", "shape": [selected_video, 96], "data_offsets": [0, video.len()] },
        "audio_rows": { "dtype": "F32", "shape": [selected_audio * 2, 32], "data_offsets": [video.len(), video.len() + audio.len()] },
    }).to_string();
    while output_header.len() % 8 != 0 {
        output_header.push(' ');
    }
    let mut output = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    output
        .write_all(&(output_header.len() as u64).to_le_bytes())
        .and_then(|_| output.write_all(output_header.as_bytes()))
        .and_then(|_| output.write_all(&video))
        .and_then(|_| output.write_all(&audio))
        .and_then(|_| output.flush())
        .map_err(|e| e.to_string())?;
    // Close the file handle before the DLL opens it (Windows sharing rules).
    Ok(Some(output.into_temp_path()))
}

#[cfg(test)]
mod tests {
    use super::super::{planning::resolve_plan, references::ReferenceVideos};
    use super::*;
    use std::collections::BTreeMap;

    fn archive(frames: usize) -> tempfile::NamedTempFile {
        let video_rows = ((frames - 5) / 17 * 5 + 2) * 2;
        let audio_rows = ((frames * 5 + 1) / 3) * 2;
        let video_bytes = video_rows * 96 * 4;
        let audio_bytes = audio_rows * 32 * 4;
        let mut header = json!({
            "__metadata__": { "slopfab_latents": "h3-av-v1", "width": "64", "height": "32", "frames": frames.to_string(), "fps": "24", "sampled": "1" },
            "video_rows": { "dtype": "F32", "shape": [video_rows, 96], "data_offsets": [0, video_bytes] },
            "audio_rows": { "dtype": "F32", "shape": [audio_rows, 32], "data_offsets": [video_bytes, video_bytes + audio_bytes] }
        }).to_string();
        while header.len() % 8 != 0 {
            header.push(' ');
        }
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&(header.len() as u64).to_le_bytes())
            .unwrap();
        file.write_all(header.as_bytes()).unwrap();
        for (rows, columns) in [(video_rows, 96), (audio_rows, 32)] {
            for row in 0..rows {
                for _ in 0..columns {
                    file.write_all(&(row as f32).to_le_bytes()).unwrap();
                }
            }
        }
        file.flush().unwrap();
        file
    }

    #[test]
    fn opening_continuation_crops_the_selected_scene_and_both_audio_channels() {
        let source = archive(124);
        let original = std::fs::read(source.path()).unwrap();
        let request = GenerationRequest {
            continuation_path: Some(source.path().into()),
            continuation_from: Some("start".into()),
            continuation_source_frames: Some(85),
            continuation_overlap_frames: Some(22),
            ..Default::default()
        };
        let cropped = opening_archive(&request).unwrap().unwrap();
        let bytes = std::fs::read(&cropped).unwrap();
        let start = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize + 8;
        let header: Value = serde_json::from_slice(&bytes[8..start]).unwrap();
        assert_eq!(header["__metadata__"]["frames"], "22");
        assert_eq!(header["video_rows"]["shape"], json!([14, 96]));
        let value = |at: usize| f32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        assert_eq!(value(start), 24.0); // First row of the selected scene, not the chain.
        let audio = start + header["audio_rows"]["data_offsets"][0].as_u64().unwrap() as usize;
        assert_eq!(value(audio), 65.0);
        assert_eq!(value(audio + 37 * 32 * 4), 272.0);
        assert_eq!(std::fs::read(source.path()).unwrap(), original);
        let temporary = cropped.to_path_buf();
        drop(cropped);
        assert!(!temporary.exists());
    }

    #[test]
    fn continuation_plans_custom_overlap_from_either_edge_with_the_bundled_runtime() {
        let source = archive(124).into_temp_path();
        for edge in ["start", "end"] {
            for overlap in [22, 39, 56] {
                let request = GenerationRequest {
                    job_id: "continued".into(),
                    prompt: "Keep moving".into(),
                    frames: 18,
                    steps: 4,
                    seed: 1,
                    canvas_width: 64,
                    canvas_height: 32,
                    continuation_path: Some(source.to_path_buf()),
                    continuation_from: Some(edge.into()),
                    continuation_overlap_frames: Some(overlap),
                    continuation_source_frames: Some(85),
                    ..Default::default()
                };
                let plan =
                    resolve_plan(&request, &BTreeMap::new(), &ReferenceVideos::default()).unwrap();
                let total = if edge == "start" { overlap + 34 } else { 124 + 34 };
                assert_eq!(plan.aligned_frames, total);
                assert!((plan.duration_seconds - total as f64 / 24.0).abs() < 0.0001);
                let wire = serde_json::to_value(&request).unwrap();
                assert_eq!(wire["continuationFrom"], edge);
                assert_eq!(wire["continuationOverlapFrames"], overlap);
                assert_eq!(wire["continuationSourceFrames"], 85);
            }
        }
    }

    #[test]
    fn continuation_rejects_invalid_ranges_and_truncated_archives() {
        for overlap in [0, 21, 23, 379] {
            assert!(validate(&GenerationRequest {
                continuation_overlap_frames: Some(overlap),
                ..Default::default()
            })
            .is_err());
        }
        assert!(validate(&GenerationRequest {
            continuation_source_frames: Some(17),
            ..Default::default()
        })
        .is_err());
        assert!(validate(&GenerationRequest {
            continuation_from: Some("middle".into()),
            ..Default::default()
        })
        .is_err());
        let source = archive(39);
        source.as_file().set_len(1024).unwrap();
        assert!(opening_archive(&GenerationRequest {
            continuation_path: Some(source.path().into()),
            continuation_from: Some("start".into()),
            ..Default::default()
        })
        .is_err());
    }
}
