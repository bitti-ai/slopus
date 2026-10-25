use serde::{Deserialize, Serialize};
use slopus_core::slopfab::music::MusicSettings;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MusicSong {
    pub id: String,
    pub title: String,
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

pub(crate) fn validate(config: &super::ProjectConfig) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    for song in &config.music_songs {
        if song.id.is_empty() || !ids.insert(&song.id) || song.title.trim().is_empty() || song.title.chars().count() > 200
            || song.style.chars().count() > 10000 || !(2..=100).contains(&song.steps) || song.seed < -1
            || !matches!(song.status.as_str(), "draft" | "queued" | "generating" | "completed" | "failed" | "cancelled") {
            return Err("Invalid music song.".into());
        }
        song.settings.validate()?;
    }
    Ok(())
}
