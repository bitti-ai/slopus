use crate::project::*;
pub(super) fn validate(config: &mut ProjectConfig) -> Result<(), String> {
    for track in &config.timeline.tracks {
        if !matches!(track.kind.as_str(), "video" | "audio" | "caption") {
            return Err(format!("Unsupported track kind '{}'.", track.kind));
        }
        if track.name.is_empty() {
            return Err(format!("Track '{}' cannot have an empty name.", track.id));
        }
        for clip in &track.clips {
            if clip.label.is_empty() {
                return Err(format!("Clip '{}' cannot have an empty label.", clip.id));
            }
            if clip.duration_ms == 0 {
                return Err(format!(
                    "Clip '{}' must have a duration greater than zero.",
                    clip.id
                ));
            }
            if !matches!(clip.status.as_str(), "draft" | "generated" | "approved") {
                return Err(format!("Unsupported clip status '{}'.", clip.status));
            }
            if let Some(transform) = &clip.transform {
                if !transform.scale.is_finite()
                    || !(10.0..=400.0).contains(&transform.scale)
                    || !transform.rotation.is_finite()
                    || !(-180.0..=180.0).contains(&transform.rotation)
                    || !transform.position_x.is_finite()
                    || !(-100.0..=100.0).contains(&transform.position_x)
                    || !transform.position_y.is_finite()
                    || !(-100.0..=100.0).contains(&transform.position_y)
                {
                    return Err(format!("Clip '{}' has an invalid transform.", clip.id));
                }
            }
            if let Some(look) = &clip.look {
                if !look.opacity.is_finite()
                    || !(0.0..=100.0).contains(&look.opacity)
                    || !look.temperature.is_finite()
                    || !(-100.0..=100.0).contains(&look.temperature)
                {
                    return Err(format!("Clip '{}' has an invalid look.", clip.id));
                }
            }
            if let Some(key) = &clip.chroma_key {
                if key.color.len() != 7
                    || !key.color.starts_with('#')
                    || !key.color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                    || !key.tolerance.is_finite()
                    || !(0.0..=100.0).contains(&key.tolerance)
                {
                    return Err(format!("Clip '{}' has an invalid chroma key.", clip.id));
                }
            }
            if let Some(transition) = &clip.transition {
                if !matches!(
                    transition.r#type.as_str(),
                    "cut" | "fade" | "wipe-left" | "wipe-right"
                ) || !(100..=3000).contains(&transition.duration_ms)
                {
                    return Err(format!("Clip '{}' has an invalid transition.", clip.id));
                }
            }
        }
    }
    Ok(())
}
