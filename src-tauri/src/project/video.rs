use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoSource { pub kind: String, pub id: String }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectVideo {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default)] pub scene_ids: Vec<String>,
    #[serde(default)] pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music_source: Option<VideoSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_source: Option<VideoSource>,
    pub created_at: String,
}

pub(crate) fn validate(config: &mut super::ProjectConfig) -> Result<(), String> {
    let mut folders = HashMap::new();
    for folder in &config.video_folders {
        if folder.id.is_empty() || folder.name.trim().is_empty() || folder.name.chars().count() > 200
            || folders.insert(folder.id.as_str(), folder).is_some() { return Err("Invalid video folder.".into()); }
    }
    for folder in &config.video_folders {
        let mut seen = HashSet::from([folder.id.as_str()]);
        let mut parent = folder.parent_id.as_deref();
        while let Some(id) = parent {
            if !seen.insert(id) { return Err("Video folders cannot contain a cycle.".into()); }
            parent = folders.get(id).ok_or("Video folder parent is missing.")?.parent_id.as_deref();
        }
    }
    let scenes: HashSet<_> = config.generation_jobs.iter().map(|job| job.id.as_str()).collect();
    let mut ids = HashSet::new();
    let mut assigned = HashSet::new();
    for video in &mut config.videos {
        if video.id.is_empty() || !ids.insert(video.id.as_str()) || video.title.trim().is_empty() || video.title.chars().count() > 200
            || video.prompt.chars().count() > 30000 { return Err("Invalid Video settings.".into()); }
        if video.folder_id.as_deref().is_some_and(|id| !folders.contains_key(id)) { return Err("Video folder is missing.".into()); }
        for source in [&video.music_source, &video.video_source].into_iter().flatten() {
            if source.id.is_empty() || !matches!(source.kind.as_str(), "asset" | "reference") { return Err("Invalid Video reference source.".into()); }
        }
        // Scene deletion from the agent or timeline must not leave stale members.
        video.scene_ids.retain(|id| scenes.contains(id.as_str()));
        for id in &video.scene_ids {
            if !assigned.insert(id.as_str()) { return Err("A scene can belong to only one Video.".into()); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> super::super::ProjectConfig {
        serde_json::from_str(include_str!("../../../fixtures/project-v1-complete.json")).unwrap()
    }
    #[test]
    fn video_settings_round_trip_without_merging_scene_media() {
        let mut config = fixture();
        let scene_id = config.generation_jobs[0].id.clone();
        let timeline = serde_json::to_value(&config.timeline).unwrap();
        config.videos = vec![ProjectVideo { id: "film".into(), title: "Film".into(), folder_id: None,
            scene_ids: vec![scene_id.clone(), "removed-scene".into()], prompt: "Neon".into(),
            music_source: Some(VideoSource { kind: "asset".into(), id: "song".into() }), video_source: None, created_at: config.created_at.clone() }];
        validate(&mut config).unwrap();
        assert_eq!(config.videos[0].scene_ids, [scene_id]);
        let restored: super::super::ProjectConfig = serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
        assert_eq!(restored.videos, config.videos);
        assert_eq!(serde_json::to_value(&restored.timeline).unwrap(), timeline);
        config.videos.push(ProjectVideo { id: "other".into(), ..config.videos[0].clone() });
        assert!(validate(&mut config).unwrap_err().contains("only one Video"));
    }
    #[test]
    fn video_folders_reject_missing_parents_and_cycles() {
        let mut config = fixture();
        assert!(config.videos.is_empty());
        config.video_folders = vec![super::super::music::MusicFolder { id: "a".into(), name: "Album".into(), parent_id: Some("missing".into()) }];
        assert!(validate(&mut config).unwrap_err().contains("parent is missing"));
        config.video_folders[0].parent_id = Some("a".into());
        assert!(validate(&mut config).unwrap_err().contains("cycle"));
        config.video_folders[0].parent_id = None;
        assert!(validate(&mut config).is_ok());
    }
}
