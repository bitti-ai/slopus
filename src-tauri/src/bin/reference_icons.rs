use slopus_lib::{generate_reference_icon_batch, ReferenceIconBatchConfig, ReferenceIconSpec};
use std::{env, fs, path::PathBuf};

fn required(name: &str) -> Result<String, String> {
    env::var(name).map_err(|_| format!("{name} is required."))
}

fn run() -> Result<(), String> {
    let manifest = env::args()
        .nth(1)
        .ok_or_else(|| "Pass the batch JSON path.".to_string())?;
    let specs: Vec<ReferenceIconSpec> = serde_json::from_slice(
        &fs::read(&manifest).map_err(|error| format!("Could not read '{manifest}': {error}"))?,
    )
    .map_err(|error| format!("Could not parse '{manifest}': {error}"))?;
    generate_reference_icon_batch(
        &specs,
        &ReferenceIconBatchConfig {
            dll_path: PathBuf::from(required("SLOPFAB_EXE")?).with_file_name("slopfab.dll"),
            transformer: required("SLOPFAB_TRANSFORMER")?.into(),
            text_encoder: required("SLOPFAB_TEXT_ENCODER")?.into(),
            video_vae: required("SLOPFAB_VIDEO_VAE")?.into(),
            backend: env::var("SLOPFAB_BACKEND").unwrap_or_else(|_| "cuda".into()),
        },
    )
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
