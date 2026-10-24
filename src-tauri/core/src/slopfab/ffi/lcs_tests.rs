use super::*;
use serde_json::json;

fn bundled_api() -> Api {
    Api::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../lib/slopfab").join(crate::slopfab::DLL_FILE_NAME)).unwrap()
}

fn calibration(path: &Path) {
    let mut header = json!({"__metadata__":{"slopfab_lcs":"1","vae_sha256":"a".repeat(64)}});
    let mut data = Vec::<u8>::new();
    let mut basis = vec![0_f32; 288];
    basis[0] = 1.; basis[4] = 1.; basis[8] = 1.;
    for (name, shape, values) in [
        ("basis", vec![96, 3], basis), ("mean", vec![96], vec![0.; 96]),
        ("anchor_lcs", vec![8, 3], vec![1.,0.,0., 0.,0.,1., 0.,1.,0., 1.,0.,1., 0.,1.,1., 1.,1.,0., 0.,0.,0., 1.,1.,1.]),
        ("latent_mean", vec![24], vec![0.; 24]), ("latent_std", vec![24], vec![1.; 24]),
        ("explained_variance", vec![1], vec![1.]),
    ] {
        let start = data.len();
        data.extend(values.into_iter().flat_map(f32::to_le_bytes));
        header[name] = json!({"dtype":"F32","shape":shape,"data_offsets":[start,data.len()]});
    }
    let mut header = header.to_string().into_bytes();
    while header.len() % 8 != 0 { header.push(b' '); }
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header); bytes.extend(data);
    std::fs::write(path, bytes).unwrap();
}

#[test]
fn bundled_lcs_snapshots_settings_and_validates_masks() {
    let api = bundled_api(); api.require_lcs().unwrap();
    let request = RequestHandle::new(&api).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let archive = folder.path().join("calibration.safetensors");
    calibration(&archive);
    let effects: crate::generation_effects::GenerationEffects = serde_json::from_str(include_str!("../../../../../fixtures/generation-effects.json")).unwrap();
    api.set_lcs(&request, &archive, &effects.native_settings().unwrap().unwrap().to_string()).unwrap();
    // Malformed native settings must fail without replacing the previous snapshot.
    for settings in [r#"{"strength":true}"#, "{broken", r#"{"typo":1}"#] {
        assert!(api.set_lcs(&request, &archive, settings).is_err());
    }
    std::fs::remove_file(archive).unwrap();
    let plan = api.resolve(&request).unwrap();
    let mask = effects.mask(plan.latent_width / 2, plan.latent_height / 2).unwrap().unwrap();
    api.set_lcs_mask(&request, &mask).unwrap();
    api.resolve(&request).unwrap();
    assert!(api.set_lcs_mask(&request, &[f32::NAN]).is_err());
    assert!(api.set_lcs_mask(&request, &[2.]).is_err());
    api.resolve(&request).unwrap();
    api.set_lcs_mask(&request, &[0.5]).unwrap();
    assert!(api.resolve(&request).is_err());
    api.set_lcs_mask(&request, &[]).unwrap();
    api.resolve(&request).unwrap();
    let other = bundled_api();
    assert!(other.set_lcs_mask(&request, &[]).unwrap_err().contains("different runtime"));
}

#[test]
fn calibration_cancellation_and_callback_panics_preserve_existing_archive() {
    let api = bundled_api();
    let request = RequestHandle::new(&api).unwrap();
    api.set_model(&request, 3, Path::new("missing-vae")).unwrap();
    let folder = tempfile::tempdir().unwrap();
    let archive = folder.path().join("existing.safetensors");
    std::fs::write(&archive, b"keep").unwrap();
    let mut called = false;
    assert!(api.calibrate_lcs(&request, &archive, &mut |done, total| {
        called = true; assert_eq!((done, total), (0, 80)); false
    }).is_err());
    assert!(called);
    assert_eq!(std::fs::read(&archive).unwrap(), b"keep");
    assert!(api.calibrate_lcs(&request, &archive, &mut |_, _| panic!("callback failure")).is_err());
    assert_eq!(std::fs::read(&archive).unwrap(), b"keep");
}
