use super::*;

#[test]
fn a_rendered_scene_lands_in_the_project_under_its_own_id() {
    let folder = project_folder();
    let (destination, relative) =
        generated_video_destination(&folder.path().to_string_lossy(), "job-initial-brief").unwrap();
    assert_eq!(relative, "media/generated/job-initial-brief.mp4");
    assert!(destination.ends_with("media/generated/job-initial-brief.mp4"));
    // The folder is made, so the write that follows has somewhere to go.
    assert!(destination.parent().unwrap().is_dir());
    // And it really is inside the project, not merely named as though it were.
    assert!(destination.starts_with(folder.path().canonicalize().unwrap()));
}

#[test]
fn latent_archives_are_unique_and_confined_to_the_project() {
    let folder = project_folder();
    let root = folder.path().to_string_lossy();
    let destination = generated_latent_destination(&root, "work-one").unwrap();
    assert!(destination.ends_with("latents/work-one.safetensors"));
    fs::write(&destination, b"archive").unwrap();
    assert!(generated_latent_destination(&root, "work-one").is_err());
    assert!(generated_latent_destination(&root, "../escape").is_err());
    let mut request: slopfab::GenerationRequest = serde_json::from_value(serde_json::json!({
        "jobId": "next", "prompt": "Continue", "frames": 119, "steps": 4, "seed": 1,
        "canvasWidth": 736, "canvasHeight": 416,
        "continuationRelativePath": "latents/work-one.safetensors",
        "saveLatentsPath": "C:/outside.safetensors", "continuationPath": "C:/outside.safetensors",
    }))
    .unwrap();
    assert!(request.save_latents_path.is_none());
    assert!(request.continuation_path.is_none());
    assert!(prepare_continuation_path(&mut request, None).is_err());
    prepare_continuation_path(&mut request, Some(&root)).unwrap();
    assert_eq!(request.continuation_path, Some(destination));
    for invalid in [
        "../outside.safetensors",
        "C:/outside.safetensors",
        "latents/missing.safetensors",
    ] {
        request.continuation_relative_path = Some(invalid.into());
        assert!(prepare_continuation_path(&mut request, Some(&root)).is_err());
    }
    let mut config = created_fixture();
    config.generation_jobs[0].latent_relative_path = Some("latents/work-one.safetensors".into());
    assert!(validate_and_normalize_config(config.clone()).is_ok());
    config.generation_jobs[0].latent_relative_path = Some("../outside.safetensors".into());
    assert!(validate_and_normalize_config(config).is_err());
}

#[test]
fn purging_timeline_thumbnails_removes_only_the_named_scene() {
    let folder = project_folder();
    let first = folder.path().join("thumbnails/timeline/job-first");
    let second = folder.path().join("thumbnails/timeline/job-second");
    fs::create_dir_all(&first).unwrap();
    fs::create_dir_all(&second).unwrap();
    fs::write(first.join("00000000.jpg"), b"first").unwrap();
    fs::write(second.join("00000000.jpg"), b"second").unwrap();

    purge_timeline_thumbnails(
        folder.path().to_string_lossy().into_owned(),
        "job-first".into(),
    )
    .unwrap();

    assert!(!first.exists());
    assert!(second.join("00000000.jpg").is_file());
}

#[test]
fn a_scene_id_that_is_not_a_scene_id_is_refused_rather_than_scrubbed() {
    let folder = project_folder();
    let root = folder.path().to_string_lossy().into_owned();
    for hostile in [
        "../../etc/passwd",
        "..",
        ".",
        "job/../../escape",
        r"job\..\escape",
        "job:stream",
        "job.mp4",
        "",
        "   ",
        &"j".repeat(65),
    ] {
        assert!(
            generated_video_destination(&root, hostile).is_err(),
            "'{hostile}' must not name a file"
        );
    }
    // A dot is refused too — nothing Slopus generates has one, and
    // allowing it is how a second extension gets in.
    assert!(generated_file_stem("job-01_A").is_ok());
    assert!(generated_file_stem("job.01").is_err());
}

#[test]
fn a_folder_that_holds_no_project_gets_no_writer() {
    // The same rule every other command that takes a folderPath follows:
    // confining a name against an unchecked folder confines nothing.
    let empty = tempfile::tempdir().unwrap();
    assert!(generated_video_destination(&empty.path().to_string_lossy(), "job-01").is_err());
    assert!(generated_video_destination("", "job-01").is_err());
}
