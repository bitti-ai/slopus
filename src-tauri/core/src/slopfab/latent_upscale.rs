use super::types::{GenerationRequest, ResolvedPlan};
use std::{fs::File, io::Read};

/// Read only the bounded archive header; the runtime validates tensors before execution.
pub(super) fn plan(request: &GenerationRequest) -> Result<ResolvedPlan, String> {
    let source = request.latent_upscale_source.as_ref().ok_or("Missing upscale source.")?;
    if ![1.5, 2.0, 4.0].contains(&source.scale) { return Err("Unsupported upscale factor.".into()); }
    let mut file = File::open(&source.path).map_err(|e| format!("Could not read saved latents: {e}"))?;
    let mut length = [0; 8];
    file.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u64::from_le_bytes(length);
    if length > 1024 * 1024 { return Err("Invalid latent archive header length.".into()); }
    let mut bytes = vec![0; length as usize];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let header: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let meta = &header["__metadata__"];
    if meta["slopfab_latents"] != "h3-av-v1" || meta["fps"] != "24" || meta["sampled"] != "1" {
        return Err("Upscaling requires completed H3 video latents.".into());
    }
    let integer = |key: &str| meta[key].as_str().and_then(|s| s.parse::<i32>().ok()).ok_or_else(|| format!("Invalid latent {key}."));
    let frames = integer("frames")?;
    let width = integer("width")?;
    let height = integer("height")?;
    if frames < 22 || frames % 17 != 5 || [width, height].iter().any(|n| !(32..=8192).contains(n) || n % 32 != 0) {
        return Err("Invalid source latent geometry.".into());
    }
    // Match SlopFab's nearest 32-pixel alignment, including ties to even.
    let scaled = |n: i32| ((n as f64 * f64::from(source.scale) / 32.0).round_ties_even() as i32) * 32;
    let (width, height) = (scaled(width), scaled(height));
    if width > 8192 || height > 8192 { return Err("The enlarged video cannot exceed 8192 pixels per side.".into()); }
    Ok(ResolvedPlan { canvas_width: width, canvas_height: height, aligned_frames: frames, duration_seconds: frames as f64 / 24.0,
        model_evaluations: 0, sequence_rows_without_text: 0, latent_frames: (frames - 5) / 17 * 5 + 2,
        latent_width: width / 16, latent_height: height / 16, description: format!("Upscale saved latents {}x to {width} × {height}", source.scale),
        boundary: "Upscale and decode saved latents without diffusion; the source archive stays unchanged." })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn saved_latent_upscale_reads_geometry_and_matches_native_alignment() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        let header = serde_json::json!({"__metadata__": {"slopfab_latents":"h3-av-v1", "fps":"24", "sampled":"1", "frames":"124", "width":"736", "height":"416"}}).to_string();
        file.write_all(&(header.len() as u64).to_le_bytes()).unwrap();
        file.write_all(header.as_bytes()).unwrap();
        let original = std::fs::read(file.path()).unwrap();
        for (scale, width, height) in [(1.5, 1088, 640), (2.0, 1472, 832), (4.0, 2944, 1664)] {
            let request = GenerationRequest { latent_upscale_source: Some(super::super::types::LatentUpscaleSource { path: file.path().to_string_lossy().into_owned(), scale }), ..Default::default() };
            super::super::planning::validate_generation_controls(&request).unwrap();
            let output = plan(&request).unwrap();
            assert_eq!((output.canvas_width, output.canvas_height, output.aligned_frames), (width, height, 124));
            assert_eq!(output.model_evaluations, 0);
        }
        assert_eq!(std::fs::read(file.path()).unwrap(), original);
    }

    #[test]
    fn saved_latent_upscale_rejects_unbounded_headers_and_generation_controls() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(&u64::MAX.to_le_bytes()).unwrap();
        let mut request = GenerationRequest { latent_upscale_source: Some(super::super::types::LatentUpscaleSource { path: file.path().to_string_lossy().into_owned(), scale: 2.0 }), ..Default::default() };
        assert!(plan(&request).unwrap_err().contains("header length"));
        request.continuation_relative_path = Some("original.safetensors".into());
        assert!(super::super::planning::validate_generation_controls(&request).is_err());
    }
}
