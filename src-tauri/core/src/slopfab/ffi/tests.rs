use super::*;

#[test]
fn continuation_lock_overlap_can_be_enabled_and_disabled() {
    // Exercise the bundled runtime, including when a running app holds an older staged DLL.
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../lib/slopfab")
        .join(crate::slopfab::DLL_FILE_NAME);
    let api = Api::load(&path).unwrap();
    let request = RequestHandle::new(&api).unwrap();
    api.set_frames(&request, 48).unwrap();
    api.set_resolution(&request, 64, 32).unwrap();
    api.set_continuation_lock_overlap(&request, true).unwrap();
    // Enabling the constraint requires an attached continuation source.
    assert!(api.resolve(&request).err().unwrap().contains("continuation"));
    api.set_continuation_lock_overlap(&request, false).unwrap();
    assert!(api.resolve(&request).is_ok());
}

#[test]
fn image_edit_setters_use_original_pixel_boxes_and_pad_the_plan() {
    let api = Api::load(&crate::slopfab::default_dll_path()).unwrap();
    let request = RequestHandle::new(&api).unwrap();
    let pixels = vec![100; 65 * 41 * 3];
    api.set_image_edit_rgb(&request, &pixels, 65, 41, [60, 35, 5, 6], 0).unwrap();
    let plan = api.resolve(&request).unwrap();
    assert_eq!((plan.canvas_width, plan.canvas_height, plan.aligned_frames), (96, 64, 1));
    assert!(api.set_image_edit_rgb(&request, &pixels, 65, 41, [60, 35, 6, 6], 0).is_err());
    assert!(api.set_image_edit_rgb(&request, &pixels[..3], 65, 41, [0, 0, 5, 6], 0).is_err());
    assert!(api.set_image_edit_rgb(&request, &pixels, 65, 41, [60, 35, 5, 6], -1).is_err());
    assert_eq!(api.resolve(&request).unwrap().canvas_width, 96);
    let folder = tempfile::tempdir().unwrap();
    let path = folder.path().join("source.png");
    image::RgbImage::from_raw(65, 41, pixels).unwrap().save(&path).unwrap();
    let from_path = RequestHandle::new(&api).unwrap();
    api.set_image_edit_path(&from_path, &path, [0, 0, 65, 41], 16).unwrap();
    std::fs::remove_file(path).unwrap(); // The setter snapshots pixels synchronously.
    assert_eq!(api.resolve(&from_path).unwrap().aligned_frames, 1);
}

#[test]
fn older_runtimes_reject_outpainting_instead_of_editing_the_original() {
    let mut api = Api::load(&crate::slopfab::default_dll_path()).unwrap();
    api.disable_outpainting_for_test();
    let request = RequestHandle::new(&api).unwrap();
    api.set_image_edit_rgb(&request, &vec![127; 64 * 64 * 3], 64, 64, [16, 16, 32, 32], 0).unwrap();
    assert!(api.set_image_edit_invert_mask(&request).unwrap_err().contains("API 1.20"));
    // Ordinary image editing remains available on older runtimes.
    assert!(api.resolve(&request).is_ok());
}

#[test]
fn older_runtimes_report_missing_lora_preparation_without_breaking_planning() {
    let mut api = Api::load(&crate::slopfab::default_dll_path()).unwrap();
    api.disable_lora_preparation_for_test();
    assert!(api
        .prepare_lora_grid(Path::new("adapter.safetensors"), 2688, false)
        .unwrap_err()
        .contains("API 1.13"));
    let request = RequestHandle::new(&api).unwrap();
    api.set_frames(&request, 48).unwrap();
    assert!(api.resolve(&request).is_ok());
}

#[test]
fn requests_retain_the_library_and_reject_cross_instance_calls() {
    let path = crate::slopfab::default_dll_path();
    let first = Api::load(&path).unwrap();
    let request = RequestHandle::new(&first).unwrap();
    let second = Api::load(&path).unwrap();
    assert!(second
        .set_prompt(&request, "wrong library instance")
        .is_err());
    drop(first);
    request
        .api
        .set_prompt(&request, "retained library")
        .unwrap();
    request.api.set_frames(&request, 48).unwrap();
    request.api.set_resolution(&request, 736, 416).unwrap();
    assert!(request.api.resolve(&request).unwrap().aligned_frames > 0);
}

#[test]
fn reference_registries_are_independent_sessions() {
    use crate::slopfab::references::ReferenceVideos;
    let first = ReferenceVideos::default();
    let second = ReferenceVideos::default();
    let id = first
        .create_reference_video(2.0, &Default::default())
        .unwrap();
    assert!(second
        .append_reference_video(&id, &[0; 16], 2, 2, 0.0)
        .is_err());
    first
        .append_reference_video(&id, &[0; 16], 2, 2, 0.0)
        .unwrap();
    first.release_reference_videos(&[id.clone()]).unwrap();
    assert!(first
        .append_reference_video(&id, &[0; 16], 2, 2, 1.0)
        .is_err());
}
