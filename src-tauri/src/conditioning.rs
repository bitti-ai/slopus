//! Adapt downloaded ComfyUI conditioning to SlopFab's F32 input contract.
use serde_json::{json, Value};
use std::{fs, io::{Read, Write}, path::{Path, PathBuf}, sync::Mutex};

static CONVERSION: Mutex<()> = Mutex::new(());
const TOKENS: usize = 362;
const VALUES: usize = TOKENS * 5120;

pub fn cached_path(source: &Path) -> PathBuf {
    source.with_extension("slopfab.safetensors")
}

fn tensor<'a>(header: &Value, data: &'a [u8], name: &str, dtype: &str, shape: &[usize], bytes: usize) -> Result<&'a [u8], String> {
    let entry = &header[name];
    if entry["dtype"] != dtype || entry["shape"] != json!(shape) {
        return Err(format!("Animate conditioning requires {name} {dtype} {shape:?}."));
    }
    let offsets = entry["data_offsets"].as_array().filter(|values| values.len() == 2)
        .ok_or("Invalid conditioning tensor offsets.")?;
    let start = offsets[0].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or("Invalid tensor offset.")?;
    let end = offsets[1].as_u64().and_then(|n| usize::try_from(n).ok()).ok_or("Invalid tensor offset.")?;
    if end.checked_sub(start) != Some(bytes) { return Err("Invalid conditioning tensor size.".into()); }
    data.get(start..end).ok_or_else(|| "Truncated conditioning tensor.".into())
}

fn convert(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let size = u64::from_le_bytes(bytes.get(..8).ok_or("Missing safetensors header.")?.try_into().unwrap());
    let end = usize::try_from(size).ok().and_then(|n| n.checked_add(8)).filter(|n| *n <= bytes.len())
        .ok_or("Invalid safetensors header length.")?;
    let header: Value = serde_json::from_slice(&bytes[8..end]).map_err(|e| format!("Invalid conditioning header: {e}"))?;
    let data = &bytes[end..];
    let native = header.get("prompt_embedding").is_some();
    let embedding = if native {
        tensor(&header, data, "prompt_embedding", "F32", &[TOKENS, 5120], VALUES * 4)?
    } else {
        tensor(&header, data, "prompt_embeds", "BF16", &[1, TOKENS, 5120], VALUES * 2)?
    };
    let tag_width = match header["text_token_tags"]["dtype"].as_str() {
        Some("I32") => 4, Some("I64") => 8,
        _ => return Err("Animate conditioning requires integer text_token_tags.".into()),
    };
    let tags = tensor(&header, data, "text_token_tags", if tag_width == 4 { "I32" } else { "I64" }, &[TOKENS], TOKENS * tag_width)?;
    let mut tag_bytes = Vec::with_capacity(TOKENS * 4);
    for tag in tags.chunks_exact(tag_width) {
        let value = if tag_width == 4 { i32::from_le_bytes(tag.try_into().unwrap()) as i64 } else { i64::from_le_bytes(tag.try_into().unwrap()) };
        if !(0..=2).contains(&value) { return Err("Invalid conditioning modality tag.".into()); }
        tag_bytes.extend_from_slice(&(value as i32).to_le_bytes());
    }
    let mut values = Vec::with_capacity(VALUES * 4);
    for value in embedding.chunks_exact(if native { 4 } else { 2 }) {
        let bits = if native { u32::from_le_bytes(value.try_into().unwrap()) } else { (u16::from_le_bytes(value.try_into().unwrap()) as u32) << 16 };
        if !f32::from_bits(bits).is_finite() { return Err("Non-finite conditioning value.".into()); }
        if !native { values.extend_from_slice(&bits.to_le_bytes()); }
    }
    if native { return Ok(None); }
    let mut header = serde_json::to_vec(&json!({
        "prompt_embedding": { "dtype": "F32", "shape": [TOKENS, 5120], "data_offsets": [0, VALUES * 4] },
        "text_token_tags": { "dtype": "I32", "shape": [TOKENS], "data_offsets": [VALUES * 4, VALUES * 4 + TOKENS * 4] },
    })).map_err(|e| e.to_string())?;
    header.resize((header.len() + 7) / 8 * 8, b' ');
    let mut output = (header.len() as u64).to_le_bytes().to_vec();
    output.extend(header);
    output.extend(values);
    output.extend(tag_bytes);
    Ok(Some(output))
}

pub fn prepare(source: &Path) -> Result<PathBuf, String> {
    let _guard = CONVERSION.lock().map_err(|_| "Conditioning conversion lock failed.")?;
    // Bound allocations even when a template points to the wrong model file.
    let mut bytes = Vec::new();
    fs::File::open(source).and_then(|file| file.take(8_000_001).read_to_end(&mut bytes))
        .map_err(|e| format!("Cannot read Animate conditioning {}: {e}. Download Animate in Settings.", source.display()))?;
    if bytes.len() > 8_000_000 { return Err("Animate conditioning file is too large.".into()); }
    let Some(converted) = convert(&bytes)? else { return Ok(source.to_path_buf()); };
    let destination = cached_path(source);
    // Compare contents so a replaced source or damaged cache is repaired. No
    // timestamp assumptions, and repeat requests do not rewrite the cache.
    let mut existing = Vec::new();
    if let Ok(file) = fs::File::open(&destination) {
        let _ = file.take(converted.len() as u64 + 1).read_to_end(&mut existing);
    }
    if existing != converted {
        let temporary = source.with_extension("slopfab.part");
        fs::File::create(&temporary).and_then(|mut file| { file.write_all(&converted)?; file.sync_all() })
            .and_then(|_| fs::rename(&temporary, &destination)).map_err(|e| format!("Cannot cache Animate conditioning: {e}"))?;
    }
    Ok(destination)
}

#[cfg(test)]
pub(crate) fn fixture(path: &Path) {
    let header = serde_json::to_vec(&json!({
        "prompt_embeds": { "dtype": "BF16", "shape": [1, TOKENS, 5120], "data_offsets": [0, VALUES * 2] },
        "text_token_tags": { "dtype": "I64", "shape": [TOKENS], "data_offsets": [VALUES * 2, VALUES * 2 + TOKENS * 8] },
    })).unwrap();
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    for _ in 0..VALUES { bytes.extend_from_slice(&0x3fc0u16.to_le_bytes()); }
    for i in 0..TOKENS { bytes.extend_from_slice(&(i as i64 % 3).to_le_bytes()); }
    fs::write(path, bytes).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_exactly_reuses_and_repairs_cache() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("conditioning.safetensors");
        fixture(&source);
        let result = prepare(&source).unwrap();
        let bytes = fs::read(&result).unwrap();
        let end = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize + 8;
        assert_eq!(f32::from_le_bytes(bytes[end..end + 4].try_into().unwrap()), 1.5);
        assert_eq!(i32::from_le_bytes(bytes[end + VALUES * 4 + 8..end + VALUES * 4 + 12].try_into().unwrap()), 2);
        let modified = fs::metadata(&result).unwrap().modified().unwrap();
        assert_eq!(prepare(&source).unwrap(), result);
        assert_eq!(fs::metadata(&result).unwrap().modified().unwrap(), modified);
        assert_eq!(prepare(&result).unwrap(), result);
        fs::write(&result, b"broken").unwrap();
        prepare(&source).unwrap();
        assert_eq!(fs::read(&result).unwrap(), bytes);
        fs::write(&source, b"truncated").unwrap();
        assert!(prepare(&source).is_err());
    }

    #[test]
    fn rejects_invalid_values_tags_and_offsets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("conditioning.safetensors");
        fixture(&source);
        let bytes = fs::read(source).unwrap();
        let end = u64::from_le_bytes(bytes[..8].try_into().unwrap()) as usize + 8;
        let mut invalid = bytes.clone();
        invalid[end..end + 2].copy_from_slice(&0x7fc0u16.to_le_bytes());
        assert!(convert(&invalid).unwrap_err().contains("Non-finite"));
        let mut invalid = bytes.clone();
        invalid[end + VALUES * 2..end + VALUES * 2 + 8].copy_from_slice(&3i64.to_le_bytes());
        assert!(convert(&invalid).unwrap_err().contains("modality"));
        assert!(convert(&bytes[..bytes.len() - 1]).is_err());
        assert!(convert(&u64::MAX.to_le_bytes()).is_err());
    }
}
