use crate::media::artifacts::generated_file_stem;
use crate::project::{paths::ProjectRoot, storage::read_project};
use image::{ImageEncoder, RgbaImage};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(crate) struct ExtendBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub(crate) struct ExtendSize {
    width: u32,
    height: u32,
}
// Keep aligned with the largest current preset in src/lib/export.ts (2048p).
const MAX_GENERATION_EDGE: u32 = 3648;
const MAX_GENERATION_PIXELS: u64 = 3648 * 2048;

fn source_dimensions(width: u32, height: u32) -> ExtendSize {
    let scale = 1.0f64
        .min(MAX_GENERATION_EDGE as f64 / (width as f64 * 1.5))
        .min(MAX_GENERATION_EDGE as f64 / (height as f64 * 1.5))
        .min((MAX_GENERATION_PIXELS as f64 / (width as f64 * height as f64)).sqrt() / 1.5);
    ExtendSize {
        width: ((width as f64 * scale).floor() as u32).max(1),
        height: ((height as f64 * scale).floor() as u32).max(1),
    }
}

fn scaled_layout(
    width: u32,
    height: u32,
    bounds: ExtendBounds,
    output: ExtendSize,
) -> Result<(ExtendSize, ExtendBounds), String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 {
        return Err("Invalid Extend source dimensions.".into());
    }
    let workspace = source_dimensions(width, height);
    bounds.validate(workspace.width, workspace.height)?;
    if bounds.width % 32 != 0
        || bounds.height % 32 != 0
        || bounds.width > MAX_GENERATION_EDGE
        || bounds.height > MAX_GENERATION_EDGE
        || u64::from(bounds.width) * u64::from(bounds.height) > MAX_GENERATION_PIXELS
    {
        return Err("Extend box dimensions must be multiples of 32 within the maximum generation resolution.".into());
    }
    if output.width == 0
        || output.height == 0
        || output.width % 32 != 0
        || output.height % 32 != 0
        || output.width > MAX_GENERATION_EDGE
        || output.height > MAX_GENERATION_EDGE
        || u64::from(output.width) * u64::from(output.height) > MAX_GENERATION_PIXELS
    {
        return Err(
            "Extend output must be aligned to 32 pixels within the maximum generation resolution."
                .into(),
        );
    }
    let scale = (output.width as f64 / bounds.width as f64)
        .min(output.height as f64 / bounds.height as f64);
    let source = ExtendSize {
        width: ((workspace.width as f64 * scale).round() as u32).max(1),
        height: ((workspace.height as f64 * scale).round() as u32).max(1),
    };
    // Match JavaScript Math.round, including negative half-pixel positions.
    let mapped = ExtendBounds {
        x: (bounds.x as f64 * scale - (output.width as f64 - bounds.width as f64 * scale) / 2.0
            + 0.5)
            .floor() as i32,
        y: (bounds.y as f64 * scale - (output.height as f64 - bounds.height as f64 * scale) / 2.0
            + 0.5)
            .floor() as i32,
        width: output.width,
        height: output.height,
    };
    mapped.validate(source.width, source.height)?;
    Ok((source, mapped))
}

impl ExtendBounds {
    fn validate(self, width: u32, height: u32) -> Result<(), String> {
        if width == 0
            || height == 0
            || width > 8192
            || height > 8192
            || self.width == 0
            || self.height == 0
            || self.width > 8192
            || self.height > 8192
            || self.x.unsigned_abs() > 8192
            || self.y.unsigned_abs() > 8192
        {
            return Err("Invalid Extend image dimensions.".into());
        }
        let right = self.x + self.width as i32;
        let bottom = self.y + self.height as i32;
        if self.x >= width as i32 || self.y >= height as i32 || right <= 0 || bottom <= 0 {
            return Err("The Extend box must overlap the original image.".into());
        }
        if self.x >= 0 && self.y >= 0 && right <= width as i32 && bottom <= height as i32 {
            return Err("The Extend box must extend beyond the original image.".into());
        }
        Ok(())
    }
}

fn directory(job_id: &str) -> Result<String, String> {
    Ok(format!(
        "cache/extend-images/{}",
        generated_file_stem(job_id)?
    ))
}
fn write_png(path: &std::path::Path, image: &RgbaImage) -> Result<(), String> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;
    crate::storage::atomic::write_atomically(path, &bytes)
}

fn padded_source(source: &RgbaImage, bounds: ExtendBounds) -> RgbaImage {
    RgbaImage::from_fn(bounds.width, bounds.height, |x, y| {
        let sx = x as i32 + bounds.x;
        let sy = y as i32 + bounds.y;
        // Empty space must not contain replicated scene details for the model
        // to copy. The inpainting mask regenerates this neutral padding.
        if sx >= 0 && sy >= 0 && sx < source.width() as i32 && sy < source.height() as i32 {
            *source.get_pixel(sx as u32, sy as u32)
        } else {
            image::Rgba([127, 127, 127, 255])
        }
    })
}

#[tauri::command]
pub(crate) fn prepare_extend_image(
    folder_path: String,
    job_id: String,
    source_id: String,
    bounds: ExtendBounds,
    output: ExtendSize,
) -> Result<(), String> {
    let root = ProjectRoot::open(&folder_path)?;
    let project = read_project(root.path())?;
    let asset = project
        .config
        .assets
        .iter()
        .find(|asset| asset.id == source_id && asset.kind == "image")
        .ok_or("The Extend source image no longer exists.")?;
    let source_path = if let Some(path) = &asset.relative_path {
        root.existing(path)?
    } else if let Some(path) = &asset.source_path {
        std::path::PathBuf::from(path)
    } else {
        return Err("The Extend source has no saved file.".into());
    };
    let (width, height) = image::image_dimensions(&source_path).map_err(|e| e.to_string())?;
    let (scaled, bounds) = scaled_layout(width, height, bounds, output)?;
    if asset.width != Some(width) || asset.height != Some(height) {
        return Err(
            "The source image dimensions changed. Reopen the image before extending it.".into(),
        );
    }
    let mut source = image::open(source_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    if source.dimensions() != (scaled.width, scaled.height) {
        source = image::imageops::resize(
            &source,
            scaled.width,
            scaled.height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let cache = root.directory(&directory(&job_id)?)?;
    // Snapshot the resized original. Generation and final preservation use
    // exactly these pixels, with no second resampling.
    write_png(&cache.join("original.png"), &source)?;
    write_png(&cache.join("canvas.png"), &padded_source(&source, bounds))?;
    crate::storage::atomic::write_atomically(
        &cache.join("bounds.json"),
        &serde_json::to_vec(&bounds).map_err(|e| e.to_string())?,
    )
}

// Match EXTEND_SEAM in extendImage.ts. Only edges facing new pixels are free
// during denoising; keep the interior exact and fade across that free row.
const SEAM: u32 = 16;

fn smoothstep(value: f32) -> f32 {
    let t = value.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn restore_original(result: &mut RgbaImage, source: &RgbaImage, bounds: ExtendBounds) {
    let left = bounds.x.max(0) as u32;
    let top = bounds.y.max(0) as u32;
    let right = (bounds.x + bounds.width as i32).min(source.width() as i32) as u32;
    let bottom = (bounds.y + bounds.height as i32).min(source.height() as i32) as u32;
    let px = (left as i32 - bounds.x) as u32;
    let py = (top as i32 - bounds.y) as u32;
    let pr = px + right - left;
    let pb = py + bottom - top;
    let bands = [px, py, bounds.width - pr, bounds.height - pb];
    // Match color locally along each seam. A whole-edge average mixes unrelated
    // materials (e.g. snow and fur) and paints visible rectangular tone bands.
    // Prefix sums smooth the measured residual without blurring image detail.
    let mut profiles: [Vec<[f32; 3]>; 4] = std::array::from_fn(|_| Vec::new());
    for edge in 0..4 {
        if bands[edge] == 0 {
            continue;
        }
        let strip = 4.min(right - left).min(bottom - top);
        let length = if edge % 2 == 0 {
            bottom - top
        } else {
            right - left
        };
        let mut sums = vec![[0.0f32; 4]; length as usize + 1];
        for position in 0..length {
            let mut sum = sums[position as usize];
            for inward in 0..strip {
                let (x, y) = match edge {
                    0 => (left + inward, top + position),
                    1 => (left + position, top + inward),
                    2 => (right - 1 - inward, top + position),
                    _ => (left + position, bottom - 1 - inward),
                };
                let original = source.get_pixel(x, y);
                // Hidden RGB cannot describe the generated surroundings.
                if original[3] != 255 {
                    continue;
                }
                let generated =
                    result.get_pixel((x as i32 - bounds.x) as u32, (y as i32 - bounds.y) as u32);
                // Large residuals usually represent displaced detail, not an
                // exposure mismatch. Spreading them would create bright halos.
                if (0..3).any(|c| original[c].abs_diff(generated[c]) > 64) {
                    continue;
                }
                for c in 0..3 {
                    sum[c] += original[c] as f32 - generated[c] as f32;
                }
                sum[3] += 1.0;
            }
            sums[position as usize + 1] = sum;
        }
        profiles[edge] = (0..length)
            .map(|position| {
                let from = sums[position.saturating_sub(SEAM) as usize];
                let to = sums[(position + SEAM + 1).min(length) as usize];
                let count = to[3] - from[3];
                std::array::from_fn(|c| {
                    if count > 0.0 {
                        ((to[c] - from[c]) / count).clamp(-32.0, 32.0)
                    } else {
                        0.0
                    }
                })
            })
            .collect();
    }
    for (x, y, pixel) in result.enumerate_pixels_mut() {
        // Signed distances are positive outside the source and negative inside.
        let distances = [
            px as f32 - x as f32 - 0.5,
            py as f32 - y as f32 - 0.5,
            x as f32 + 0.5 - pr as f32,
            y as f32 + 0.5 - pb as f32,
        ];
        let along = [
            y as i32 - py as i32,
            x as i32 - px as i32,
            y as i32 - py as i32,
            x as i32 - px as i32,
        ];
        let weights: [f32; 4] = std::array::from_fn(|edge| {
            if bands[edge] == 0 {
                return 0.0;
            }
            let distance = distances[edge];
            let extent = if distance >= 0.0 { bands[edge] } else { SEAM } as f32;
            let position = along[edge];
            let nearest = position.clamp(0, profiles[edge].len() as i32 - 1);
            let tangent = (position - nearest) as f32;
            // Distance to the finite edge, not its infinite horizontal/vertical
            // line: corrections round the corners instead of forming a cross.
            1.0 - smoothstep(distance.hypot(tangent) / extent)
        });
        let sum: f32 = weights.iter().sum();
        let strength = weights.iter().copied().fold(0.0f32, f32::max);
        if sum > 0.0 {
            for c in 0..3 {
                let correction: f32 = (0..4)
                    .filter(|edge| weights[*edge] > 0.0)
                    .map(|edge| {
                        let position =
                            along[edge].clamp(0, profiles[edge].len() as i32 - 1) as usize;
                        weights[edge] * profiles[edge][position][c]
                    })
                    .sum();
                pixel[c] = (pixel[c] as f32 + correction / sum * strength)
                    .round()
                    .clamp(0.0, 255.0) as u8;
            }
        }
    }
    for y in top..bottom {
        for x in left..right {
            let distances = [x - left, y - top, right - 1 - x, bottom - 1 - y];
            let distance = (0..4)
                .filter(|edge| bands[*edge] > 0)
                .map(|edge| distances[edge])
                .min()
                .unwrap_or(SEAM);
            let original = source.get_pixel(x, y);
            let pixel =
                result.get_pixel_mut((x as i32 - bounds.x) as u32, (y as i32 - bounds.y) as u32);
            let weight = smoothstep((distance as f32 + 0.5) / SEAM as f32);
            if weight == 1.0 || original[3] == 0 {
                *pixel = *original;
            } else {
                for c in 0..3 {
                    pixel[c] = (pixel[c] as f32 * (1.0 - weight) + original[c] as f32 * weight)
                        .round() as u8;
                }
                pixel[3] = original[3];
            }
        }
    }
}

#[tauri::command]
pub(crate) fn save_extended_image(
    folder_path: String,
    job_id: String,
) -> Result<super::artifacts::GeneratedImageFile, String> {
    let root = ProjectRoot::open(&folder_path)?;
    let cache = directory(&job_id)?;
    let bounds: ExtendBounds = serde_json::from_slice(
        &std::fs::read(root.existing(&format!("{cache}/bounds.json"))?)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let source = image::open(root.existing(&format!("{cache}/original.png"))?)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    bounds.validate(source.width(), source.height())?;
    let summary =
        crate::rendered::summary(&job_id).ok_or("The extended image is no longer in memory.")?;
    if summary.frame_count != 1 || summary.width != bounds.width || summary.height != bounds.height
    {
        return Err("The generated image does not match the Extend box.".into());
    }
    let (_, pixels) = crate::rendered::take_still(&job_id)?;
    let mut result = RgbaImage::from_raw(bounds.width, bounds.height, pixels)
        .ok_or("Invalid generated image pixels.")?;
    restore_original(&mut result, &source, bounds);
    super::artifacts::write_generated_png_frame(
        &folder_path,
        &job_id,
        bounds.width,
        bounds.height,
        result.as_raw(),
    )
}

#[tauri::command]
pub(crate) fn discard_extend_image(folder_path: String, job_id: String) -> Result<(), String> {
    let root = ProjectRoot::open(&folder_path)?;
    let cache = directory(&job_id)?;
    if root.path().join(&cache).exists() {
        std::fs::remove_dir_all(root.existing(&cache)?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reuse a GPU smoke capture to compare compositing without another inference.
    #[test]
    #[ignore]
    fn extend_reblend_smoke() {
        let folder = std::path::PathBuf::from(std::env::var("SLOPUS_EXTEND_OUTPUT").unwrap());
        let source = image::open(folder.join("source.png")).unwrap().to_rgba8();
        let mut result = image::open(folder.join("raw.png")).unwrap().to_rgba8();
        let bounds: ExtendBounds =
            serde_json::from_slice(&std::fs::read(folder.join("bounds.json")).unwrap()).unwrap();
        bounds.validate(source.width(), source.height()).unwrap();
        restore_original(&mut result, &source, bounds);
        write_png(&folder.join("reblended.png"), &result).unwrap();
    }

    /// Opt-in GPU smoke test. Supply an existing source image, model directory
    /// and artifact directory; ordinary test runs do not load any models.
    #[test]
    #[ignore]
    fn extend_gpu_smoke() {
        use slopus_core::{
            settings::{ProviderOption, ProviderSetting},
            slopfab::{GenerationRequest, NativeEvent, SlopfabRuntime},
        };
        use std::{
            collections::BTreeMap,
            sync::{mpsc, Arc},
            time::Duration,
        };
        let weights = std::path::PathBuf::from(std::env::var("SLOPUS_E2E_WEIGHTS").unwrap());
        let source_path = std::env::var("SLOPUS_EXTEND_SOURCE").unwrap();
        let artifact_dir = std::path::PathBuf::from(std::env::var("SLOPUS_EXTEND_OUTPUT").unwrap());
        std::fs::create_dir_all(&artifact_dir).unwrap();
        let find = |part: &str| {
            std::fs::read_dir(&weights)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .find(|path| {
                    path.to_string_lossy().contains(part)
                        && path.extension().is_some_and(|ext| ext == "safetensors")
                })
                .unwrap_or_else(|| panic!("no {part} weights"))
                .to_string_lossy()
                .into_owned()
        };
        let options = BTreeMap::from([
            (
                "dllPath".into(),
                ProviderOption::String(
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join(if cfg!(windows) {
                            "../lib/slopfab/slopfab.dll"
                        } else {
                            "../lib/slopfab/libslopfab.so"
                        })
                        .to_string_lossy()
                        .into_owned(),
                ),
            ),
            (
                "transformer".into(),
                ProviderOption::String(
                    std::env::var("SLOPUS_EXTEND_TRANSFORMER")
                        .unwrap_or_else(|_| find("fl2va_pruned_int8")),
                ),
            ),
            (
                "textEncoder".into(),
                ProviderOption::String(find("qwen3vl_32b_minimax_h3_nvfp4")),
            ),
            (
                "videoVae".into(),
                ProviderOption::String(find("video_vae_fp16")),
            ),
            ("motionCache".into(), ProviderOption::Boolean(false)),
        ]);
        let settings = BTreeMap::from([(
            "slopfab".into(),
            ProviderSetting {
                enabled: true,
                model: None,
                options,
            },
        )]);
        let source = image::open(source_path).unwrap().to_rgba8();
        let source =
            image::imageops::resize(&source, 256, 256, image::imageops::FilterType::Lanczos3);
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets.push(serde_json::from_value(serde_json::json!({
            "id":"source", "kind":"image", "name":"Source", "relativePath":"source.png", "mimeType":"image/png",
            "width":256, "height":256, "createdAt":config.created_at
        })).unwrap());
        crate::project::storage::write_project(folder.path(), &config).unwrap();
        write_png(&folder.path().join("source.png"), &source).unwrap();
        let path = folder.path().to_string_lossy().into_owned();
        let job = "extend-gpu-smoke";
        // A 1.5x square selection rendered at 416p, matching the TS compiler.
        prepare_extend_image(
            path.clone(),
            job.into(),
            "source".into(),
            ExtendBounds {
                x: -64,
                y: -64,
                width: 384,
                height: 384,
            },
            ExtendSize {
                width: 416,
                height: 416,
            },
        )
        .unwrap();
        let cache = folder.path().join(directory(job).unwrap());
        let snapshot = image::open(cache.join("original.png")).unwrap().to_rgba8();
        let canvas = cache.join("canvas.png");
        std::fs::copy(&canvas, artifact_dir.join("canvas.png")).unwrap();
        let prompt = "integrated_multimodal_description: [Shot 1] Match the source scene's visual style. One continuous scene matching Source scene's setting, perspective, subject scale, lighting and textures. The existing subjects remain at their canvas positions.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
        let mut request: GenerationRequest = serde_json::from_value(serde_json::json!({
            "jobId":job, "stillImage":true, "frames":1, "steps":20, "seed":17, "canvasWidth":416, "canvasHeight":416, "prompt":prompt,
            "imageEdit":{"sourceRelativePath":"canvas.png", "edits":[{"x":85,"y":85,"width":245,"height":245,"invertMask":true,"feather":0,"prompt":prompt}]}
        })).unwrap();
        request.image_edit_path = Some(canvas);
        let runtime = SlopfabRuntime::default();
        let (send, receive) = mpsc::channel();
        runtime
            .enqueue(
                Arc::new(move |event| {
                    send.send(event).unwrap();
                }),
                request,
                &settings,
            )
            .unwrap();
        loop {
            match receive.recv_timeout(Duration::from_secs(600)).unwrap() {
                NativeEvent::Progress(event) => {
                    eprintln!("{}", serde_json::to_value(event).unwrap())
                }
                NativeEvent::Job(event) => {
                    let event = serde_json::to_value(event).unwrap();
                    if event["state"] == "framesReady" {
                        break;
                    }
                    assert!(
                        event["state"] != "failed" && event["state"] != "cancelled",
                        "{event}"
                    );
                }
            }
        }
        let raw = RgbaImage::from_raw(416, 416, crate::rendered::frame(job, 0).unwrap().unwrap())
            .unwrap();
        write_png(&artifact_dir.join("raw.png"), &raw).unwrap();
        write_png(&artifact_dir.join("source.png"), &snapshot).unwrap();
        std::fs::copy(cache.join("bounds.json"), artifact_dir.join("bounds.json")).unwrap();
        let saved = save_extended_image(path.clone(), job.into()).unwrap();
        let final_path = folder.path().join(saved.relative_path);
        let result = image::open(&final_path).unwrap().to_rgba8();
        assert_eq!(result.dimensions(), (416, 416));
        for y in 16..snapshot.height() - 16 {
            for x in 16..snapshot.width() - 16 {
                assert_eq!(result.get_pixel(x + 69, y + 69), snapshot.get_pixel(x, y));
            }
        }
        assert!(result
            .enumerate_pixels()
            .filter(|(x, y, _)| *x < 69 || *y < 69)
            .any(|(_, _, pixel)| pixel.0 != [127, 127, 127, 255]));
        std::fs::copy(final_path, artifact_dir.join("result.png")).unwrap();
        discard_extend_image(path, job.into()).unwrap();
        eprintln!("Inspect {}", artifact_dir.join("result.png").display());
    }

    #[test]
    fn extend_layout_matches_the_scaled_generation_canvas_and_allows_selected_resolution() {
        let bounds = ExtendBounds {
            x: -64,
            y: -32,
            width: 256,
            height: 160,
        };
        let output = ExtendSize {
            width: 128,
            height: 64,
        };
        let (source, mapped) = scaled_layout(128, 96, bounds, output).unwrap();
        assert_eq!(
            (
                source.width,
                source.height,
                mapped.x,
                mapped.y,
                mapped.width,
                mapped.height
            ),
            (51, 38, -38, -13, 128, 64)
        );
        let (source, mapped) = scaled_layout(
            128,
            96,
            bounds,
            ExtendSize {
                width: 512,
                height: 320,
            },
        )
        .unwrap();
        assert_eq!(
            (source.width, source.height, mapped.x, mapped.y),
            (256, 192, -128, -64)
        );
        assert!(scaled_layout(
            128,
            96,
            bounds,
            ExtendSize {
                width: 3648,
                height: 3648
            }
        )
        .is_err());
        assert!(scaled_layout(
            128,
            96,
            bounds,
            ExtendSize {
                width: 127,
                height: 64
            }
        )
        .is_err());
        assert!(scaled_layout(
            128,
            96,
            ExtendBounds {
                width: 257,
                ..bounds
            },
            output
        )
        .is_err());
        assert!(scaled_layout(
            8192,
            8192,
            ExtendBounds {
                width: 3648,
                height: 3648,
                ..bounds
            },
            output
        )
        .is_err());
    }

    #[test]
    fn extend_preserves_alpha_and_blends_only_inside_source_intersections() {
        let source = RgbaImage::from_fn(7, 5, |x, y| {
            image::Rgba([x as u8, y as u8, 80, (x * 25) as u8])
        });
        for bounds in [
            ExtendBounds {
                x: -3,
                y: -2,
                width: 12,
                height: 10,
            },
            ExtendBounds {
                x: 2,
                y: 1,
                width: 9,
                height: 7,
            },
            ExtendBounds {
                x: -2,
                y: -1,
                width: 5,
                height: 4,
            },
        ] {
            bounds.validate(source.width(), source.height()).unwrap();
            let mut result = RgbaImage::from_pixel(
                bounds.width,
                bounds.height,
                image::Rgba([200, 201, 202, 255]),
            );
            restore_original(&mut result, &source, bounds);
            for y in 0..bounds.height {
                for x in 0..bounds.width {
                    let sx = x as i32 + bounds.x;
                    let sy = y as i32 + bounds.y;
                    let actual = result.get_pixel(x, y).0;
                    if sx >= 0 && sy >= 0 && sx < 7 && sy < 5 {
                        let original = source.get_pixel(sx as u32, sy as u32).0;
                        assert_eq!(actual[3], original[3]);
                        if original[3] == 0 {
                            assert_eq!(actual, original);
                        }
                        for c in 0..3 {
                            assert!((original[c]..=[200, 201, 202][c]).contains(&actual[c]));
                        }
                    } else {
                        assert_eq!(actual, [200, 201, 202, 255]);
                    }
                }
            }
            let padded = padded_source(&source, bounds);
            for y in 0..bounds.height {
                for x in 0..bounds.width {
                    let sx = x as i32 + bounds.x;
                    let sy = y as i32 + bounds.y;
                    let expected = if sx >= 0 && sy >= 0 && sx < 7 && sy < 5 {
                        source.get_pixel(sx as u32, sy as u32).0
                    } else {
                        [127, 127, 127, 255]
                    };
                    assert_eq!(padded.get_pixel(x, y).0, expected);
                }
            }
        }
    }

    #[test]
    fn extend_matches_seam_tone_and_retains_interior_and_far_band_pixels() {
        // Exercise every direction, including a source cropped against canvas
        // edges. A constant exposure shift must not become a rectangular seam.
        let source = RgbaImage::from_pixel(96, 96, image::Rgba([80, 100, 120, 255]));
        for (x, y) in [(-64, -64), (0, 0), (32, -64), (-64, 32)] {
            let bounds = ExtendBounds {
                x,
                y,
                width: 224,
                height: 224,
            };
            let mut result = RgbaImage::from_pixel(224, 224, image::Rgba([110, 130, 150, 255]));
            restore_original(&mut result, &source, bounds);
            let left = (-x).max(0) as u32;
            let top = (-y).max(0) as u32;
            let right = (96 - x) as u32;
            let bottom = (96 - y) as u32;
            assert_eq!(
                result.get_pixel((left + right) / 2, (top + bottom) / 2).0,
                [80, 100, 120, 255]
            );
            for (a, b) in [
                ((right - 1, (top + bottom) / 2), (right, (top + bottom) / 2)),
                (
                    ((left + right) / 2, bottom - 1),
                    ((left + right) / 2, bottom),
                ),
            ] {
                for c in 0..3 {
                    assert!(
                        result.get_pixel(a.0, a.1)[c].abs_diff(result.get_pixel(b.0, b.1)[c]) <= 1
                    );
                }
            }
            assert_eq!(result.get_pixel(223, 223).0, [110, 130, 150, 255]);
        }
    }

    #[test]
    fn extend_matches_different_materials_along_the_same_edge() {
        let source = RgbaImage::from_fn(96, 128, |_, y| {
            let value = if y < 64 { 60 } else { 100 };
            image::Rgba([value, value, value, 255])
        });
        let mut result = RgbaImage::from_pixel(160, 128, image::Rgba([80, 80, 80, 255]));
        restore_original(
            &mut result,
            &source,
            ExtendBounds {
                x: -64,
                y: 0,
                width: 160,
                height: 128,
            },
        );
        // The old whole-edge average was zero, leaving both seams visible.
        for (y, expected) in [(24, 60u8), (104, 100u8)] {
            assert!(result.get_pixel(63, y)[0].abs_diff(expected) <= 1);
            assert!(result.get_pixel(64, y)[0].abs_diff(expected) <= 1);
            assert_eq!(result.get_pixel(0, y).0, [80, 80, 80, 255]);
            assert_eq!(result.get_pixel(100, y), source.get_pixel(36, y));
        }
    }

    #[test]
    fn extend_does_not_spread_displaced_high_contrast_details_into_the_surround() {
        let source = RgbaImage::from_pixel(96, 96, image::Rgba([40, 40, 40, 255]));
        let mut result = RgbaImage::from_fn(128, 96, |x, _| {
            let value = if (92..96).contains(&x) { 200 } else { 40 };
            image::Rgba([value, value, value, 255])
        });
        restore_original(
            &mut result,
            &source,
            ExtendBounds {
                x: 0,
                y: 0,
                width: 128,
                height: 96,
            },
        );
        for y in 0..96 {
            for x in 96..128 {
                assert_eq!(result.get_pixel(x, y).0, [40, 40, 40, 255]);
            }
        }
    }

    #[test]
    fn extend_fades_details_at_generated_edges_but_keeps_the_interior_exact() {
        // Nonopaque input bypasses tone matching, isolating the seam blend.
        let source = RgbaImage::from_pixel(96, 96, image::Rgba([40, 60, 80, 123]));
        let mut result = RgbaImage::from_pixel(128, 96, image::Rgba([200, 200, 200, 255]));
        restore_original(
            &mut result,
            &source,
            ExtendBounds {
                x: 0,
                y: 0,
                width: 128,
                height: 96,
            },
        );
        for y in 0..96 {
            for x in 0..80 {
                assert_eq!(result.get_pixel(x, y).0, [40, 60, 80, 123]);
            }
            for x in 80..96 {
                assert_eq!(result.get_pixel(x, y)[3], 123);
                assert!(result.get_pixel(x, y)[0] >= result.get_pixel(x - 1, y)[0]);
            }
            assert_eq!(result.get_pixel(96, y).0, [200, 200, 200, 255]);
        }
    }

    #[test]
    fn extend_snapshots_source_validates_bounds_and_cleans_only_its_cache() {
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets.push(serde_json::from_value(serde_json::json!({
            "id":"extend-source", "kind":"image", "name":"Source", "relativePath":"media/source.png", "mimeType":"image/png",
            "width":224, "height":160, "createdAt":config.created_at
        })).unwrap());
        crate::project::storage::write_project(folder.path(), &config).unwrap();
        let path = folder.path().to_string_lossy().into_owned();
        let root = ProjectRoot::open(&path).unwrap();
        let source = RgbaImage::from_pixel(224, 160, image::Rgba([30, 60, 90, 123]));
        write_png(
            &root.directory("media").unwrap().join("source.png"),
            &source,
        )
        .unwrap();
        let bounds = ExtendBounds {
            x: -96,
            y: 0,
            width: 320,
            height: 160,
        };
        let output = ExtendSize {
            width: 224,
            height: 96,
        };
        prepare_extend_image(
            path.clone(),
            "extend-test".into(),
            "extend-source".into(),
            bounds,
            output,
        )
        .unwrap();
        prepare_extend_image(
            path.clone(),
            "extend-other".into(),
            "extend-source".into(),
            bounds,
            output,
        )
        .unwrap();
        let original_path = root
            .existing("cache/extend-images/extend-test/original.png")
            .unwrap();
        let snapshot =
            image::imageops::resize(&source, 134, 96, image::imageops::FilterType::Lanczos3);
        assert_eq!(image::open(&original_path).unwrap().to_rgba8(), snapshot);
        assert_eq!(
            image::image_dimensions(
                root.existing("cache/extend-images/extend-test/canvas.png")
                    .unwrap()
            )
            .unwrap(),
            (224, 96)
        );
        write_png(
            &root.existing("media/source.png").unwrap(),
            &RgbaImage::new(224, 160),
        )
        .unwrap();
        assert_eq!(image::open(original_path).unwrap().to_rgba8(), snapshot);
        for invalid in [
            ExtendBounds { x: 224, ..bounds },
            ExtendBounds {
                x: 0,
                width: 224,
                ..bounds
            },
            ExtendBounds {
                width: 8193,
                ..bounds
            },
            ExtendBounds {
                x: i32::MIN,
                ..bounds
            },
        ] {
            assert!(prepare_extend_image(
                path.clone(),
                "invalid".into(),
                "extend-source".into(),
                invalid,
                output,
            )
            .is_err());
        }
        assert!(prepare_extend_image(
            path.clone(),
            "../outside".into(),
            "extend-source".into(),
            bounds,
            output,
        )
        .is_err());
        assert!(discard_extend_image(path.clone(), "../outside".into()).is_err());
        discard_extend_image(path.clone(), "extend-test".into()).unwrap();
        assert!(!root.path().join("cache/extend-images/extend-test").exists());
        assert!(root
            .existing("cache/extend-images/extend-other/original.png")
            .is_ok());
        assert!(root.existing("media/source.png").is_ok());
        discard_extend_image(path, "extend-test".into()).unwrap();
    }

    #[test]
    fn extend_finalizer_preserves_downscaled_source_pixels_in_a_bounded_png() {
        struct GeneratedPixels;
        impl crate::rendered::FrameSource for GeneratedPixels {
            fn frame_rgba(&self, _: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
                Ok([210, 180, 150, 255].repeat(width as usize * height as usize))
            }
        }
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets.push(serde_json::from_value(serde_json::json!({
            "id":"source", "kind":"image", "name":"Source", "relativePath":"media/source.png", "mimeType":"image/png",
            "width":128, "height":96, "createdAt":config.created_at
        })).unwrap());
        crate::project::storage::write_project(folder.path(), &config).unwrap();
        let path = folder.path().to_string_lossy().into_owned();
        let root = ProjectRoot::open(&path).unwrap();
        let job = "extend-finalizer-test";
        let bounds = ExtendBounds {
            x: -64,
            y: -32,
            width: 256,
            height: 160,
        };
        let source = RgbaImage::from_fn(128, 96, |x, y| image::Rgba([x as u8, y as u8, 80, 123]));
        write_png(
            &root.directory("media").unwrap().join("source.png"),
            &source,
        )
        .unwrap();
        prepare_extend_image(
            path.clone(),
            job.into(),
            "source".into(),
            bounds,
            ExtendSize {
                width: 128,
                height: 64,
            },
        )
        .unwrap();
        let scaled =
            image::imageops::resize(&source, 51, 38, image::imageops::FilterType::Lanczos3);
        // The original file may change while the job runs; its prepared snapshot wins.
        write_png(
            &root.existing("media/source.png").unwrap(),
            &RgbaImage::new(128, 96),
        )
        .unwrap();
        crate::rendered::keep(
            crate::rendered::from_source(
                job,
                Box::new(GeneratedPixels),
                vec![],
                1,
                128,
                64,
                3,
                128 * 64 * 3,
                24.0,
                0,
                0,
            )
            .unwrap(),
        );
        let saved = save_extended_image(path.clone(), job.into()).unwrap();
        assert!(crate::rendered::summary(job).is_none());
        let image = image::open(root.existing(&saved.relative_path).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(image.dimensions(), (128, 64));
        for y in 0..64 {
            for x in 0..128 {
                let actual = image.get_pixel(x, y).0;
                if (38..89).contains(&x) && (13..51).contains(&y) {
                    assert_eq!(actual[3], 123);
                    if (54..73).contains(&x) && (29..35).contains(&y) {
                        assert_eq!(actual, scaled.get_pixel(x - 38, y - 13).0);
                    }
                } else {
                    assert_eq!(actual, [210, 180, 150, 255]);
                }
            }
        }
        crate::rendered::release(job);
        discard_extend_image(path, job.into()).unwrap();
        assert!(root.existing(&saved.relative_path).is_ok());
    }
}
