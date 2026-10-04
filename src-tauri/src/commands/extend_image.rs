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
        // Edge replication gives inpainting color/texture context instead of black borders.
        *source.get_pixel(
            (x as i32 + bounds.x).clamp(0, source.width() as i32 - 1) as u32,
            (y as i32 + bounds.y).clamp(0, source.height() as i32 - 1) as u32,
        )
    })
}

#[tauri::command]
pub(crate) fn prepare_extend_image(
    folder_path: String,
    job_id: String,
    source_id: String,
    bounds: ExtendBounds,
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
    bounds.validate(width, height)?;
    if asset.width != Some(width) || asset.height != Some(height) {
        return Err(
            "The source image dimensions changed. Reopen the image before extending it.".into(),
        );
    }
    let source = image::open(source_path)
        .map_err(|e| e.to_string())?
        .to_rgba8();
    let cache = root.directory(&directory(&job_id)?)?;
    // Snapshot the original so file changes during generation cannot alter preservation.
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
    let pixels = crate::rendered::frame(&job_id, 0)?.ok_or("The extended image has no pixels.")?;
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
            assert_eq!(
                padded.get_pixel(0, 0),
                source.get_pixel(bounds.x.clamp(0, 6) as u32, bounds.y.clamp(0, 4) as u32)
            );
        }
    }

    #[test]
    fn extend_snapshots_source_validates_bounds_and_cleans_only_its_cache() {
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets.push(serde_json::from_value(serde_json::json!({
            "id":"extend-source", "kind":"image", "name":"Source", "relativePath":"media/source.png", "mimeType":"image/png",
            "width":7, "height":5, "createdAt":config.created_at
        })).unwrap());
        crate::project::storage::write_project(folder.path(), &config).unwrap();
        let path = folder.path().to_string_lossy().into_owned();
        let root = ProjectRoot::open(&path).unwrap();
        let source = RgbaImage::from_pixel(7, 5, image::Rgba([30, 60, 90, 123]));
        write_png(
            &root.directory("media").unwrap().join("source.png"),
            &source,
        )
        .unwrap();
        let bounds = ExtendBounds {
            x: -3,
            y: 0,
            width: 10,
            height: 5,
        };
        prepare_extend_image(
            path.clone(),
            "extend-test".into(),
            "extend-source".into(),
            bounds,
        )
        .unwrap();
        prepare_extend_image(
            path.clone(),
            "extend-other".into(),
            "extend-source".into(),
            bounds,
        )
        .unwrap();
        let original_path = root
            .existing("cache/extend-images/extend-test/original.png")
            .unwrap();
        assert_eq!(image::open(&original_path).unwrap().to_rgba8(), source);
        assert_eq!(
            image::image_dimensions(
                root.existing("cache/extend-images/extend-test/canvas.png")
                    .unwrap()
            )
            .unwrap(),
            (10, 5)
        );
        write_png(
            &root.existing("media/source.png").unwrap(),
            &RgbaImage::new(7, 5),
        )
        .unwrap();
        assert_eq!(image::open(original_path).unwrap().to_rgba8(), source);
        for invalid in [
            ExtendBounds { x: 7, ..bounds },
            ExtendBounds {
                x: 0,
                width: 7,
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
                invalid
            )
            .is_err());
        }
        assert!(prepare_extend_image(
            path.clone(),
            "../outside".into(),
            "extend-source".into(),
            bounds
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
    fn extend_finalizer_writes_a_lossless_png_using_the_source_snapshot() {
        struct GeneratedPixels;
        impl crate::rendered::FrameSource for GeneratedPixels {
            fn frame_rgba(&self, _: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
                Ok([210, 180, 150, 255].repeat(width as usize * height as usize))
            }
        }
        let folder = tempfile::tempdir().unwrap();
        crate::project::storage::write_project(folder.path(), &crate::tests::created_fixture())
            .unwrap();
        let path = folder.path().to_string_lossy().into_owned();
        let root = ProjectRoot::open(&path).unwrap();
        let job = "extend-finalizer-test";
        let cache = root.directory(&directory(job).unwrap()).unwrap();
        let bounds = ExtendBounds {
            x: -2,
            y: 1,
            width: 9,
            height: 6,
        };
        let source = RgbaImage::from_fn(7, 5, |x, y| image::Rgba([x as u8, y as u8, 80, 123]));
        write_png(&cache.join("original.png"), &source).unwrap();
        std::fs::write(
            cache.join("bounds.json"),
            serde_json::to_vec(&bounds).unwrap(),
        )
        .unwrap();
        crate::rendered::keep(
            crate::rendered::from_source(
                job,
                Box::new(GeneratedPixels),
                vec![],
                1,
                9,
                6,
                3,
                9 * 6 * 3,
                24.0,
                0,
                0,
            )
            .unwrap(),
        );
        let saved = save_extended_image(path.clone(), job.into()).unwrap();
        let image = image::open(root.existing(&saved.relative_path).unwrap())
            .unwrap()
            .to_rgba8();
        for y in 0..6 {
            for x in 0..9 {
                assert_eq!(
                    image.get_pixel(x, y).0,
                    if x >= 2 && y < 4 {
                        source.get_pixel(x - 2, y + 1).0
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
