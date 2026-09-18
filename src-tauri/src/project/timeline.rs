use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Timeline {
    pub(crate) tracks: Vec<TimelineTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct TimelineTrack {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) locked: bool,
    #[serde(default)]
    pub(crate) muted: bool,
    // The frontend schema has no default for clips, so it stays required here.
    pub(crate) clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelineClip {
    pub(crate) id: String,
    pub(crate) asset_id: String,
    pub(crate) track_id: String,
    pub(crate) start_ms: u64,
    pub(crate) duration_ms: u64,
    #[serde(default)]
    pub(crate) source_start_ms: u64,
    pub(crate) label: String,
    // `.optional()` without `.nullable()` on the frontend — see ProjectAsset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color: Option<String>,
    #[serde(default = "default_clip_status")]
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transform: Option<ClipTransform>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) look: Option<ClipLook>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) chroma_key: Option<ClipChromaKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) sharpen: Option<ClipAmount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) blur: Option<ClipBlur>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) color_correction: Option<ClipColorCorrection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) vignette: Option<ClipAmount>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) lut: Option<ClipLut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) transition: Option<ClipTransition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipTransform {
    pub(crate) scale: f64,
    pub(crate) rotation: f64,
    pub(crate) position_x: f64,
    pub(crate) position_y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipLook {
    pub(crate) opacity: f64,
    pub(crate) temperature: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipChromaKey {
    pub(crate) color: String,
    pub(crate) tolerance: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipAmount {
    pub(crate) amount: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipBlur {
    pub(crate) radius: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipColorCorrection {
    pub(crate) exposure: f64,
    pub(crate) contrast: f64,
    pub(crate) saturation: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ClipLut {
    pub(crate) intensity: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) table: Option<LutTable>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LutTable {
    pub(crate) name: String,
    pub(crate) size: usize,
    pub(crate) domain_min: [f64; 3],
    pub(crate) domain_max: [f64; 3],
    pub(crate) values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClipTransition {
    pub(crate) r#type: String,
    pub(crate) duration_ms: u64,
}

pub(crate) fn default_clip_status() -> String {
    "approved".into()
}
