use super::*;

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
