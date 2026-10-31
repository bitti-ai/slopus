//! Bounded inference crops are merged into a lossless, original-sized canvas.
use super::types::{GenerationRequest, ImageEditStep};
use crate::{image_mask, rendered};
use image::{imageops, RgbaImage};
use std::sync::Arc;

pub(super) fn load_source(request: &GenerationRequest) -> Result<RgbaImage, String> {
    let path = request.image_edit_path.as_ref().ok_or("Image edit source has not been resolved.")?;
    let size = image::image_dimensions(path).map_err(|e| format!("Could not read edit source: {e}"))?;
    if size != (request.canvas_width as u32, request.canvas_height as u32) {
        return Err("The source image dimensions changed. Reopen the image before editing.".into());
    }
    image::open(path).map(|image| image.into_rgba8()).map_err(|e| format!("Could not read edit source: {e}"))
}

pub(super) fn prepare_first(request: &GenerationRequest) -> Result<Option<RegionEdit>, String> {
    if request.image_edit.as_ref().and_then(|edit| edit.region_size.as_ref()).is_none() { return Ok(None); }
    RegionEdit::prepare(request, &load_source(request)?).map(Some)
}

pub(super) struct RegionEdit {
    pub request: GenerationRequest,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    whole: bool,
    step: ImageEditStep,
    mask: Option<Vec<u8>>,
    // Keep the crop on disk through inference without holding a writer open.
    _reference: Option<tempfile::TempPath>,
}

impl RegionEdit {
    pub fn prepare(request: &GenerationRequest, source: &RgbaImage) -> Result<Self, String> {
        super::planning::validate_generation_controls(request)?;
        let edit = request.image_edit.as_ref().ok_or("Missing image edits.")?;
        let size = edit.region_size.as_ref().ok_or("Missing image edit target dimensions.")?;
        let step = edit.edits.first().ok_or("Add an image edit before generating.")?.clone();
        let whole = step.mask_polygon.is_none() && step.mask_contours.is_none()
            && step.x == 0 && step.y == 0 && step.width == request.canvas_width && step.height == request.canvas_height;
        let align = |value: i32| ((value + 31) / 32 * 32) as u32;
        let cw = if whole { size.width as u32 } else { align(step.width) };
        let ch = if whole { size.height as u32 } else { align(step.height) };
        let width = if whole { source.width() } else { cw.min(source.width()) };
        let height = if whole { source.height() } else { ch.min(source.height()) };
        let x = (step.x - (width as i32 - step.width) / 2).clamp(0, (source.width() - width) as i32) as u32;
        let y = (step.y - (height as i32 - step.height) / 2).clamp(0, (source.height() - height) as i32) as u32;
        let crop = imageops::crop_imm(source, x, y, width, height).to_image();
        // Whole-image prompts remain global, processed at the selected size.
        // Local edits use source pixels at 1:1 scale and never shrink the canvas.
        let crop = if whole {
            imageops::resize(&crop, cw, ch, imageops::FilterType::Lanczos3)
        } else if (width, height) != (cw, ch) {
            // Extend edge pixels when the image itself is smaller than the grid.
            // Padding must never rescale the selection or its mask.
            RgbaImage::from_fn(cw, ch, |x, y| *crop.get_pixel(x.min(width - 1), y.min(height - 1)))
        } else { crop };
        let mut prepared = request.clone();
        let mut reference = None;
        if let Some(source_path) = &request.image_edit_path {
            let canonical = std::fs::canonicalize(source_path).ok();
            for path in prepared.reference_paths.iter_mut().chain(
                prepared.image_edit.iter_mut().flat_map(|edit| edit.edits.iter_mut())
                    .flat_map(|step| step.reference_paths.iter_mut().flatten())) {
                let matches = std::path::Path::new(&*path) == source_path
                    || canonical.as_ref().is_some_and(|source| std::fs::canonicalize(&*path).as_ref().ok() == Some(source));
                if !matches { continue; }
                if reference.is_none() {
                    let mut file = tempfile::Builder::new().prefix("slopus-edit-").suffix(".png").tempfile()
                        .map_err(|e| format!("Could not prepare cropped image reference: {e}"))?;
                    crop.write_to(file.as_file_mut(), image::ImageFormat::Png)
                        .map_err(|e| format!("Could not save cropped image reference: {e}"))?;
                    // Windows native image decoding denies write sharing. Close
                    // the writer now, retaining automatic cleanup after inference.
                    reference = Some(file.into_temp_path());
                }
                *path = reference.as_ref().unwrap().to_string_lossy().into_owned();
            }
        }
        prepared.canvas_width = cw as i32;
        prepared.canvas_height = ch as i32;
        prepared.image_edit_pixels = Some(Arc::new(crop.pixels().flat_map(|pixel| [pixel[0], pixel[1], pixel[2]]).collect()));
        let prepared_edit = prepared.image_edit.as_mut().unwrap();
        prepared_edit.region_size = None;
        prepared_edit.edits.truncate(1);
        let local = &mut prepared_edit.edits[0];
        local.x = if whole { 0 } else { step.x - x as i32 };
        local.y = if whole { 0 } else { step.y - y as i32 };
        local.width = if whole { cw as i32 } else { step.width };
        local.height = if whole { ch as i32 } else { step.height };
        // Rectangle feathering is applied once, during the final merge, even
        // when the selection fills its inference crop.
        local.feather = Some(0);
        let transform = |point: &mut image_mask::MaskPoint| {
            point.x -= x as f64;
            point.y -= y as f64;
        };
        for point in local.mask_polygon.iter_mut().flatten().chain(local.mask_contours.iter_mut().flatten().flatten()) { transform(point); }
        let mask = if let Some(contours) = &local.mask_contours {
            Some(image_mask::rasterize_contours(contours, cw as i32, ch as i32)?)
        } else if let Some(points) = &local.mask_polygon {
            Some(image_mask::rasterize_polygon(points, cw as i32, ch as i32)?)
        } else { None };
        Ok(Self { request: prepared, x, y, width, height, whole, step, mask, _reference: reference })
    }

    pub fn merge(&self, source: &mut RgbaImage, result: &rendered::RenderedVideo) -> Result<(), String> {
        let (cw, ch) = (self.request.canvas_width as u32, self.request.canvas_height as u32);
        if result.width != cw || result.height != ch || result.frame_count != 1 {
            return Err("The image edit returned unexpected crop dimensions.".into());
        }
        let pixels = result.frame(0)?.ok_or("Image edit returned no pixels.")?;
        let crop = RgbaImage::from_raw(cw, ch, pixels).ok_or("Image edit returned incomplete pixels.")?;
        let crop = if self.whole && crop.dimensions() != (self.width, self.height) {
            imageops::resize(&crop, self.width, self.height, imageops::FilterType::Lanczos3)
        } else { crop };
        let step = &self.step;
        let whole = step.x == 0 && step.y == 0 && step.width == source.width() as i32 && step.height == source.height() as i32;
        let feather = if whole { 0 } else { step.feather.unwrap_or(16) };
        for y in step.y as u32..(step.y + step.height) as u32 {
            for x in step.x as u32..(step.x + step.width) as u32 {
                let (cx, cy) = (x - self.x, y - self.y);
                let coverage = if let Some(mask) = &self.mask {
                    mask[(cy * cw + cx) as usize] as f32 / 255.0
                } else if feather > 0 {
                    let distance = (x as i32 - step.x).min(y as i32 - step.y)
                        .min(step.x + step.width - 1 - x as i32).min(step.y + step.height - 1 - y as i32);
                    (distance as f32 / feather as f32).min(1.0)
                } else { 1.0 };
                if coverage == 0.0 { continue; }
                let generated = crop.get_pixel(cx, cy);
                let original = source.get_pixel_mut(x, y);
                // SlopFab already composites lasso coverage; do not blend it twice.
                let blend = if self.mask.is_some() { 1.0 } else { coverage };
                for channel in 0..3 { original[channel] = (original[channel] as f32 * (1.0 - blend) + generated[channel] as f32 * blend).round() as u8; }
                original[3] = (original[3] as f32 * (1.0 - coverage) + 255.0 * coverage).round() as u8;
            }
        }
        Ok(())
    }
}

struct Still(RgbaImage);
impl rendered::FrameSource for Still {
    fn frame_rgba(&self, _: u32, _: u32, _: u32) -> Result<Vec<u8>, String> { Ok(self.0.as_raw().clone()) }
}
pub(super) fn rendered_image(job_id: &str, image: RgbaImage) -> Result<rendered::RenderedVideo, String> {
    let (width, height) = image.dimensions();
    rendered::from_source(job_id, Box::new(Still(image)), vec![], 1, width, height, 3,
        width as usize * height as usize * 3, 1.0, 0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> GenerationRequest {
        serde_json::from_value(serde_json::json!({
            "jobId":"crop", "prompt":"Change the flower", "frames":1, "stillImage":true, "steps":4, "seed":42,
            "canvasWidth":129, "canvasHeight":97, "imageEdit":{"sourceRelativePath":"source.png",
                "regionSize":{"width":64,"height":64}, "edits":[{"prompt":"Change the flower", "x":80,"y":50,"width":32,"height":32,"feather":0}]}
        })).unwrap()
    }
    fn source() -> RgbaImage { RgbaImage::from_fn(129, 97, |x, y| image::Rgba([x as u8, y as u8, 70, 120])) }
    fn generated(region: &RegionEdit) -> rendered::RenderedVideo {
        rendered_image("crop", RgbaImage::from_pixel(region.request.canvas_width as u32, region.request.canvas_height as u32, image::Rgba([250, 240, 230, 255]))).unwrap()
    }

    #[test]
    fn bounds_inference_and_merges_only_original_rectangle_including_alpha() {
        let mut source = source();
        let original = source.clone();
        let region = RegionEdit::prepare(&request(), &source).unwrap();
        assert_eq!((region.x, region.y, region.width, region.height), (80, 50, 32, 32));
        let step = &region.request.image_edit.as_ref().unwrap().edits[0];
        assert_eq!((step.x, step.y, step.width, step.height), (0, 0, 32, 32));
        assert_eq!(&region.request.image_edit_pixels.as_ref().unwrap()[..3], &[80, 50, 70]);
        region.merge(&mut source, &generated(&region)).unwrap();
        assert_eq!(source.dimensions(), (129, 97));
        for (x, y, pixel) in source.enumerate_pixels() {
            if (80..112).contains(&x) && (50..82).contains(&y) { assert_eq!(pixel.0, [250, 240, 230, 255]); }
            else { assert_eq!(pixel, original.get_pixel(x, y)); }
        }
    }

    #[test]
    fn lasso_holes_and_pixels_outside_the_outline_are_preserved() {
        let mut request = request();
        let points = |x: f64, y: f64, width: f64| vec![
            image_mask::MaskPoint { x, y }, image_mask::MaskPoint { x: x + width, y },
            image_mask::MaskPoint { x: x + width, y: y + width }, image_mask::MaskPoint { x, y: y + width }];
        request.image_edit.as_mut().unwrap().edits[0].mask_contours = Some(vec![points(80.0, 50.0, 32.0), points(88.0, 58.0, 16.0)]);
        let mut source = source();
        let original = source.clone();
        let region = RegionEdit::prepare(&request, &source).unwrap();
        region.merge(&mut source, &generated(&region)).unwrap();
        for (x, y, pixel) in source.enumerate_pixels() {
            if (80..112).contains(&x) && (50..82).contains(&y) && !((88..104).contains(&x) && (58..74).contains(&y)) {
                assert_eq!(pixel.0, [250, 240, 230, 255]);
            } else { assert_eq!(pixel, original.get_pixel(x, y)); }
        }
    }

    #[test]
    fn feathering_stays_inside_a_selection_that_fills_the_crop() {
        let mut request = request();
        let step = &mut request.image_edit.as_mut().unwrap().edits[0];
        step.width = 64; step.height = 64; step.x = 65; step.y = 33; step.feather = Some(8);
        let mut source = source();
        let original = source.clone();
        let region = RegionEdit::prepare(&request, &source).unwrap();
        region.merge(&mut source, &generated(&region)).unwrap();
        assert_eq!(source.get_pixel(65, 33), original.get_pixel(65, 33));
        assert_eq!(source.get_pixel(64, 50), original.get_pixel(64, 50));
        assert_eq!(source.get_pixel(90, 60).0, [250, 240, 230, 255]);
        assert_ne!(source.get_pixel(69, 50), original.get_pixel(69, 50));
        assert_ne!(source.get_pixel(69, 50).0, [250, 240, 230, 255]);
    }

    #[test]
    fn whole_image_prompts_keep_original_dimensions_with_target_sized_inference() {
        let mut request = request();
        let step = &mut request.image_edit.as_mut().unwrap().edits[0];
        step.x = 0; step.y = 0; step.width = 129; step.height = 97;
        let mut source = source();
        let region = RegionEdit::prepare(&request, &source).unwrap();
        assert_eq!((region.request.canvas_width, region.request.canvas_height), (64, 64));
        region.merge(&mut source, &generated(&region)).unwrap();
        assert_eq!(source.dimensions(), (129, 97));
        assert!(source.pixels().all(|pixel| pixel.0 == [250, 240, 230, 255]));
    }

    #[test]
    fn large_source_uses_only_aligned_selection_pixels_at_the_bottom_right_edge() {
        let mut request = request();
        request.canvas_width = 4352; request.canvas_height = 6529;
        let edit = request.image_edit.as_mut().unwrap();
        edit.region_size = Some(super::super::types::ImageEditRegionSize { width: 4352, height: 6560 });
        let step = &mut edit.edits[0];
        step.x = 3916; step.y = 5876; step.width = 436; step.height = 653;
        let mut source = RgbaImage::from_fn(4352, 6529, |x, y| image::Rgba([x as u8, y as u8, 70, 120]));
        let region = RegionEdit::prepare(&request, &source).unwrap();
        assert_eq!((region.request.canvas_width, region.request.canvas_height), (448, 672));
        assert_eq!(region.request.image_edit_pixels.as_ref().unwrap().len(), 448 * 672 * 3);
        assert_eq!((region.x, region.y), (3904, 5857));
        region.merge(&mut source, &generated(&region)).unwrap();
        for (x, y, pixel) in source.enumerate_pixels() {
            let expected = if x >= 3916 && y >= 5876 { [250, 240, 230, 255] } else { [x as u8, y as u8, 70, 120] };
            assert_eq!(pixel.0, expected);
        }
    }

    #[test]
    fn padding_a_small_source_preserves_lasso_coordinates_and_pixels() {
        let mut request = request();
        request.canvas_width = 17; request.canvas_height = 31;
        let step = &mut request.image_edit.as_mut().unwrap().edits[0];
        step.x = 0; step.y = 0; step.width = 17; step.height = 31;
        step.mask_polygon = Some(vec![image_mask::MaskPoint { x: 0.0, y: 0.0 },
            image_mask::MaskPoint { x: 17.0, y: 0.0 }, image_mask::MaskPoint { x: 0.0, y: 31.0 }]);
        let mut source = RgbaImage::from_fn(17, 31, |x, y| image::Rgba([x as u8, y as u8, 70, 120]));
        let original = source.clone();
        let region = RegionEdit::prepare(&request, &source).unwrap();
        assert_eq!((region.request.canvas_width, region.request.canvas_height), (32, 32));
        let input = region.request.image_edit_pixels.as_ref().unwrap();
        for y in 0..32 { for x in 0..32 {
            assert_eq!(&input[(y * 32 + x) * 3..(y * 32 + x + 1) * 3], &[x.min(16) as u8, y.min(30) as u8, 70]);
        }}
        assert_eq!(region.request.image_edit.as_ref().unwrap().edits[0].mask_polygon,
            request.image_edit.as_ref().unwrap().edits[0].mask_polygon);
        region.merge(&mut source, &generated(&region)).unwrap();
        assert_eq!(source.dimensions(), (17, 31));
        assert_eq!(source.get_pixel(16, 30), original.get_pixel(16, 30));
        assert_eq!(source.get_pixel(1, 1).0, [250, 240, 230, 255]);
    }

    #[test]
    fn native_planning_uses_the_same_crop_and_rejects_oversized_or_misaligned_areas() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        source().save(&path).unwrap();
        let mut request = request();
        request.image_edit_path = Some(path);
        request.reference_paths = vec![request.image_edit_path.as_ref().unwrap().to_string_lossy().into_owned()];
        request.image_edit.as_mut().unwrap().edits[0].reference_paths = Some(request.reference_paths.clone());
        let region = prepare_first(&request).unwrap().unwrap();
        let reference = std::path::PathBuf::from(&region.request.reference_paths[0]);
        assert_ne!(reference, request.image_edit_path.as_ref().unwrap().as_path());
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Native reference decoding opens with read sharing only. An open
            // temporary-file writer would fail here with ERROR_SHARING_VIOLATION.
            let reader = std::fs::OpenOptions::new().read(true).share_mode(1).open(&reference).unwrap();
            assert!(reader.metadata().unwrap().len() > 0);
        }
        let crop = image::open(&reference).unwrap().to_rgb8();
        assert_eq!(crop.dimensions(), (32, 32));
        assert_eq!(crop.as_raw(), region.request.image_edit_pixels.as_ref().unwrap().as_ref());
        assert_eq!(region.request.image_edit.as_ref().unwrap().edits[0].reference_paths.as_ref().unwrap(), &region.request.reference_paths);
        let configuration = super::super::config::Configuration::from_settings(&Default::default());
        let api = super::super::ffi::Api::load(&configuration.dll_path).unwrap();
        for purpose in [super::super::planning::RequestPurpose::Plan, super::super::planning::RequestPurpose::Generate] {
            let handle = super::super::ffi::RequestHandle::new(&api).unwrap();
            super::super::h3::configure_request(&api, &handle, &region.request, &configuration,
                super::super::platform::ComputePlatform::Cuda13, purpose, &Default::default()).unwrap();
            let plan = api.resolve(&handle).unwrap();
            assert_eq!((plan.canvas_width, plan.canvas_height), (32, 32));
        }
        drop(region);
        assert!(!reference.exists());
        let edit = request.image_edit.as_mut().unwrap();
        edit.edits[0].x = 0; edit.edits[0].width = 65;
        assert!(RegionEdit::prepare(&request, &source()).err().unwrap().contains("target resolution"));
        request.image_edit.as_mut().unwrap().region_size.as_mut().unwrap().width = 63;
        assert!(RegionEdit::prepare(&request, &source()).err().unwrap().contains("multiples of 32"));
    }
}
