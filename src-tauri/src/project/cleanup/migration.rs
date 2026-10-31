//! Runs once for each existing project when the startup library loads it (or
//! when a previously unknown project is first opened). Never run from a save.
use super::{checked_target, collect, files, path_key, retained, Cleanup, ProjectConfig, ProjectRoot, JOURNAL};
use serde_json::Value;
use std::{collections::BTreeSet, fs, path::{Path, PathBuf}, sync::Mutex};

const MARKER: &str = ".generated-orphans-v1.json";
const ROOTS: [&str; 5] = ["media/generated", "latents", "cache/scene-last", "cache/image-edits", "thumbnails/timeline"];
// Even a failed migration is attempted only once per app run. A later library
// refresh must not sweep files produced by a generation that has since started.
static OPENED: Mutex<BTreeSet<(PathBuf, String)>> = Mutex::new(BTreeSet::new());

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker { project_id: String }

fn session_key(root: &ProjectRoot, config: &ProjectConfig) -> (PathBuf, String) {
    #[cfg(windows)]
    let folder = PathBuf::from(root.path().to_string_lossy().to_lowercase());
    #[cfg(not(windows))]
    let folder = root.path().to_owned();
    (folder, config.id.clone())
}

fn write_marker(root: &ProjectRoot, config: &ProjectConfig) -> Result<(), String> {
    crate::storage::atomic::write_atomically(&root.path().join(MARKER),
        &serde_json::to_vec(&Marker { project_id: config.id.clone() }).map_err(|error| error.to_string())?)
}

pub(in crate::project) fn mark_new_project(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    let root = ProjectRoot::from_directory(folder)?;
    write_marker(&root, config)?;
    OPENED.lock().map_err(|_| "Project migration lock was poisoned.".to_string())?
        .insert(session_key(&root, config));
    Ok(())
}

pub(in crate::project) fn migrate_on_open(folder: &Path, config: &ProjectConfig) -> Result<(), String> {
    let root = ProjectRoot::from_directory(folder)?;
    if !OPENED.lock().map_err(|_| "Project migration lock was poisoned.".to_string())?
        .insert(session_key(&root, config)) { return Ok(()); }
    migrate(&root, config)
}

fn migrate(root: &ProjectRoot, config: &ProjectConfig) -> Result<(), String> {
    let migrated = match checked_target(root, MARKER)? {
        Some(path) => {
            let marker: Marker = serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Could not read generated-file migration marker: {error}"))?;
            marker.project_id == config.id
        }
        None => false,
    };
    let mut live = files(config, root)?;
    collect_resolved_paths(&serde_json::to_value(config).map_err(|error| error.to_string())?, root, &mut live);
    let mut candidates = BTreeSet::new();
    if !migrated {
        for directory in ROOTS { scan(root, directory, &live, &mut candidates)?; }
    }
    // Merge into the normal retry journal BEFORE marking completion. A crash
    // or locked file never loses the candidate list, and subsequent launches
    // retry that list without rescanning the directories.
    let mut cleanup = Cleanup::prepare(root.path(), None, config)?;
    cleanup.pending.extend(candidates);
    cleanup.pending.retain(|path| !retained(path, &live));
    if !cleanup.pending.is_empty() || root.path().join(JOURNAL).exists() { cleanup.persist()?; }
    if !migrated { write_marker(root, config)?; }
    cleanup.finish(&[]);
    Ok(())
}

fn scan(root: &ProjectRoot, relative: &str, live: &BTreeSet<String>, candidates: &mut BTreeSet<String>) -> Result<(), String> {
    let key = path_key(relative).ok_or_else(|| format!("Invalid generated-file path: {relative}"))?;
    // Some live entries name a derived directory, whose contents are all live.
    if live.iter().any(|keep| keep == &key || key.starts_with(&format!("{keep}/"))) { return Ok(()); }
    let Some(path) = checked_target(root, relative)? else { return Ok(()); };
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| format!("Could not scan {relative}: {error}"))? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().into_string().map_err(|_| "Generated filename is not valid UTF-8.".to_string())?;
            scan(root, &format!("{relative}/{name}"), live, candidates)?;
        }
        if (key.starts_with("thumbnails/timeline/") || key.starts_with("cache/image-edits/")) && !retained(&key, live) {
            candidates.insert(key);
        }
    } else if !retained(&key, live) { candidates.insert(key); }
    Ok(())
}

// A reference may reach a generated file through an absolute sourcePath or a
// link under references/. Preserve the resolved target as well as the recorded
// path. The scan itself never follows such links.
fn collect_resolved_paths(value: &Value, root: &ProjectRoot, live: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => for item in items { collect_resolved_paths(item, root, live); },
        Value::Object(fields) => for (key, value) in fields {
            if let Some(path) = value.as_str() {
                let resolved = if key == "sourcePath" { Path::new(path).canonicalize().ok() }
                    else if key == "relativePath" || key.ends_with("RelativePath") || key == "thumbnail" { root.existing(path).ok() }
                    else { None };
                if let Some(relative) = resolved.as_ref().and_then(|path| path.strip_prefix(root.path()).ok()) {
                    collect(&serde_json::json!({"relativePath": relative.to_string_lossy()}), root, live);
                }
            } else { collect_resolved_paths(value, root, live); }
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{storage::{read_project, write_project}, ProjectAsset, SceneMediaSegment};

    fn touch(root: &Path, relative: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"generated").unwrap();
    }

    fn asset(id: &str, path: &str, kind: &str) -> ProjectAsset {
        serde_json::from_value(serde_json::json!({"id": id, "kind": kind, "name": id, "relativePath": path,
            "mimeType": if kind == "generated" { "video/mp4" } else { "image/png" }, "createdAt": "2026-01-01T00:00:00.000Z"})).unwrap()
    }

    fn link_directory(link: &Path, target: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            assert!(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:SLOPUS_TEST_LINK -Target $env:SLOPUS_TEST_TARGET | Out-Null"])
                .env("SLOPUS_TEST_LINK", link).env("SLOPUS_TEST_TARGET", target)
                .creation_flags(0x0800_0000).status().unwrap().success());
        }
    }

    #[test]
    fn startup_open_removes_legacy_orphans_and_preserves_all_live_dependencies() {
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        let mut video = asset("asset-scene", "media/generated/video.mp4", "generated");
        video.scene_segments = Some(vec![SceneMediaSegment { scene_id: "scene".into(), latent_relative_path: "latents/shared.safetensors".into(), start_frame: 0, frame_count: 24 }]);
        let mut edited = asset("edited", "media/generated/edited.png", "image");
        let mut recipe: Value = serde_json::from_str(include_str!("../../../../fixtures/image-generation-snapshot.json")).unwrap();
        recipe["scene"]["rootType"] = "image".into();
        recipe["scene"]["sourceImage"] = serde_json::json!({"relativePath": "media/generated/source.png", "name": "Source", "width": 640, "height": 480});
        edited.image_generation = Some(serde_json::from_value(recipe).unwrap());
        let mut absolute = asset("absolute", "media/generated/absolute.png", "image");
        absolute.source_path = Some(folder.path().join(absolute.relative_path.take().unwrap()).to_string_lossy().into_owned());
        config.assets = vec![video, edited, absolute];
        config.thumbnail = Some("media/generated/cover.jpg".into());
        write_project(folder.path(), &config).unwrap();
        let before = fs::read(folder.path().join("slopus.json")).unwrap();
        let live = ["media/generated/video.mp4", "latents/shared.safetensors", "media/generated/edited.png", "media/generated/source.png",
            "media/generated/absolute.png", "media/generated/cover.jpg", "cache/scene-last/video.png", "cache/image-edits/edited/resized.png", "thumbnails/timeline/scene/00000000.jpg"];
        let orphaned = ["media/generated/old.mp4", "media/generated/old.png", "media/generated/old.wav", "media/generated/old-cover.jpg", "latents/old.safetensors",
            "cache/scene-last/old.png", "cache/image-edits/0123456789abcdef.png", "cache/image-edits/old/resized.png", "thumbnails/timeline/old/00000000.jpg"];
        let untouched = ["media/imported/original.png", "references/portrait.png", "exports/final.mp4", "notes.txt"];
        for path in live.iter().chain(orphaned.iter()).chain(untouched.iter()) { touch(folder.path(), path); }
        let opened = crate::commands::project::open_project(folder.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(opened.config, read_project(folder.path()).unwrap().config);
        assert_eq!(fs::read(folder.path().join("slopus.json")).unwrap(), before);
        assert!(folder.path().join(MARKER).is_file());
        for path in live.iter().chain(untouched.iter()) { assert!(folder.path().join(path).exists(), "lost {path}"); }
        for path in orphaned { assert!(!folder.path().join(path).exists(), "left {path}"); }
        assert!(!folder.path().join("cache/image-edits/old").exists());
        assert!(!folder.path().join("thumbnails/timeline/old").exists());
    }

    #[test]
    fn saves_and_internal_reads_do_not_migrate_and_the_scan_never_repeats() {
        let folder = tempfile::tempdir().unwrap();
        let config = crate::tests::created_fixture();
        write_project(folder.path(), &config).unwrap();
        touch(folder.path(), "media/generated/orphan.mp4");
        read_project(folder.path()).unwrap();
        write_project(folder.path(), &config).unwrap();
        assert!(folder.path().join("media/generated/orphan.mp4").exists());
        let root = ProjectRoot::from_directory(folder.path()).unwrap();
        migrate_on_open(folder.path(), &config).unwrap();
        assert!(!folder.path().join("media/generated/orphan.mp4").exists());
        touch(folder.path(), "media/generated/in-flight.mp4");
        migrate_on_open(folder.path(), &config).unwrap();
        assert!(folder.path().join("media/generated/in-flight.mp4").exists());
        // Bypass the per-process guard to simulate the next app launch.
        migrate(&root, &config).unwrap();
        assert!(folder.path().join("media/generated/in-flight.mp4").exists());
    }

    #[test]
    fn new_projects_are_marked_before_the_first_render_can_start() {
        let folder = tempfile::tempdir().unwrap();
        let record = crate::project::lifecycle::create_project_at_with_references(folder.path(), &crate::tests::created_fixture(), &[]).unwrap();
        assert!(folder.path().join(MARKER).is_file());
        touch(folder.path(), "latents/in-flight.safetensors");
        crate::commands::project::open_project(record.folder_path).unwrap();
        assert!(folder.path().join("latents/in-flight.safetensors").exists());
    }

    #[test]
    fn legacy_project_names_receive_the_migration_and_invalid_projects_do_not() {
        let folder = tempfile::tempdir().unwrap();
        fs::write(folder.path().join("polstudio.json"), serde_json::to_vec(&crate::tests::created_fixture()).unwrap()).unwrap();
        touch(folder.path(), "media/generated/orphan.wav");
        crate::commands::project::open_project(folder.path().to_string_lossy().into_owned()).unwrap();
        assert!(!folder.path().join("media/generated/orphan.wav").exists());
        let invalid = tempfile::tempdir().unwrap();
        fs::write(invalid.path().join("slopus.json"), "{}").unwrap();
        touch(invalid.path(), "media/generated/keep.wav");
        assert!(crate::commands::project::open_project(invalid.path().to_string_lossy().into_owned()).is_err());
        assert!(invalid.path().join("media/generated/keep.wav").exists());
        assert!(!invalid.path().join(MARKER).exists());
    }

    #[test]
    fn failed_migration_is_not_marked_and_does_not_retry_during_the_same_session() {
        let folder = tempfile::tempdir().unwrap();
        let config = crate::tests::created_fixture();
        write_project(folder.path(), &config).unwrap();
        fs::create_dir(folder.path().join(MARKER)).unwrap();
        touch(folder.path(), "media/generated/orphan.png");
        assert!(migrate_on_open(folder.path(), &config).is_err());
        fs::remove_dir(folder.path().join(MARKER)).unwrap();
        migrate_on_open(folder.path(), &config).unwrap();
        assert!(folder.path().join("media/generated/orphan.png").exists());
        assert!(!folder.path().join(MARKER).exists());
        migrate(&ProjectRoot::from_directory(folder.path()).unwrap(), &config).unwrap();
        assert!(!folder.path().join("media/generated/orphan.png").exists());
    }

    #[test]
    fn a_reference_through_a_link_preserves_its_generated_target() {
        let folder = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets = vec![asset("alias", "references/linked/keep.png", "image")];
        write_project(folder.path(), &config).unwrap();
        touch(folder.path(), "media/generated/keep.png");
        touch(folder.path(), "media/generated/orphan.png");
        fs::create_dir(folder.path().join("references")).unwrap();
        link_directory(&folder.path().join("references/linked"), &folder.path().join("media/generated"));
        migrate_on_open(folder.path(), &config).unwrap();
        assert!(folder.path().join("media/generated/keep.png").exists());
        assert!(folder.path().join("references/linked/keep.png").exists());
        assert!(!folder.path().join("media/generated/orphan.png").exists());
    }

    #[test]
    fn a_redirected_output_directory_aborts_the_scan_without_deleting_anything() {
        let folder = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let config = crate::tests::created_fixture();
        write_project(folder.path(), &config).unwrap();
        touch(folder.path(), "media/generated/orphan.png");
        touch(outside.path(), "keep.safetensors");
        link_directory(&folder.path().join("latents"), outside.path());
        // The desktop still opens the readable project, but an incomplete
        // migration gets no completion marker and cannot follow the junction.
        crate::commands::project::open_project(folder.path().to_string_lossy().into_owned()).unwrap();
        assert!(outside.path().join("keep.safetensors").exists());
        assert!(folder.path().join("media/generated/orphan.png").exists());
        assert!(!folder.path().join(MARKER).exists());
        assert!(!folder.path().join(JOURNAL).exists());
    }

    #[cfg(windows)]
    #[test]
    fn locked_orphans_are_journaled_before_completion_and_retried_without_another_scan() {
        use std::os::windows::fs::OpenOptionsExt;
        let folder = tempfile::tempdir().unwrap();
        let config = crate::tests::created_fixture();
        write_project(folder.path(), &config).unwrap();
        let relative = "media/generated/locked.wav";
        touch(folder.path(), relative);
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(folder.path().join(relative)).unwrap();
        migrate_on_open(folder.path(), &config).unwrap();
        assert!(folder.path().join(MARKER).is_file());
        assert!(fs::read_to_string(folder.path().join(JOURNAL)).unwrap().contains(relative));
        drop(locked);
        touch(folder.path(), "media/generated/later.wav");
        migrate(&ProjectRoot::from_directory(folder.path()).unwrap(), &config).unwrap();
        assert!(!folder.path().join(relative).exists());
        assert!(folder.path().join("media/generated/later.wav").exists());
    }
}
