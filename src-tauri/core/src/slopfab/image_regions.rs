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
    step: ImageEditStep,
    mask: Option<Vec<u8>>,
}

impl RegionEdit {
    pub fn prepare(request: &GenerationRequest, source: &RgbaImage) -> Result<Self, String> {
        super::planning::validate_generation_controls(request)?;
        let edit = request.image_edit.as_ref().ok_or("Missing image edits.")?;
        let size = edit.region_size.as_ref().ok_or("Missing image edit target dimensions.")?;
        let step = edit.edits.first().ok_or("Add an image edit before generating.")?.clone();
        let whole = step.mask_polygon.is_none() && step.mask_contours.is_none()
            && step.x == 0 && step.y == 0 && step.width == request.canvas_width && step.height == request.canvas_height;
        let width = if whole { source.width() } else { (size.width as u32).min(source.width()) };
        let height = if whole { source.height() } else { (size.height as u32).min(source.height()) };
        let x = (step.x - (width as i32 - step.width) / 2).clamp(0, (source.width() - width) as i32) as u32;
        let y = (step.y - (height as i32 - step.height) / 2).clamp(0, (source.height() - height) as i32) as u32;
        let crop = imageops::crop_imm(source, x, y, width, height).to_image();
        // Whole-image prompts remain global, processed at the selected size.
        // Local edits use source pixels at 1:1 scale and never shrink the canvas.
        let crop = if whole { imageops::resize(&crop, size.width as u32, size.height as u32, imageops::FilterType::Lanczos3) } else { crop };
        let (cw, ch) = crop.dimensions();
        let mut prepared = request.clone();
        prepared.canvas_width = cw as i32;
        prepared.canvas_height = ch as i32;
        prepared.image_edit_pixels = Some(Arc::new(crop.pixels().flat_map(|pixel| [pixel[0], pixel[1], pixel[2]]).collect()));
        let prepared_edit = prepared.image_edit.as_mut().unwrap();
        prepared_edit.region_size = None;
        prepared_edit.edits = vec![step.clone()];
        let local = &mut prepared_edit.edits[0];
        local.x = if whole { 0 } else { step.x - x as i32 };
        local.y = if whole { 0 } else { step.y - y as i32 };
        local.width = if whole { cw as i32 } else { step.width };
        local.height = if whole { ch as i32 } else { step.height };
        // Rectangle feathering is applied once, during the final merge, even
        // when the selection fills its inference crop.
        local.feather = Some(0);
        let transform = |point: &mut image_mask::MaskPoint| {
            point.x = ((point.x - x as f64) * cw as f64 / width as f64).clamp(0.0, cw as f64);
            point.y = ((point.y - y as f64) * ch as f64 / height as f64).clamp(0.0, ch as f64);
        };
        for point in local.mask_polygon.iter_mut().flatten().chain(local.mask_contours.iter_mut().flatten().flatten()) { transform(point); }
        let mask = if let Some(contours) = &local.mask_contours {
            Some(image_mask::rasterize_contours(contours, cw as i32, ch as i32)?)
        } else if let Some(points) = &local.mask_polygon {
            Some(image_mask::rasterize_polygon(points, cw as i32, ch as i32)?)
        } else { None };
        Ok(Self { request: prepared, x, y, width, height, step, mask })
    }

    pub fn merge(&self, source: &mut RgbaImage, result: &rendered::RenderedVideo) -> Result<(), String> {
        let (cw, ch) = (self.request.canvas_width as u32, self.request.canvas_height as u32);
        if result.width != cw || result.height != ch || result.frame_count != 1 {
            return Err("The image edit returned unexpected crop dimensions.".into());
        }
        let pixels = result.frame(0)?.ok_or("Image edit returned no pixels.")?;
        let crop = RgbaImage::from_raw(cw, ch, pixels).ok_or("Image edit returned incomplete pixels.")?;
        let crop = if crop.dimensions() != (self.width, self.height) {
            imageops::resize(&crop, self.width, self.height, imageops::FilterType::Lanczos3)
        } else { crop };
        let step = &self.step;
        let whole = step.x == 0 && step.y == 0 && step.width == source.width() as i32 && step.height == source.height() as i32;
        let feather = if whole { 0 } else { step.feather.unwrap_or(16) };
        for y in step.y as u32..(step.y + step.height) as u32 {
            for x in step.x as u32..(step.x + step.width) as u32 {
                let (cx, cy) = (x - self.x, y - self.y);
                let coverage = if let Some(mask) = &self.mask {
                    let mx = (cx as u64 * cw as u64 / self.width as u64) as usize;
                    let my = (cy as u64 * ch as u64 / self.height as u64) as usize;
                    mask[my * cw as usize + mx] as f32 / 255.0
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
        assert_eq!((region.x, region.y, region.width, region.height), (64, 33, 64, 64));
        let step = &region.request.image_edit.as_ref().unwrap().edits[0];
        assert_eq!((step.x, step.y, step.width, step.height), (16, 17, 32, 32));
        assert_eq!(&region.request.image_edit_pixels.as_ref().unwrap()[..3], &[64, 33, 70]);
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
    fn native_planning_uses_the_same_crop_and_rejects_oversized_or_misaligned_areas() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("source.png");
        source().save(&path).unwrap();
        let mut request = request();
        request.image_edit_path = Some(path);
        let region = prepare_first(&request).unwrap().unwrap();
        let configuration = super::super::config::Configuration::from_settings(&Default::default());
        let api = super::super::ffi::Api::load(&configuration.dll_path).unwrap();
        for purpose in [super::super::planning::RequestPurpose::Plan, super::super::planning::RequestPurpose::Generate] {
            let handle = super::super::ffi::RequestHandle::new(&api).unwrap();
            super::super::h3::configure_request(&api, &handle, &region.request, &configuration,
                super::super::platform::ComputePlatform::Cuda13, purpose, &Default::default()).unwrap();
            let plan = api.resolve(&handle).unwrap();
            assert_eq!((plan.canvas_width, plan.canvas_height), (64, 64));
        }
        let edit = request.image_edit.as_mut().unwrap();
        edit.edits[0].x = 0; edit.edits[0].width = 65;
        assert!(RegionEdit::prepare(&request, &source()).err().unwrap().contains("target resolution"));
        request.image_edit.as_mut().unwrap().region_size.as_mut().unwrap().width = 63;
        assert!(RegionEdit::prepare(&request, &source()).err().unwrap().contains("multiples of 32"));
    }
}
