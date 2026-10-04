//! Resolve template download variants using the actual destination worker.
use crate::{
    project::{ProviderOption, ProviderSetting},
    slopfab::GpuDevice,
};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Variant {
    url: String,
    gpu_model: String,
    min_vram_gb: f64,
}

pub(super) fn select(
    settings: &mut BTreeMap<String, ProviderSetting>,
    gpus: &[GpuDevice],
) -> Result<(), String> {
    let Some(engine) = settings.get_mut("slopfab") else {
        return Ok(());
    };
    let Some(metadata) = engine.options.remove("workerWeightSources") else {
        return Ok(());
    };
    let ProviderOption::String(metadata) = metadata else {
        return Err("Invalid worker weight variants.".into());
    };
    let variants: BTreeMap<String, Vec<Variant>> = serde_json::from_str(&metadata)
        .map_err(|e| format!("Invalid worker weight variants: {e}"))?;
    for role in [
        "transformer",
        "textEncoder",
        "videoVae",
        "audioVae",
        "tokenizer",
    ] {
        let Some(entries) = variants.get(role).filter(|entries| !entries.is_empty()) else {
            continue;
        };
        let Some(ProviderOption::String(value)) = engine.options.get(role) else {
            continue;
        };
        if !value.trim().is_empty()
            && !value.to_ascii_lowercase().starts_with("https://")
            && !value.to_ascii_lowercase().starts_with("http://")
        {
            // A manually located file remains an explicit choice. A client
            // download, however, must be reconsidered for this worker.
            let original = slopus_core::weights::recorded_download_url(Path::new(value));
            if !original.is_some_and(|url| {
                entries.iter().any(|entry| {
                    slopus_core::weights::download_url(&entry.url)
                        .is_ok_and(|candidate| candidate.as_str() == url)
                })
            }) {
                continue;
            }
        }
        let mut best: Option<&Variant> = None;
        for entry in entries {
            if !entry.min_vram_gb.is_finite() || entry.min_vram_gb < 0.0 {
                return Err(format!("Invalid {role} weight VRAM requirement."));
            }
            let model = entry.gpu_model.trim().to_lowercase();
            let compatible = model.is_empty() && entry.min_vram_gb == 0.0
                || gpus.iter().any(|gpu| {
                    gpu.name.to_lowercase().contains(&model)
                        && (gpu.memory_bytes as f64 / 1024f64.powi(3)).ceil() >= entry.min_vram_gb
                });
            if compatible
                && best.is_none_or(|current| {
                    (!model.is_empty(), entry.min_vram_gb)
                        > (!current.gpu_model.trim().is_empty(), current.min_vram_gb)
                })
            {
                best = Some(entry);
            }
        }
        let selected = best.ok_or_else(||format!("No {role} download variant matches the worker's GPU and VRAM. Add a compatible source in Generator settings."))?;
        let url = slopus_core::weights::download_url(&selected.url)?;
        engine
            .options
            .insert(role.into(), ProviderOption::String(url.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::slopfab::GenerationRequest;
    use crate::worker::client::build_job;
    use serde_json::json;
    use slopus_core::worker::protocol::FileRef;

    fn settings(path: &str) -> BTreeMap<String, ProviderSetting> {
        BTreeMap::from([("slopfab".into(),ProviderSetting { enabled:true,model:None,options:BTreeMap::from([
            ("transformer".into(),ProviderOption::String(path.into())),
            ("workerWeightSources".into(),ProviderOption::String(json!({"transformer":[
                {"url":"https://example.com/small.safetensors","gpuModel":"","minVramGb":0},
                {"url":"https://example.com/large.safetensors","gpuModel":"","minVramGb":24},
                {"url":"https://example.com/5090.safetensors","gpuModel":"RTX 5090","minVramGb":32}
            ]}).to_string()))
        ]) })])
    }

    #[test]
    fn remote_jobs_reselect_urls_using_destination_gpu_and_vram() {
        for (name, gb, expected) in [
            ("RTX 3060", 12.0, "small"),
            ("RTX 4090", 24.0, "large"),
            ("NVIDIA GeForce RTX 5090", 31.4, "5090"),
            ("AMD Radeon", 32.0, "large"),
        ] {
            // The UI/client previously chose an entirely different GPU's file.
            let settings = settings("https://example.com/5090.safetensors");
            let devices = [GpuDevice {
                name: name.into(),
                memory_bytes: (gb * 1024f64.powi(3)) as u64,
            }];
            let (job, uploads) =
                build_job(&GenerationRequest::default(), &settings, &devices).unwrap();
            assert_eq!(
                job.files,
                vec![FileRef::Url {
                    url: format!("https://example.com/{expected}.safetensors"),
                    lora: false
                }]
            );
            assert!(uploads.is_empty());
            assert!(!job.settings["slopfab"]
                .options
                .contains_key("workerWeightSources"));
            assert_eq!(
                settings["slopfab"].options["transformer"],
                ProviderOption::String("https://example.com/5090.safetensors".into())
            );
        }
        let (job, _) = build_job(
            &GenerationRequest::default(),
            &settings("https://example.com/large.safetensors"),
            &[],
        )
        .unwrap();
        assert_eq!(
            job.files,
            vec![FileRef::Url {
                url: "https://example.com/small.safetensors".into(),
                lora: false
            }]
        );
    }

    #[test]
    fn client_download_records_do_not_pin_worker_variants_but_custom_files_still_upload() {
        let folder = tempfile::tempdir().unwrap();
        let url =
            slopus_core::weights::download_url("https://example.com/large.safetensors").unwrap();
        let path = folder
            .path()
            .join(slopus_core::weights::destination_name(&url));
        std::fs::write(&path, b"data").unwrap();
        std::fs::write(
            path.with_extension("complete.json"),
            json!({"url":url.as_str(),"bytes":4}).to_string(),
        )
        .unwrap();
        let (job, uploads) = build_job(
            &GenerationRequest::default(),
            &settings(&path.to_string_lossy()),
            &[],
        )
        .unwrap();
        assert_eq!(
            job.files,
            vec![FileRef::Url {
                url: "https://example.com/small.safetensors".into(),
                lora: false
            }]
        );
        assert!(uploads.is_empty());
        let custom = folder.path().join("custom.safetensors");
        std::fs::write(&custom, b"custom").unwrap();
        let (job, uploads) = build_job(
            &GenerationRequest::default(),
            &settings(&custom.to_string_lossy()),
            &[],
        )
        .unwrap();
        assert!(matches!(&job.files[0],FileRef::Upload {name,..} if name=="custom.safetensors"));
        assert_eq!(uploads.len(), 1);
    }

    #[test]
    fn no_matching_variant_fails_instead_of_using_the_client_choice() {
        let mut settings = settings("https://example.com/large.safetensors");
        settings.get_mut("slopfab").unwrap().options.insert(
            "workerWeightSources".into(),
            ProviderOption::String(
                json!({"transformer":[
                    {"url":"https://example.com/large.safetensors","gpuModel":"","minVramGb":24}
                ]})
                .to_string(),
            ),
        );
        let devices = [
            GpuDevice {
                name: "GPU A".into(),
                memory_bytes: 12 * 1024u64.pow(3),
            },
            GpuDevice {
                name: "GPU B".into(),
                memory_bytes: 12 * 1024u64.pow(3),
            },
        ];
        assert!(
            build_job(&GenerationRequest::default(), &settings, &devices)
                .unwrap_err()
                .contains("worker's GPU and VRAM")
        );
    }
}
