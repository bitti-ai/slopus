use serde::{Deserialize, Serialize};
use slopus_core::slopfab::music::MusicSettings;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicSong {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(default)] pub style: String,
    pub generator_id: String,
    pub settings: MusicSettings,
    pub steps: i32,
    pub seed: i64,
    pub status: String,
    pub asset_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicFolder {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
}

pub(crate) fn validate(config: &super::ProjectConfig) -> Result<(), String> {
    let mut folders = std::collections::HashMap::new();
    for folder in &config.music_folders {
        if folder.id.is_empty() || folder.name.trim().is_empty() || folder.name.chars().count() > 200
            || folders.insert(folder.id.as_str(), folder).is_some() { return Err("Invalid music folder.".into()); }
    }
    for folder in &config.music_folders {
        let mut visited = std::collections::HashSet::from([folder.id.as_str()]);
        let mut parent = folder.parent_id.as_deref();
        while let Some(id) = parent {
            if !visited.insert(id) { return Err("Music folders cannot contain a cycle.".into()); }
            parent = folders.get(id).ok_or("Music folder parent does not exist.")?.parent_id.as_deref();
        }
    }
    let mut ids = std::collections::HashSet::new();
    for song in &config.music_songs {
        if song.folder_id.as_deref().is_some_and(|id| !folders.contains_key(id)) { return Err("Song folder does not exist.".into()); }
        if song.id.is_empty() || !ids.insert(&song.id) || song.title.trim().is_empty() || song.title.chars().count() > 200
            || song.style.chars().count() > 10000 || !(2..=100).contains(&song.steps) || song.seed < -1
            || !matches!(song.status.as_str(), "draft" | "queued" | "generating" | "completed" | "failed" | "cancelled") {
            return Err("Invalid music song.".into());
        }
        song.settings.validate()?;
    }
    Ok(())
}
