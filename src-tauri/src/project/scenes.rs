use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
/// One shot inside a scene. Mirrors `sceneShotSchema` in src/lib/project.ts.
///
/// `startSeconds` and `action` are REQUIRED on the zod side and are plain
/// (non-`Option`) fields here, so they are always written — a `#[serde(default)]`
/// covers a file that predates them without ever producing a key zod refuses.
/// Later optional fields carry `skip_serializing_if`, because zod spells them
/// `.nullish()` and older project files must not grow keys just by being saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SceneShot {
    pub(crate) id: String,
    /// Added after scenes shipped. An absent name keeps the numbered Shot N
    /// label, and is skipped so older project files do not grow a new key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) start_seconds: f64,
    /// The user's own line, tokens and all. May be empty: a shot they have just
    /// added has nothing written in it, and this layer never fills it in.
    #[serde(default)]
    pub(crate) action: String,
    /// Spoken text is kept separate so the frontend compiler can place it
    /// inside MiniMax H3's dialogue tags without trying to parse prose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) speech: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) speech_language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) settings: Option<BTreeMap<String, Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerationJob {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) title: String,
    /// A MIRROR of the scene's shot lines for a scene-shaped job, and the user's
    /// only copy of their words for every job written before scenes existed.
    /// That is why it may be empty here but not there — see the emptiness rule
    /// in `validate_and_normalize_config`, which is zod's `superRefine` on
    /// `generationJobSchema` written out.
    #[serde(default)]
    pub(crate) prompt: String,
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) stage: String,
    #[serde(default)]
    pub(crate) progress: f64,
    pub(crate) provider_id: Option<String>,
    pub(crate) creative_brief: String,
    // Legacy derived cache. The frontend compiles from shots and references at
    // preview/send time; accept old files but never persist this stale copy.
    #[serde(default, skip_serializing)]
    pub(crate) compiled_prompt: String,
    /// Exact inputs of the latest generation attempt. Missing on drafts that
    /// have never been sent to the renderer and on older project files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) generation_snapshot: Option<String>,
    #[serde(default)]
    pub(crate) reference_ids: Vec<String>,
    /// Optional image reference that initializes the scene's first frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) start_frame_reference_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) end_frame_reference_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) use_previous_scene_last_frame: Option<bool>,
    /// The H3 vocabulary tags this shot was built from: group id -> option ids.
    /// zod spells it `.nullish()` (src/lib/project.ts `shotTagSelectionSchema`),
    /// so `null` IS readable on the frontend — but the key is still skipped
    /// when there is nothing to say, because every project written before shot
    /// tags existed has no key here and must keep round-tripping unchanged.
    ///
    /// Only the SHAPE is checked, on both sides: the vocabulary itself lives in
    /// src/lib/shot-tags.ts and nowhere else, so a term can be reworded without
    /// this file knowing, and an id from a newer build is preserved rather than
    /// dropped on the next save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shot_tags: Option<BTreeMap<String, Vec<String>>>,
    /// The shots this scene holds, in playing order. Optional scene settings
    /// use `skip_serializing_if`, because older projects have none of these keys
    /// and must round-trip byte-for-byte. Zod spells them `.nullish()`, so null
    /// is readable too, but absence is what those old files contain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) shots: Option<Vec<SceneShot>>,
    /// How long the whole scene runs, 0-15 seconds. Absent means the length
    /// every shot was generated at before this was settable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) duration_seconds: Option<f64>,
    /// Renderer controls added after scenes. Missing values retain the UI's
    /// defaults without making old project files grow new keys on open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) steps: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) seed: Option<i64>,
    /// Base guide §4.6 and §4.7 — per-prompt fields, so they sit on the scene
    /// rather than on a shot. Absent means the compiler writes its own
    /// content-neutral line and marks it as Slopus's own words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) soundscape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) music: Option<String>,
    // `clipId` is `.optional()` and NOT `.nullable()` on the frontend, and no
    // freshly created job ever has one, so emitting `"clipId": null` made every
    // create_project / open_project response fail zod. Keep the key absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) clip_id: Option<String>,
    #[serde(default)]
    pub(crate) output_relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) latent_relative_path: Option<String>,
    #[serde(default)]
    pub(crate) error: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

impl GenerationJob {
    pub(crate) fn draft(id: &str, title: &str, timestamp: &str, defaults: crate::generation::models::SceneDefaults) -> Self {
        let now = timestamp.to_string();
        Self {
                id: id.to_string(),
                title: title.to_string(),
                prompt: String::new(),
                status: "draft".into(),
                stage: "queued".into(),
                progress: 0.0,
                provider_id: Some(defaults.provider_id.into()),
                creative_brief: String::new(),
                compiled_prompt: String::new(),
                generation_snapshot: None,
                reference_ids: Vec::new(),
                start_frame_reference_id: None,
                end_frame_reference_id: None,
                use_previous_scene_last_frame: None,
                shot_tags: None,
                shots: Some(Vec::new()),
                duration_seconds: Some(defaults.duration_seconds),
                steps: None,
                seed: None,
                soundscape: None,
                music: None,
                clip_id: None,
                output_relative_path: None,
                latent_relative_path: None,
                error: None,
                created_at: now.clone(),
                updated_at: now,
        }
    }
}
