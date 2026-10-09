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
        || output.width > bounds.width
        || output.height > bounds.height
        || u64::from(output.width) * u64::from(output.height) > u64::from(width) * u64::from(height)
    {
        return Err(
            "Extend output must be aligned to 32 pixels and cannot increase the source resolution."
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
    // Snapshot the downscaled original. Generation and final preservation use
    // exactly these pixels, with no second resampling or model changes to them.
    write_png(&cache.join("original.png"), &source)?;
    write_png(&cache.join("canvas.png"), &padded_source(&source, bounds))?;
    crate::storage::atomic::write_atomically(
        &cache.join("bounds.json"),
        &serde_json::to_vec(&bounds).map_err(|e| e.to_string())?,
    )
}

fn restore_original(result: &mut RgbaImage, source: &RgbaImage, bounds: ExtendBounds) {
    let left = bounds.x.max(0) as u32;
    let top = bounds.y.max(0) as u32;
    let right = (bounds.x + bounds.width as i32).min(source.width() as i32) as u32;
    let bottom = (bounds.y + bounds.height as i32).min(source.height() as i32) as u32;
    for y in top..bottom {
        for x in left..right {
            result.put_pixel(
                (x as i32 - bounds.x) as u32,
                (y as i32 - bounds.y) as u32,
                *source.get_pixel(x, y),
            );
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

    #[test]
    fn extend_layout_matches_the_scaled_generation_canvas_and_rejects_growth() {
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
        assert!(scaled_layout(
            128,
            96,
            bounds,
            ExtendSize {
                width: 256,
                height: 160
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
    fn extend_preserves_original_pixels_including_alpha_and_cropped_intersections() {
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
                    let expected = if sx >= 0 && sy >= 0 && sx < 7 && sy < 5 {
                        source.get_pixel(sx as u32, sy as u32).0
                    } else {
                        [200, 201, 202, 255]
                    };
                    assert_eq!(result.get_pixel(x, y).0, expected);
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
                assert_eq!(
                    image.get_pixel(x, y).0,
                    if (38..89).contains(&x) && (13..51).contains(&y) {
                        scaled.get_pixel(x - 38, y - 13).0
                    } else {
                        [210, 180, 150, 255]
                    }
                );
            }
        }
        crate::rendered::release(job);
        discard_extend_image(path, job.into()).unwrap();
        assert!(root.existing(&saved.relative_path).is_ok());
    }
}
