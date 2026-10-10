use super::weights;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::atomic::AtomicBool};

const PATH_FIELDS: [&str; 5] = [
    "transformer",
    "textEncoder",
    "tokenizer",
    "videoVae",
    "audioVae",
];

/// A separate machine-local snapshot, never part of a portable project.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratorContext {
    pub settings: Value,
    #[serde(default)]
    pub loras: Vec<Value>,
}
impl Default for GeneratorContext {
    fn default() -> Self {
        Self {
            settings: json!({"templates":[],"defaultTemplateId":""}),
            loras: vec![],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum GeneratorRead {
    #[serde(rename = "generator.list")]
    List,
    #[serde(rename = "generator.get")]
    Get { id: String },
    #[serde(rename = "generator.scan")]
    Scan { folder: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratorPatch {
    pub name: Option<String>,
    pub model_type: Option<String>,
    pub default_steps: Option<u32>,
    pub attention: Option<String>,
    pub mode: Option<String>,
    pub motion_cache: Option<bool>,
    pub paths: Option<BTreeMap<String, String>>,
    pub loras: Option<Vec<LoraSelection>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoraSelection {
    pub lora_id: String,
    pub enabled: bool,
    pub strength: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum GeneratorCommand {
    #[serde(rename = "generator.add")]
    Add {
        id: String,
        settings: GeneratorPatch,
        #[serde(default, rename = "makeDefault")]
        make_default: bool,
    },
    #[serde(rename = "generator.set")]
    Set {
        id: String,
        settings: GeneratorPatch,
        #[serde(default, rename = "makeDefault")]
        make_default: bool,
    },
    #[serde(rename = "generator.lora.add")]
    AddLora {
        id: String,
        name: String,
        path: String,
        #[serde(rename = "stepOverride")]
        step_override: Option<u32>,
    },
}

pub(super) fn read(
    context: &GeneratorContext,
    request: &GeneratorRead,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let templates = context.settings["templates"]
        .as_array()
        .ok_or("Invalid generator library.")?;
    match request {
        GeneratorRead::List => Ok(
            json!({"defaultTemplateId":context.settings["defaultTemplateId"],
            "templates":templates.iter().map(|t|json!({"id":t["id"],"name":t["name"],"modelType":t["modelType"],"mode":t["mode"]})).collect::<Vec<_>>(),
            "loras":context.loras}),
        ),
        GeneratorRead::Get { id } => {
            let template = templates
                .iter()
                .find(|t| t["id"].as_str() == Some(id))
                .ok_or_else(|| format!("Unknown generator '{id}'."))?;
            let paths: BTreeMap<_, _> = PATH_FIELDS
                .iter()
                .map(|field| {
                    let value = template["paths"][field].as_str().unwrap_or_default();
                    let state = if value.is_empty() {
                        "unset"
                    } else if is_url(value) {
                        "downloadUrl"
                    } else if Path::new(value).is_file() {
                        "file"
                    } else if Path::new(value).is_dir() {
                        "directory"
                    } else {
                        "missing"
                    };
                    (*field, json!({"value":value,"state":state}))
                })
                .collect();
            Ok(json!({"template":template,"paths":paths,"loras":context.loras}))
        }
        GeneratorRead::Scan { folder } => weights::scan(folder, cancel),
    }
}

fn is_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn validate_path(role: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    if is_url(value) {
        let url = reqwest::Url::parse(value).map_err(|e| format!("Invalid download URL: {e}"))?;
        if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err("Weight URLs must have a host and no embedded credentials.".into());
        }
        return Ok(());
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(format!(
            "{role} needs an absolute local path or HTTP(S) URL."
        ));
    }
    if role == "tokenizer" {
        if !path.is_dir() {
            return Err("Tokenizer path must be an existing directory.".into());
        }
    } else {
        if !path.is_file() {
            return Err(format!("{role} file does not exist: {value}"));
        }
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        if !["safetensors", "gguf", "bin"].contains(&ext.as_str()) {
            return Err(format!("Unsupported {role} weight format: {ext}"));
        }
        if ext == "safetensors" {
            let info = weights::inspect(path, &mut (4 * 1024 * 1024))?;
            if let Some(error) = info.get("inspectionError") {
                return Err(format!("Cannot verify {role} safetensors: {error}"));
            }
            let hints = info["roleHints"].as_array().unwrap();
            if !hints.is_empty() && !hints.iter().any(|hint| hint.as_str() == Some(role)) {
                return Err(format!("File appears to be {hints:?}, not {role}. Inspect the folder and correct its role."));
            }
        }
    }
    Ok(())
}

/// Validate against the latest library, producing a complete replacement without side effects.
pub(crate) fn prepare(
    context: &GeneratorContext,
    commands: &[GeneratorCommand],
) -> Result<GeneratorContext, String> {
    if commands.is_empty() || commands.len() > 100 {
        return Err("Provide between 1 and 100 generator commands.".into());
    }
    let mut next = context.clone();
    for command in commands {
        let (id, patch, make_default, add) = match command {
            GeneratorCommand::Add {
                id,
                settings,
                make_default,
            } => (id, settings, *make_default, true),
            GeneratorCommand::Set {
                id,
                settings,
                make_default,
            } => (id, settings, *make_default, false),
            GeneratorCommand::AddLora {
                id,
                name,
                path,
                step_override,
            } => {
                if id.trim().is_empty()
                    || name.trim().is_empty()
                    || next.loras.iter().any(|l| l["id"].as_str() == Some(id))
                {
                    return Err("A new LoRA needs a unique nonempty id and name.".into());
                }
                if path.is_empty() || is_url(path) {
                    return Err("Register a LoRA using an existing local weight file.".into());
                }
                validate_path("lora", path)?;
                if step_override.is_some_and(|s| !(2..=i32::MAX as u32).contains(&s)) {
                    return Err("LoRA stepOverride must be 2..2147483647.".into());
                }
                let mut lora =
                    json!({"id":id,"name":name.trim(),"path":path,"needsPreparation":true});
                if let Some(steps) = step_override {
                    lora["stepOverride"] = json!(steps);
                }
                next.loras.push(lora);
                continue;
            }
        };
        if id.trim().is_empty() {
            return Err("Generator id cannot be empty.".into());
        }
        let templates = next.settings["templates"]
            .as_array_mut()
            .ok_or("Invalid generator library.")?;
        let index = templates.iter().position(|t| t["id"].as_str() == Some(id));
        if add && index.is_some() {
            return Err(format!(
                "Generator '{id}' already exists; use generator.set."
            ));
        }
        if !add && index.is_none() {
            return Err(format!("Unknown generator '{id}'."));
        }
        let mut template = if let Some(index) = index {
            templates[index].clone()
        } else {
            json!({"id":id,"name":"New generator","modelType":"minimax-h3","defaultSteps":20,"attention":"sage2","mode":"prompt",
                "paths":{"transformer":"","textEncoder":"","tokenizer":"","videoVae":"","audioVae":""}})
        };
        if let Some(name) = &patch.name {
            if name.trim().is_empty() {
                return Err("Generator name cannot be empty.".into());
            }
            template["name"] = json!(name.trim());
        } else if add {
            return Err("A new generator needs a name.".into());
        }
        if let Some(model) = &patch.model_type {
            if model != "minimax-h3" {
                return Err("Only the minimax-h3 model family is currently supported.".into());
            }
            template["modelType"] = json!(model);
        }
        if let Some(steps) = patch.default_steps {
            if !(2..=i32::MAX as u32).contains(&steps) {
                return Err("defaultSteps must be 2..2147483647.".into());
            }
            template["defaultSteps"] = json!(steps);
        }
        if let Some(attention) = &patch.attention {
            if !["exact", "flash2", "sage2", "sol"].contains(&attention.as_str()) {
                return Err("attention must be exact, flash2, sage2 or sol.".into());
            }
            template["attention"] = json!(attention);
        }
        if let Some(mode) = &patch.mode {
            if !["prompt", "animate"].contains(&mode.as_str()) {
                return Err("mode must be prompt or animate.".into());
            }
            template["mode"] = json!(mode);
        }
        if let Some(cache) = patch.motion_cache {
            template["motionCache"] = json!(cache);
        }
        if let Some(paths) = &patch.paths {
            for (role, path) in paths {
                if !PATH_FIELDS.contains(&role.as_str()) {
                    return Err(format!("Unknown weight role '{role}'."));
                }
                let path = path.trim();
                validate_path(role, path)?;
                if template["paths"][role].as_str() != Some(path) {
                    // An old download source must not silently override the newly selected file.
                    if let Some(sources) =
                        template.get_mut("sources").and_then(Value::as_object_mut)
                    {
                        sources.remove(role);
                    }
                }
                template["paths"][role] = json!(path);
            }
        }
        if let Some(loras) = &patch.loras {
            let mut ids = std::collections::BTreeSet::new();
            for lora in loras {
                if !ids.insert(&lora.lora_id)
                    || !next
                        .loras
                        .iter()
                        .any(|l| l["id"].as_str() == Some(&lora.lora_id))
                {
                    return Err(format!("Unknown or duplicate LoRA '{}'.", lora.lora_id));
                }
                if !lora.strength.is_finite() || lora.strength.abs() > f32::MAX as f64 {
                    return Err("Invalid LoRA strength.".into());
                }
            }
            template["loras"] = serde_json::to_value(loras).map_err(|e| e.to_string())?;
        }
        if make_default {
            if PATH_FIELDS.iter().any(|role| {
                let path = template["paths"][role].as_str().unwrap_or_default();
                is_url(path)
                    || path.is_empty()
                        && template["sources"][role]
                            .as_array()
                            .is_some_and(|s| !s.is_empty())
            }) || template["additionalSafetensors"]
                .as_array()
                .is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry["downloadedPath"]
                            .as_str()
                            .is_none_or(|p| p.is_empty() || is_url(p) || !Path::new(p).is_file())
                    })
                })
            {
                return Err("Download the generator's weights and additional files before making it the default.".into());
            }
            for role in ["transformer", "textEncoder", "videoVae", "audioVae"] {
                if role == "textEncoder" && template["mode"] == "animate" {
                    continue;
                }
                let path = template["paths"][role].as_str().unwrap_or_default();
                if path.is_empty() || is_url(path) {
                    return Err("Download/configure the required local weights before making a generator the default.".into());
                }
                validate_path(role, path)?;
            }
            let loras_unready = template["loras"].as_array().is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry["enabled"] == true
                        && entry["strength"].as_f64() != Some(0.0)
                        && !next.loras.iter().any(|lora| {
                            lora["id"] == entry["loraId"]
                                && lora["needsPreparation"] != true
                                && lora["path"]
                                    .as_str()
                                    .is_some_and(|p| Path::new(p).is_file())
                        })
                })
            });
            if loras_unready {
                return Err(
                    "Prepare/download the selected LoRAs before making this generator the default."
                        .into(),
                );
            }
        }
        if let Some(index) = index {
            templates[index] = template;
        } else {
            templates.push(template);
        }
        if make_default {
            next.settings["defaultTemplateId"] = json!(id);
        }
    }
    Ok(next)
}
