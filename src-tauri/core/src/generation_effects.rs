//! Portable authoring settings; calibration files belong to the generation host.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationEffects {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<Color>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<Tone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharpness: Option<Strength>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<Anchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_step: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_step: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<Region>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Color {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>, pub color: String, pub strength: f32, pub mode: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tone {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>, pub contrast: f32, pub brightness: f32, pub saturation: f32, pub temperature: f32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Strength { #[serde(default, skip_serializing_if = "Option::is_none")] pub enabled: Option<bool>, pub strength: f32 }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor { #[serde(default, skip_serializing_if = "Option::is_none")] pub enabled: Option<bool>, pub mode: String, pub strength: f32 }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Region { pub x: f32, pub y: f32, pub width: f32, pub height: f32, pub invert: bool }

fn range(value: f32, min: f32, max: f32) -> bool { value.is_finite() && (min..=max).contains(&value) }
impl GenerationEffects {
    pub fn validate(&self) -> Result<(), String> {
        let invalid = self.color.as_ref().is_some_and(|c| !range(c.strength, 0.0, 2.0)
            || c.color.len() != 7 || !c.color.starts_with('#') || !c.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            || !matches!(c.mode.as_str(), "interpolated" | "type_i" | "type_ii"))
            || self.tone.as_ref().is_some_and(|t| !range(t.contrast, 0.0, 4.0) || !range(t.brightness, -1.0, 1.0) || !range(t.saturation, 0.0, 4.0) || !range(t.temperature, -1.0, 1.0))
            || self.sharpness.as_ref().is_some_and(|s| !range(s.strength, -5.0, 5.0))
            || self.anchor.as_ref().is_some_and(|a| !range(a.strength, 0.0, 1.0) || !matches!(a.mode.as_str(), "self" | "smooth"))
            || self.start_step.unwrap_or(0) < 0 || self.end_step.unwrap_or(i32::MAX) < self.start_step.unwrap_or(0)
            || self.region.as_ref().is_some_and(|r| !range(r.x, 0.0, 100.0) || !range(r.y, 0.0, 100.0) || !range(r.width, 0.1, 100.0) || !range(r.height, 0.1, 100.0) || r.x + r.width > 100.0 || r.y + r.height > 100.0);
        if invalid { Err("Invalid generation effects settings.".into()) } else { Ok(()) }
    }

    /// Translate to the native LCS schema; bypassed/neutral cards do no work.
    pub fn native_settings(&self) -> Result<Option<Value>, String> {
        self.validate()?;
        let mut settings = json!({});
        if let Some(c) = self.color.as_ref().filter(|c| c.enabled != Some(false) && c.strength != 0.0) {
            let rgb: Vec<f32> = [1, 3, 5].into_iter().map(|i| u8::from_str_radix(&c.color[i..i + 2], 16).unwrap() as f32 / 255.0).collect();
            settings["color"] = json!(rgb); settings["strength"] = json!(c.strength); settings["mode"] = json!(c.mode);
        }
        if let Some(t) = self.tone.as_ref().filter(|t| t.enabled != Some(false) && (t.contrast != 1.0 || t.brightness != 0.0 || t.saturation != 1.0 || t.temperature != 0.0)) {
            settings["contrast"] = json!(t.contrast); settings["brightness"] = json!(t.brightness);
            settings["saturation"] = json!(t.saturation); settings["temperature"] = json!(t.temperature);
        }
        if let Some(s) = self.sharpness.as_ref().filter(|s| s.enabled != Some(false) && s.strength != 0.0) { settings["sharpness"] = json!(s.strength); }
        if let Some(a) = self.anchor.as_ref().filter(|a| a.enabled != Some(false) && a.strength != 0.0) { settings["anchor"] = json!(a.mode); settings["anchor_strength"] = json!(a.strength); }
        if settings.as_object().unwrap().is_empty() { return Ok(None); }
        settings["start_step"] = json!(self.start_step.unwrap_or(0));
        settings["end_step"] = json!(self.end_step.unwrap_or(i32::MAX));
        Ok(Some(settings))
    }

    pub fn mask(&self, width: i32, height: i32) -> Result<Option<Vec<f32>>, String> {
        self.validate()?;
        let Some(r) = &self.region else { return Ok(None); };
        if width <= 0 || height <= 0 || i64::from(width) * i64::from(height) > 4_194_304 { return Err("Invalid LCS mask dimensions.".into()); }
        // Fractional coverage keeps small regions useful at latent resolution.
        let overlap = |index: i32, count: i32, start: f32, size: f32| {
            let left = start / 100.0 * count as f32;
            let right = (start + size) / 100.0 * count as f32;
            (right.min((index + 1) as f32) - left.max(index as f32)).clamp(0.0, 1.0)
        };
        Ok(Some((0..height).flat_map(|y| (0..width).map(move |x| {
            let coverage = overlap(x, width, r.x, r.width) * overlap(y, height, r.y, r.height);
            if r.invert { 1.0 - coverage } else { coverage }
        })).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_fixture_roundtrips_and_maps_to_native_controls() {
        let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/generation-effects.json")).unwrap();
        let effects: GenerationEffects = serde_json::from_value(fixture.clone()).unwrap();
        effects.validate().unwrap();
        let native = effects.native_settings().unwrap().unwrap();
        assert_eq!(native["start_step"], 2);
        assert_eq!(native["anchor"], "self");
        assert_eq!(native["contrast"], 1.25);
        assert!(native.get("sharpness").is_none());
        assert!((native["color"][0].as_f64().unwrap() - 128.0 / 255.0).abs() < 0.00001);
        let roundtrip: GenerationEffects = serde_json::from_value(serde_json::to_value(&effects).unwrap()).unwrap();
        assert_eq!(effects, roundtrip);
        assert_eq!(effects.mask(4, 2).unwrap().unwrap(), vec![0., 1., 1., 0., 0., 1., 1., 0.]);
        let mut inverted = effects.clone(); inverted.region.as_mut().unwrap().invert = true;
        assert_eq!(inverted.mask(4, 1).unwrap().unwrap(), vec![1., 0., 0., 1.]);
        assert_eq!(effects.mask(2, 1).unwrap().unwrap(), vec![0.5, 0.5]);
    }
    #[test]
    fn rejects_invalid_values_even_when_bypassed_and_skips_neutral_settings() {
        for value in [json!({"color":{"color":"#xyzxyz","strength":0.5,"mode":"type_i"}}),
            json!({"sharpness":{"strength":6,"enabled":false}}), json!({"startStep":4,"endStep":3}),
            json!({"region":{"x":60,"y":0,"width":50,"height":100,"invert":false}})] {
            assert!(serde_json::from_value::<GenerationEffects>(value).unwrap().validate().is_err());
        }
        let neutral: GenerationEffects = serde_json::from_value(json!({"tone":{"contrast":1,"brightness":0,"saturation":1,"temperature":0},"sharpness":{"strength":1,"enabled":false}})).unwrap();
        assert!(neutral.native_settings().unwrap().is_none());
        assert!(serde_json::from_value::<GenerationEffects>(json!({"sharpness":{"strength":true}})).is_err());
    }
}
