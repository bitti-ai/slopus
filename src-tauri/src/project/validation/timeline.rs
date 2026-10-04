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
                {
                    return Err(format!("Clip '{}' has an invalid opacity.", clip.id));
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
            let within =
                |value: f64, min: f64, max: f64| value.is_finite() && (min..=max).contains(&value);
            if clip
                .sharpen
                .as_ref()
                .is_some_and(|v| !within(v.amount, 0.0, 200.0))
                || clip
                    .blur
                    .as_ref()
                    .is_some_and(|v| !within(v.radius, 0.0, 24.0))
                || clip
                    .vignette
                    .as_ref()
                    .is_some_and(|v| !within(v.amount, -100.0, 100.0)
                        || v.midpoint.is_some_and(|n| !within(n, 0.0, 100.0))
                        || v.roundness.is_some_and(|n| !within(n, -100.0, 100.0))
                        || v.feather.is_some_and(|n| !within(n, 0.0, 100.0)))
                || clip.color_correction.as_ref().is_some_and(|v| {
                    [v.temperature, v.tint, v.highlights, v.shadows, v.whites, v.blacks].iter().flatten().any(|n| !within(*n, -100.0, 100.0))
                        || !within(v.exposure, -4.0, 4.0)
                        || v.brightness.is_some_and(|value| !within(value, -100.0, 100.0))
                        || !within(v.contrast, -100.0, 100.0)
                        || !within(v.saturation, 0.0, 200.0)
                })
            {
                return Err(format!("Clip '{}' has invalid video effects.", clip.id));
            }
            if let Some(v) = &clip.creative {
                if !matches!(v.look.as_str(), "None" | "Teal & Orange" | "Warm Film" | "Cool Blue" | "Bleach Bypass" | "Faded Matte" | "Monochrome" | "Golden Hour" | "Night")
                    || !within(v.intensity, 0.0, 100.0) || !within(v.faded_film, 0.0, 100.0)
                    || !within(v.sharpen, 0.0, 200.0) || !within(v.vibrance, -100.0, 100.0) {
                    return Err(format!("Clip '{}' has invalid Creative settings.", clip.id));
                }
            }
            if let Some(v) = &clip.color_wheels {
                for wheel in [&v.shadows, &v.midtones, &v.highlights] {
                    if !within(wheel.x, -1.0, 1.0) || !within(wheel.y, -1.0, 1.0)
                        || wheel.x.hypot(wheel.y) > 1.000001 || !within(wheel.lightness, -100.0, 100.0) {
                        return Err(format!("Clip '{}' has invalid Color Wheels settings.", clip.id));
                    }
                }
            }
            if let Some(v) = &clip.curves {
                for (curve, hue) in [(&v.rgb, false), (&v.red, false), (&v.green, false), (&v.blue, false),
                    (&v.hue_vs_sat, true), (&v.hue_vs_hue, true), (&v.hue_vs_luma, true), (&v.luma_vs_sat, false), (&v.sat_vs_sat, false)] {
                    if let Some(points) = curve {
                        if !(2..=32).contains(&points.len())
                            || points.iter().flatten().any(|n| !within(*n, 0.0, 1.0))
                            || points[0][0] != 0.0 || points[points.len() - 1][0] != 1.0
                            || points.windows(2).any(|p| p[1][0] - p[0][0] < 0.001)
                            || (hue && points[0][1] != points[points.len() - 1][1]) {
                            return Err(format!("Clip '{}' has invalid Curves settings.", clip.id));
                        }
                    }
                }
            }
            if let Some(lut) = &clip.lut {
                if !within(lut.intensity, 0.0, 100.0) {
                    return Err(format!("Clip '{}' has invalid LUT intensity.", clip.id));
                }
                if let Some(table) = &lut.table {
                    if !(2..=65).contains(&table.size)
                        || table.name.is_empty()
                        || table.name.chars().count() > 256
                        || table.values.len() != table.size.pow(3) * 3
                        || table.values.iter().any(|v| !within(*v, -65504.0, 65504.0))
                        || (0..3).any(|i| {
                            !within(table.domain_min[i], -65504.0, 65504.0)
                                || !within(table.domain_max[i], -65504.0, 65504.0)
                                || table.domain_min[i] as f32 >= table.domain_max[i] as f32
                        })
                    {
                        return Err(format!("Clip '{}' has an invalid LUT table.", clip.id));
                    }
                }
            }
        }
    }
    Ok(())
}
