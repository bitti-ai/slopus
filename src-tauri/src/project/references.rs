use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReusableReference {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) content: Option<String>,
    #[serde(default)]
    pub(crate) relative_path: Option<String>,
    /// An image reference is copied into `references/`; a video or audio
    /// reference is not, and points at wherever the user keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_path: Option<String>,
    /// Pictures attached to this definition. The top-level paths above remain
    /// readable for projects made when an image was a separate reference kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) images: Vec<ReferenceImage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) refmods: Vec<ReferenceRefmod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) video: Option<ReferenceVideoOptions>,
    #[serde(default)]
    pub(crate) intended_use: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subcategory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) icon_relative_path: Option<String>,
    pub(crate) created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceImage {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceVideoOptions {
    pub(crate) start_seconds: f64,
    pub(crate) duration_seconds: f64,
    pub(crate) include_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReferenceRefmod {
    #[serde(flatten)]
    pub(crate) file: ReferenceImage,
    #[serde(default = "default_refmod_strength")]
    pub(crate) strength: f64,
    #[serde(default = "default_refmod_copies")]
    pub(crate) copies: u32,
}
pub(crate) fn default_refmod_strength() -> f64 {
    1.0
}
pub(crate) fn default_refmod_copies() -> u32 {
    1
}
