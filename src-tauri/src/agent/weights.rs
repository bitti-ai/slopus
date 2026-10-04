//! Bounded, read-only model inspection. Never load tensor payloads or pickle files.
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const MAX_HEADER: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 2000;
const MAX_FILES: usize = 200;

pub(super) fn inspect(path: &Path, budget: &mut u64) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Expected a weight file.".into());
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let lower = name.to_lowercase();
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let mut result = json!({"path":path.to_string_lossy(),"bytes":metadata.len(),"format":extension,
        "roleHints":[],"evidence":[],"compatibility":"Not verified; hints do not prove model compatibility."});
    let mut keys = Vec::new();
    if extension == "safetensors" {
        let header = (|| -> Result<Value, String> {
            let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
            let mut size = [0u8; 8];
            file.read_exact(&mut size).map_err(|e| e.to_string())?;
            let length = u64::from_le_bytes(size);
            if length == 0
                || length > MAX_HEADER
                || length > *budget
                || length > metadata.len().saturating_sub(8)
            {
                return Err("Header is invalid or exceeds the inspection byte limit.".into());
            }
            *budget -= length;
            let mut bytes = vec![0; length as usize];
            file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let object = value.as_object().ok_or("Header must be an object.")?;
            let mut samples = Vec::new();
            let mut dtypes = std::collections::BTreeMap::<String, usize>::new();
            for (key, tensor) in object
                .iter()
                .filter(|(key, _)| key.as_str() != "__metadata__")
            {
                let offsets = tensor["data_offsets"]
                    .as_array()
                    .ok_or("Invalid tensor offsets.")?;
                if offsets.len() != 2
                    || offsets[0]
                        .as_u64()
                        .zip(offsets[1].as_u64())
                        .is_none_or(|(a, b)| a > b || b > metadata.len() - 8 - length)
                {
                    return Err("Tensor offsets exceed the file size.".into());
                }
                let dtype = tensor["dtype"].as_str().ok_or("Missing tensor dtype.")?;
                if dtype.len() > 32 {
                    return Err("Invalid tensor dtype.".into());
                }
                let shape = tensor["shape"].as_array().ok_or("Missing tensor shape.")?;
                if shape.len() > 16 || shape.iter().any(|v| v.as_u64().is_none()) {
                    return Err("Invalid tensor shape.".into());
                }
                keys.push(key.to_lowercase());
                *dtypes.entry(dtype.to_string()).or_default() += 1;
                if samples.len() < 12 {
                    samples.push(json!({"name":short(key,256),"dtype":dtype,"shape":shape}));
                }
            }
            let metadata: serde_json::Map<String, Value> = object
                .get("__metadata__")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .take(12)
                .filter_map(|(k, v)| v.as_str().map(|s| (short(k, 128), json!(short(s, 512)))))
                .collect();
            if keys.is_empty() {
                return Err("No tensors found in this file.".into());
            }
            Ok(
                json!({"tensorCount":keys.len(),"dtypes":dtypes,"tensors":samples,"metadata":metadata}),
            )
        })();
        match header {
            Ok(header) => result["header"] = header,
            Err(error) => result["inspectionError"] = json!(error),
        }
    }
    let mut hints = Vec::<&str>::new();
    let mut evidence = Vec::<String>::new();
    for (needles, role) in [
        (vec!["video_vae", "video-vae"], "videoVae"),
        (vec!["audio_vae", "audio-vae"], "audioVae"),
        (
            vec!["text_encoder", "text-encoder", "qwen3vl", "qwen3_vl"],
            "textEncoder",
        ),
        (vec!["lora", "distillation"], "lora"),
        (
            vec!["fixed_embed", "prompt_embed", "text_cond"],
            "promptEmbedding",
        ),
    ] {
        if needles.iter().any(|needle| lower.contains(needle)) {
            hints.push(role);
            evidence.push(format!("Filename suggests {role}."));
        }
    }
    for (needles, role) in [
        (vec!["lora_a", "lora_b", "lora_up", "lora_down"], "lora"),
        (vec!["prompt_embeds", "text_token_tags"], "promptEmbedding"),
        (
            vec!["embed_tokens.weight", "language_model.model.layers"],
            "textEncoder",
        ),
    ] {
        if let Some(key) = keys
            .iter()
            .find(|key| needles.iter().any(|needle| key.contains(needle)))
        {
            if !hints.contains(&role) {
                hints.push(role);
            }
            evidence.push(format!("Tensor {} suggests {role}.", short(key, 256)));
        }
    }
    if hints.is_empty() && (lower.contains("minimax_h3") || lower.contains("minimax-h3")) {
        hints.push("transformer");
        evidence.push("MiniMax H3 filename; verify tensor architecture before selecting.".into());
    }
    result["roleHints"] = json!(hints);
    result["evidence"] = json!(evidence);
    Ok(result)
}

fn short(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub(super) fn scan(folder: &str, cancel: &AtomicBool) -> Result<Value, String> {
    let path = Path::new(folder);
    if !path.is_absolute() {
        return Err("Use an absolute weight folder path.".into());
    }
    let root = path
        .canonicalize()
        .map_err(|e| format!("Cannot open weight folder: {e}"))?;
    if !root.is_dir() {
        return Err("Weight folder must be a directory.".into());
    }
    let mut pending = vec![(root.clone(), 0usize)];
    let mut files = Vec::new();
    let mut tokenizers = std::collections::BTreeSet::new();
    let mut warnings = Vec::new();
    let mut visited = 0usize;
    let mut budget = 32 * 1024 * 1024;
    let mut truncated = false;
    let mut output_bytes = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        if cancel.load(Ordering::Acquire) {
            return Err("Agent request cancelled.".into());
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(e) => {
                warnings.push(format!("{}: {e}", directory.display()));
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Acquire) {
                return Err("Agent request cancelled.".into());
            }
            visited += 1;
            if visited > MAX_ENTRIES || files.len() >= MAX_FILES {
                truncated = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    warnings.push(e.to_string());
                    continue;
                }
            };
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(e) => {
                    warnings.push(e.to_string());
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            // Also excludes Windows directory junctions escaping the supplied root.
            let resolved = match path.canonicalize() {
                Ok(p) if p.starts_with(&root) => p,
                _ => continue,
            };
            if kind.is_dir() {
                if depth < 8 {
                    pending.push((resolved, depth + 1));
                } else {
                    truncated = true;
                }
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if [
                    "tokenizer.json",
                    "tokenizer.model",
                    "vocab.json",
                    "merges.txt",
                ]
                .contains(&name.as_str())
                {
                    tokenizers.insert(directory.to_string_lossy().to_string());
                }
                let ext = path
                    .extension()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase();
                if ["safetensors", "gguf", "bin", "pt", "pth", "ckpt"].contains(&ext.as_str()) {
                    let info = inspect(&resolved, &mut budget).unwrap_or_else(
                        |e| json!({"path":resolved.to_string_lossy(),"inspectionError":e}),
                    );
                    output_bytes += info.to_string().len();
                    if output_bytes > 128 * 1024 {
                        truncated = true;
                        break;
                    }
                    files.push(info);
                }
            }
        }
        if visited > MAX_ENTRIES || files.len() >= MAX_FILES || output_bytes > 128 * 1024 {
            break;
        }
    }
    files.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    Ok(
        json!({"folder":root.to_string_lossy(),"files":files,"tokenizerDirectories":tokenizers,
        "truncated":truncated,"warnings":warnings.into_iter().take(20).collect::<Vec<_>>(),
        "note":"Only safetensors headers are read. Other formats have filename hints only. Unknown or conflicting roles require clarification; no files were changed."}),
    )
}
