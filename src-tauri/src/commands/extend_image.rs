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
        return Err("Invalid Zoom source dimensions.".into());
    }
    let workspace = source_dimensions(width, height);
    bounds.validate(workspace.width, workspace.height)?;
    if bounds.width % 32 != 0
        || bounds.height % 32 != 0
        || bounds.width > MAX_GENERATION_EDGE
        || bounds.height > MAX_GENERATION_EDGE
        || u64::from(bounds.width) * u64::from(bounds.height) > MAX_GENERATION_PIXELS
    {
        return Err("Zoom box dimensions must be multiples of 32 within the maximum generation resolution.".into());
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
            "Zoom output must be aligned to 32 pixels within the maximum generation resolution."
                .into(),
        );
    }
    if bounds.is_contained(workspace.width, workspace.height) {
        return Ok((output, ExtendBounds { x: 0, y: 0, width: output.width, height: output.height }));
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
    if mapped.is_contained(source.width, source.height) {
        return Err("Expand the box further or increase the resolution to generate the extension.".into());
    }
    Ok((source, mapped))
}

impl ExtendBounds {
    fn is_contained(self, width: u32, height: u32) -> bool {
        self.x >= 0 && self.y >= 0
            && i64::from(self.x) + i64::from(self.width) <= i64::from(width)
            && i64::from(self.y) + i64::from(self.height) <= i64::from(height)
    }

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
            return Err("Invalid Zoom image dimensions.".into());
        }
        let right = self.x + self.width as i32;
        let bottom = self.y + self.height as i32;
        if self.x >= width as i32 || self.y >= height as i32 || right <= 0 || bottom <= 0 {
            return Err("The Zoom box must overlap the original image.".into());
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
        .ok_or("The Zoom source image no longer exists.")?;
    let source_path = if let Some(path) = &asset.relative_path {
        root.existing(path)?
    } else if let Some(path) = &asset.source_path {
        std::path::PathBuf::from(path)
    } else {
        return Err("The Zoom source has no saved file.".into());
    };
    let (width, height) = image::image_dimensions(&source_path).map_err(|e| e.to_string())?;
    let selection = bounds;
    let (scaled, bounds) = scaled_layout(width, height, selection, output)?;
    if asset.width != Some(width) || asset.height != Some(height) {
        return Err(
            "The source image dimensions changed. Reopen the image before extending it.".into(),
        );
    }
    let mut source = image::open(source_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let workspace = source_dimensions(width, height);
    if selection.is_contained(workspace.width, workspace.height) {
        // Crop in original pixels before resizing, so a tiny selection never
        // allocates a magnified copy of the entire source image.
        let left = (selection.x as u64 * width as u64 / workspace.width as u64) as u32;
        let top = (selection.y as u64 * height as u64 / workspace.height as u64) as u32;
        let right = ((selection.x as u64 + selection.width as u64) * width as u64)
            .div_ceil(workspace.width as u64) as u32;
        let bottom = ((selection.y as u64 + selection.height as u64) * height as u64)
            .div_ceil(workspace.height as u64) as u32;
        source = image::imageops::crop_imm(&source, left, top, right - left, bottom - top).to_image();
    }
    if source.dimensions() != (scaled.width, scaled.height) {
        source = image::imageops::resize(
            &source,
            scaled.width,
            scaled.height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let cache = root.directory(&directory(&job_id)?)?;
    // Snapshot the resized source or crop for native conditioning and final
    // transparency restoration, with no second resampling.
    write_png(&cache.join("original.png"), &source)?;
    write_png(&cache.join("canvas.png"), &padded_source(&source, bounds))?;
    crate::storage::atomic::write_atomically(
        &cache.join("bounds.json"),
        &serde_json::to_vec(&bounds).map_err(|e| e.to_string())?,
    )
}

// SlopFab returns the final RGB blend. Restore only source transparency;
// changing RGB here would apply a second blend over the native seam.
fn restore_source_alpha(result: &mut RgbaImage, source: &RgbaImage, bounds: ExtendBounds) {
    let left = bounds.x.max(0) as u32;
    let top = bounds.y.max(0) as u32;
    let right = (bounds.x + bounds.width as i32).min(source.width() as i32) as u32;
    let bottom = (bounds.y + bounds.height as i32).min(source.height() as i32) as u32;
    for y in top..bottom {
        for x in left..right {
            result.get_pixel_mut((x as i32 - bounds.x) as u32, (y as i32 - bounds.y) as u32)[3] = source.get_pixel(x, y)[3];
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
        return Err("The generated image does not match the Zoom box.".into());
    }
    let (_, pixels) = crate::rendered::take_still(&job_id)?;
    let mut result = RgbaImage::from_raw(bounds.width, bounds.height, pixels)
        .ok_or("Invalid generated image pixels.")?;
    if !bounds.is_contained(source.width(), source.height()) {
        restore_source_alpha(&mut result, &source, bounds);
    }
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
    /// Opt-in GPU smoke test. Supply an existing source image, model directory
    /// and artifact directory; ordinary test runs do not load any models.
    #[test]
    #[ignore]
    fn extend_gpu_smoke() {
        generation_smoke(false);
    }

    #[test]
    #[ignore]
    fn extend_crop_gpu_smoke() {
        generation_smoke(true);
    }

    fn generation_smoke(regenerate: bool) {
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
        let job = if regenerate { "extend-crop-gpu-smoke" } else { "extend-gpu-smoke" };
        let size = if regenerate { 768 } else { 416 };
        // Exercise extension at 416p or a contained crop regenerated at 768p.
        prepare_extend_image(
            path.clone(),
            job.into(),
            "source".into(),
            if regenerate { ExtendBounds { x: 32, y: 32, width: 192, height: 192 } }
            else { ExtendBounds { x: -64, y: -64, width: 384, height: 384 } },
            ExtendSize {
                width: size,
                height: size,
            },
        )
        .unwrap();
        let cache = folder.path().join(directory(job).unwrap());
        let snapshot = image::open(cache.join("original.png")).unwrap().to_rgba8();
        let canvas = cache.join("canvas.png");
        std::fs::copy(&canvas, artifact_dir.join("canvas.png")).unwrap();
        let prompt = "integrated_multimodal_description: [Shot 1] Match the source scene's visual style. One continuous scene matching Source scene's setting, perspective, subject scale, lighting and textures. The existing subjects remain at their canvas positions.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A";
        let prompt = if regenerate {
            "subject_definitions:\n<Picture 1> is the original source image and composition anchor for the edited still keyframe in [Shot 1], providing the framing, perspective, environment, lighting and visual style.\n\nsummary:\n[keyframe completion] The target is a single edited still keyframe based on <Picture 1>. Apply the described change while preserving all other content.\n\nretention_analysis:\n<Picture 1> ([Shot 1] edited keyframe): partially_preserved - retain its composition and visual characteristics except for the described change. Preserve all other content, including any previously completed edits.\n\ndetailed_description:\nThe still image retains the visual medium, lighting, palette and perspective of <Picture 1>.\n[Shot 1] Refine the selected crop in <Picture 1> at the target resolution. Recover natural fine detail and clean textures while preserving the subjects, composition, perspective, lighting and visual style.\n\noverall_soundscape: N/A\n\nnon_diegetic_music: N/A"
        } else { prompt };
        let step = if regenerate {
            serde_json::json!({"x":0,"y":0,"width":size,"height":size,"strength":0.65,"feather":0,"prompt":prompt})
        } else {
            serde_json::json!({"x":69,"y":69,"width":277,"height":277,"invertMask":true,"feather":0,"outpaintBlendOverlap":9,"outpaintLangevinSteps":5,"prompt":prompt})
        };
        let mut request: GenerationRequest = serde_json::from_value(serde_json::json!({
            "jobId":job, "stillImage":true, "frames":1, "steps":20, "seed":17, "canvasWidth":size, "canvasHeight":size, "prompt":prompt,
            "imageEdit":{"sourceRelativePath":"canvas.png", "edits":[step]}
        })).unwrap();
        if regenerate { request.reference_paths = vec![canvas.to_string_lossy().into_owned()]; }
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
        let raw = RgbaImage::from_raw(size, size, crate::rendered::frame(job, 0).unwrap().unwrap())
            .unwrap();
        write_png(&artifact_dir.join("raw.png"), &raw).unwrap();
        write_png(&artifact_dir.join("source.png"), &snapshot).unwrap();
        std::fs::copy(cache.join("bounds.json"), artifact_dir.join("bounds.json")).unwrap();
        let saved = save_extended_image(path.clone(), job.into()).unwrap();
        let final_path = folder.path().join(saved.relative_path);
        let result = image::open(&final_path).unwrap().to_rgba8();
        assert_eq!(result.dimensions(), (size, size));
        if regenerate {
            assert_eq!(result, raw, "The finalizer must retain regenerated pixels");
            assert_ne!(result, snapshot, "Generation must change the resized crop");
        } else {
            assert_eq!(result, raw, "Saving must retain the native Gaussian blend");
            for y in 8..snapshot.height() - 8 {
                for x in 8..snapshot.width() - 8 {
                    assert_eq!(result.get_pixel(x + 69, y + 69), snapshot.get_pixel(x, y));
                }
            }
            assert!(result
                .enumerate_pixels()
                .filter(|(x, y, _)| *x < 69 || *y < 69)
                .any(|(_, _, pixel)| pixel.0 != [127, 127, 127, 255]));
        }
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
    fn extend_restores_only_source_alpha_for_cropped_and_extended_bounds() {
        let source = RgbaImage::from_fn(64, 64, |x, y| image::Rgba([20, 40, 60, ((x + y) % 256) as u8]));
        for x in [-32, 0, 32] {
            for y in [-32, 0, 32] {
                let bounds = ExtendBounds { x, y, width: 96, height: 96 };
                let mut result = RgbaImage::from_pixel(96, 96, image::Rgba([210, 180, 150, 255]));
                restore_source_alpha(&mut result, &source, bounds);
                for (px, py, pixel) in result.enumerate_pixels() {
                    assert_eq!(&pixel.0[..3], &[210, 180, 150], "Never reblend native RGB");
                    let sx = px as i32 + x;
                    let sy = py as i32 + y;
                    let alpha = if (0..64).contains(&sx) && (0..64).contains(&sy) {
                        source.get_pixel(sx as u32, sy as u32)[3]
                    } else { 255 };
                    assert_eq!(pixel[3], alpha);
                }
            }
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
    fn contained_selection_crops_original_pixels_and_saves_regenerated_output() {
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
        let job = "extend-crop-finalizer-test";
        let source = RgbaImage::from_fn(128, 96, |x, y| image::Rgba([x as u8, y as u8, 80, 255]));
        write_png(&root.directory("media").unwrap().join("source.png"), &source).unwrap();
        prepare_extend_image(path.clone(), job.into(), "source".into(),
            ExtendBounds { x: 32, y: 32, width: 64, height: 32 }, ExtendSize { width: 256, height: 128 }).unwrap();
        let crop = image::imageops::crop_imm(&source, 32, 32, 64, 32).to_image();
        let expected = image::imageops::resize(&crop, 256, 128, image::imageops::FilterType::Lanczos3);
        let cache = root.path().join(directory(job).unwrap());
        for file in ["original.png", "canvas.png"] {
            assert_eq!(image::open(cache.join(file)).unwrap().to_rgba8(), expected);
        }
        let bounds: ExtendBounds = serde_json::from_slice(&std::fs::read(cache.join("bounds.json")).unwrap()).unwrap();
        assert_eq!((bounds.x, bounds.y, bounds.width, bounds.height), (0, 0, 256, 128));
        crate::rendered::keep(crate::rendered::from_source(job, Box::new(GeneratedPixels), vec![], 1,
            256, 128, 3, 256 * 128 * 3, 24.0, 0, 0).unwrap());
        let saved = save_extended_image(path.clone(), job.into()).unwrap();
        let result = image::open(root.existing(&saved.relative_path).unwrap()).unwrap().to_rgba8();
        assert_eq!(result, RgbaImage::from_pixel(256, 128, image::Rgba([210, 180, 150, 255])));
        assert!(crate::rendered::summary(job).is_none());
        // Even a tiny box in a large source is prepared at bounded output size.
        let (scaled, mapped) = scaled_layout(8192, 8192,
            ExtendBounds { x: 100, y: 100, width: 32, height: 32 }, ExtendSize { width: 768, height: 768 }).unwrap();
        assert_eq!((scaled.width, scaled.height, mapped.x, mapped.y), (768, 768, 0, 0));
        discard_extend_image(path, job.into()).unwrap();
    }

    #[test]
    fn extend_finalizer_retains_native_blend_and_restores_source_alpha() {
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
                    assert_eq!(&actual[..3], &[210, 180, 150]);
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
