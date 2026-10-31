//! Delete only previously tracked generated files, after the new document is
//! durable. Ordinary saves never sweep output directories; the one-time startup
//! migration runs before the project can have an in-flight render.
mod migration;
pub(super) use migration::{mark_new_project, migrate_on_open};
use super::{paths::{normalize_project_path, ProjectRoot}, ProjectConfig};
use serde_json::Value;
use std::{collections::BTreeSet, fs, path::Path};

const JOURNAL: &str = ".generated-cleanup.json";

fn path_key(path: &str) -> Option<String> {
    let path = normalize_project_path(path).ok()?;
    #[cfg(windows)]
    let path = path.to_lowercase();
    Some(path)
}

fn managed(path: &str) -> bool {
    ["media/generated/", "latents/", "cache/scene-last/", "cache/image-edits/", "thumbnails/timeline/"]
        .iter().any(|prefix| path.starts_with(prefix) && path.len() > prefix.len())
}

fn retained(path: &str, live: &BTreeSet<String>) -> bool {
    live.iter().any(|keep| keep == path || keep.starts_with(&format!("{path}/")) || path.starts_with(&format!("{keep}/")))
}

fn collect(value: &Value, root: &ProjectRoot, paths: &mut BTreeSet<String>) {
    match value {
        Value::Array(items) => for item in items { collect(item, root, paths); },
        Value::Object(fields) => for (key, value) in fields {
            if let Some(path) = value.as_str() {
                let relative = if key == "sourcePath" {
                    Path::new(path).canonicalize().ok().and_then(|path| path.strip_prefix(root.path()).ok()
                        .map(|relative| relative.to_string_lossy().replace('\\', "/")))
                } else if key == "relativePath" || key.ends_with("RelativePath") || key == "thumbnail" {
                    path_key(path)
                } else { None };
                if let Some(relative) = relative.and_then(|path| path_key(&path)).filter(|path| managed(path)) {
                    if relative.starts_with("media/generated/") && relative.ends_with(".mp4") {
                        if let Some(stem) = Path::new(&relative).file_stem().and_then(|s| s.to_str()) {
                            paths.insert(format!("cache/scene-last/{stem}.png"));
                        }
                    }
                    if relative.starts_with("media/generated/") && (relative.ends_with(".png") || relative.ends_with(".jpg")) {
                        if let Some(stem) = Path::new(&relative).file_stem().and_then(|s| s.to_str()) {
                            paths.insert(format!("cache/image-edits/{stem}"));
                        }
                    }
                    paths.insert(relative);
                }
            } else { collect(value, root, paths); }
        },
        _ => {}
    }
}

fn files(config: &ProjectConfig, root: &ProjectRoot) -> Result<BTreeSet<String>, String> {
    let mut paths = BTreeSet::new();
    collect(&serde_json::to_value(config).map_err(|error| error.to_string())?, root, &mut paths);
    let mut thumbnail = |id: &str| {
        if let Ok(stem) = slopus_core::names::generated_file_stem(id) {
            paths.insert(path_key(&format!("thumbnails/timeline/{stem}")).unwrap());
        }
    };
    for job in &config.generation_jobs {
        if job.output_relative_path.is_some() { thumbnail(&job.id); }
    }
    for asset in &config.assets {
        if asset.kind == "generated" && asset.relative_path.is_some() {
            if let Some(id) = asset.id.strip_prefix("asset-") { thumbnail(id); }
        }
    }
    Ok(paths)
}

pub(super) struct Cleanup {
    root: ProjectRoot,
    pending: BTreeSet<String>,
}

impl Cleanup {
    pub(super) fn prepare(folder: &Path, previous: Option<&ProjectConfig>, next: &ProjectConfig) -> Result<Self, String> {
        let root = ProjectRoot::from_directory(folder)?;
        let journal = root.path().join(JOURNAL);
        let mut pending: BTreeSet<String> = if journal.exists() {
            serde_json::from_slice(&fs::read(root.existing(JOURNAL)?).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Could not read generated-file cleanup journal: {error}"))?
        } else { BTreeSet::new() };
        if let Some(previous) = previous { pending.extend(files(previous, &root)?); }
        let live = files(next, &root)?;
        pending = pending.into_iter().filter_map(|path| path_key(&path)).collect();
        pending.retain(|path| managed(path) && !retained(path, &live));
        let cleanup = Self { root, pending };
        // Persist the retry list before committing the project. If that commit
        // fails, a subsequent save subtracts the still-live references again.
        if !cleanup.pending.is_empty() || journal.exists() { cleanup.persist()?; }
        Ok(cleanup)
    }

    fn persist(&self) -> Result<(), String> {
        crate::storage::atomic::write_atomically(&self.root.path().join(JOURNAL),
            &serde_json::to_vec(&self.pending).map_err(|error| error.to_string())?)
    }

    pub(super) fn finish(mut self, protected_paths: &[String]) {
        self.pending.retain(|relative| {
            if protected_paths.iter().filter_map(|path| path_key(path))
                .any(|path| path == *relative || path.starts_with(&format!("{relative}/"))) { return true; }
            match remove(&self.root, relative) {
                Ok(()) => false,
                Err(error) => {
                    crate::diagnostics::warn("project", "cleanup.failed", &error,
                        serde_json::json!({"path": relative, "folder": self.root.path()}));
                    true
                }
            }
        });
        // Cleanup failure must not report a failed document save: callers could
        // otherwise restore the old document after some files were deleted.
        // Locked files remain journaled and are retried on the next save.
        if self.root.path().join(JOURNAL).exists() || !self.pending.is_empty() {
            if let Err(error) = self.persist() {
                crate::diagnostics::warn("project", "cleanup.journal_failed", &error, serde_json::json!({"folder": self.root.path()}));
            }
        }
    }
}

fn remove(root: &ProjectRoot, relative: &str) -> Result<(), String> {
    let Some(target) = checked_target(root, relative)? else { return Ok(()); };
    if target.is_dir() {
        if !relative.starts_with("thumbnails/timeline/") && !relative.starts_with("cache/image-edits/") {
            return Err(format!("Expected a generated file, found a directory: {relative}"));
        }
        for entry in fs::read_dir(&target).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            remove(root, &format!("{relative}/{}", entry.file_name().to_string_lossy()))?;
        }
        fs::remove_dir(&target)
    } else { fs::remove_file(&target) }
        .map_err(|error| format!("Could not remove {relative}: {error}"))
}

/// Used before enumeration as well as deletion: never traverse a redirected
/// ancestor, including junctions that lead back into another project directory.
fn checked_target(root: &ProjectRoot, relative: &str) -> Result<Option<std::path::PathBuf>, String> {
    let expected = root.path().join(relative);
    match fs::symlink_metadata(&expected) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect {relative}: {error}")),
        Ok(_) => {}
    }
    let target = root.existing(relative)?;
    // Refuse redirected ancestors even when their destination is inside the
    // project: it might be another generation's live file.
    #[cfg(windows)]
    let redirected = !target.to_string_lossy().eq_ignore_ascii_case(&expected.to_string_lossy());
    #[cfg(not(windows))]
    let redirected = target != expected;
    if redirected { return Err(format!("Refusing to remove redirected generated path: {relative}")); }
    Ok(Some(target))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{storage::{write_project, write_project_protected, write_project_with_replacer}, SceneGenerationHistory, SceneGenerationVersion};

    fn touch(root: &Path, path: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, b"generated").unwrap();
    }

    fn asset(id: &str, path: &str, kind: &str) -> super::super::ProjectAsset {
        serde_json::from_value(serde_json::json!({"id": id, "kind": kind, "name": id, "relativePath": path,
            "mimeType": if kind == "audio" { "audio/wav" } else if kind == "image" { "image/png" } else { "video/mp4" },
            "createdAt": "2026-01-01T00:00:00.000Z"})).unwrap()
    }

    #[test]
    fn fifth_take_removes_evicted_video_latents_and_last_frame_only() {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        let mut input = serde_json::to_value(&config.generation_jobs[0]).unwrap();
        for key in ["id", "status", "stage", "progress", "compiledPrompt", "generationSnapshot", "clipId", "outputRelativePath", "latentRelativePath", "error", "createdAt", "updatedAt"] {
            input.as_object_mut().unwrap().remove(key);
        }
        let version = |n| SceneGenerationVersion { id: format!("take-{n}"), created_at: config.created_at.clone(), scene: input.clone(),
            media: asset(&format!("take-{n}"), &format!("media/generated/take-{n}.mp4"), "generated"),
            latent_relative_path: Some(format!("latents/take-{n}.safetensors")), original_latent_relative_path: None,
            generation_snapshot: None, generator_name: None, upscale_factor: None };
        let fifth = version(5);
        config.generation_jobs[0].generation_history = Some(SceneGenerationHistory {
            versions: (1..=4).map(version).collect(), primary_id: Some("take-4".into()), selected_id: Some("take-4".into()), draft: None });
        write_project(root.path(), &config).unwrap();
        for n in 1..=5 {
            for path in [format!("media/generated/take-{n}.mp4"), format!("latents/take-{n}.safetensors"), format!("cache/scene-last/take-{n}.png")] { touch(root.path(), &path); }
        }
        touch(root.path(), "media/generated/in-flight.mp4");
        let history = config.generation_jobs[0].generation_history.as_mut().unwrap();
        history.versions.remove(0); history.versions.push(fifth);
        history.primary_id = Some("take-5".into()); history.selected_id = Some("take-5".into());
        write_project(root.path(), &config).unwrap();
        for path in ["media/generated/take-1.mp4", "latents/take-1.safetensors", "cache/scene-last/take-1.png"] { assert!(!root.path().join(path).exists(), "{path}"); }
        for path in ["media/generated/take-2.mp4", "latents/take-5.safetensors", "media/generated/in-flight.mp4"] { assert!(root.path().join(path).exists(), "{path}"); }
    }

    #[test]
    fn deleting_generations_clears_media_covers_and_thumbnails_but_keeps_shared_files() {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.generation_jobs.clear();
        config.assets = vec![asset("asset-scene", "media/generated/video.mp4", "generated"), asset("picture", "media/generated/picture.png", "image"), asset("song", "media/generated/song.wav", "audio")];
        config.thumbnail = Some("media/generated/cover.jpg".into());
        // A retained media segment keeps shared latents.
        config.assets[0].scene_segments = Some(vec![super::super::SceneMediaSegment { scene_id: "scene".into(), latent_relative_path: "latents/shared.safetensors".into(), start_frame: 0, frame_count: 24 }]);
        write_project(root.path(), &config).unwrap();
        let removed = ["media/generated/picture.png", "media/generated/song.wav", "media/generated/cover.jpg", "cache/image-edits/picture/resized.png"];
        let retained = ["media/generated/video.mp4", "latents/shared.safetensors", "thumbnails/timeline/scene/00000000.jpg"];
        for path in removed.iter().chain(retained.iter()) { touch(root.path(), path); }
        config.assets.truncate(1); config.thumbnail = None;
        write_project(root.path(), &config).unwrap();
        for path in removed { assert!(!root.path().join(path).exists()); }
        for path in retained { assert!(root.path().join(path).exists()); }
        config.assets.clear();
        write_project(root.path(), &config).unwrap();
        for path in retained { assert!(!root.path().join(path).exists()); }
        assert!(!root.path().join("thumbnails/timeline/scene").exists());
    }

    #[test]
    fn failed_save_does_not_delete_and_protected_inputs_are_retried_after_reopen() {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        let path = "media/generated/image.png";
        config.assets.push(asset("image", path, "image"));
        write_project(root.path(), &config).unwrap(); touch(root.path(), path);
        let mut removed = config.clone(); removed.assets.clear();
        assert!(write_project_with_replacer(root.path(), &removed, |_, _| Err(std::io::Error::other("save failed"))).is_err());
        assert!(root.path().join(path).exists());
        write_project(root.path(), &config).unwrap();
        assert!(root.path().join(path).exists());
        write_project_protected(root.path(), &removed, &[path.into()]).unwrap();
        assert!(root.path().join(path).exists());
        let reopened = super::super::storage::read_project(root.path()).unwrap();
        write_project(root.path(), &reopened.config).unwrap();
        assert!(!root.path().join(path).exists());
    }

    #[test]
    fn never_deletes_imports_external_files_or_traversal_from_a_journal() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let config = crate::tests::created_fixture();
        write_project(root.path(), &config).unwrap();
        touch(root.path(), "media/imported/original.png"); touch(outside.path(), "original.wav");
        fs::write(root.path().join(JOURNAL), serde_json::to_vec(&vec!["media/imported/original.png".into(), "latents/../../outside".into(), outside.path().join("original.wav").to_string_lossy().into_owned()]).unwrap()).unwrap();
        write_project(root.path(), &config).unwrap();
        assert!(root.path().join("media/imported/original.png").exists());
        assert!(outside.path().join("original.wav").exists());
    }

    #[test]
    fn retained_image_recipe_and_absolute_reference_keep_shared_generated_files() {
        let root = tempfile::tempdir().unwrap();
        let path = "media/generated/source.png";
        let mut config = crate::tests::created_fixture();
        let mut output = asset("edited", "media/generated/edited.png", "image");
        let mut snapshot: Value = serde_json::from_str(include_str!("../../../fixtures/image-generation-snapshot.json")).unwrap();
        snapshot["scene"]["rootType"] = "image".into();
        snapshot["scene"]["sourceImage"] = serde_json::json!({"relativePath": path, "name": "Source", "width": 640, "height": 480});
        output.image_generation = Some(serde_json::from_value(snapshot).unwrap());
        config.assets = vec![asset("source", path, "image"), output];
        write_project(root.path(), &config).unwrap(); touch(root.path(), path);
        config.assets.remove(0);
        write_project(root.path(), &config).unwrap();
        assert!(root.path().join(path).exists());
        let external = serde_json::json!({"relativePath": null, "sourcePath": root.path().join(path).to_string_lossy()});
        let mut references = BTreeSet::new();
        collect(&external, &ProjectRoot::from_directory(root.path()).unwrap(), &mut references);
        assert!(references.contains(path));
        config.assets.clear();
        write_project(root.path(), &config).unwrap();
        assert!(!root.path().join(path).exists());
    }

    #[test]
    fn redirected_generation_directory_is_never_followed_for_deletion() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        config.assets = vec![asset("image", "media/generated/image.png", "image")];
        write_project(root.path(), &config).unwrap();
        fs::create_dir(root.path().join("media")).unwrap();
        let link = root.path().join("media/generated");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            assert!(std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction -Path $env:SLOPUS_TEST_LINK -Target $env:SLOPUS_TEST_TARGET | Out-Null"])
                .env("SLOPUS_TEST_LINK", &link).env("SLOPUS_TEST_TARGET", outside.path())
                .creation_flags(0x0800_0000).status().unwrap().success());
        }
        touch(outside.path(), "image.png");
        config.assets.clear();
        write_project(root.path(), &config).unwrap();
        assert!(outside.path().join("image.png").exists());
        assert!(fs::read_to_string(root.path().join(JOURNAL)).unwrap().contains("media/generated/image.png"));
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_output_is_retried_without_failing_the_saved_deletion() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::tests::created_fixture();
        let path = "media/generated/song.wav";
        config.assets = vec![asset("song", path, "audio")];
        write_project(root.path(), &config).unwrap(); touch(root.path(), path);
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(root.path().join(path)).unwrap();
        config.assets.clear();
        write_project(root.path(), &config).unwrap();
        assert!(root.path().join(path).exists());
        assert!(super::super::storage::read_project(root.path()).unwrap().config.assets.is_empty());
        drop(locked);
        write_project(root.path(), &config).unwrap();
        assert!(!root.path().join(path).exists());
    }
}
