//! Headless generation worker for Slopus on the local network.
//!
//! Runs the same generation code as the desktop app and announces itself with
//! mDNS, so Slopus lists it under Settings → Workers. Place it beside
//! slopfab.dll, like Slopus.exe.
use slopus_core::worker::{run as run_worker, WorkerOptions, DEFAULT_PORT as DEFAULT_WORKER_PORT};
use std::path::PathBuf;

const USAGE: &str = r"Usage: slopus-worker [options]

  --port <number>     TCP port to listen on (default 47321)
  --name <text>       Name shown in Slopus (default: computer name)
  --token <text>      Require this access token from clients
  --data <folder>     Uploads, job files and logs (default: %LOCALAPPDATA%\Slopus Worker)
  --weights <folder>  Extra weights folder to search and download into; repeatable
  --backend <name>    GPU backend: auto (default: CUDA 13, then CUDA 12, else Vulkan),
                      cuda (CUDA 13, then 12), cuda13, cuda12 or vulkan
  --no-mdns           Do not announce on the network; clients add it by address
  --help              Show this help";

fn parse() -> Result<WorkerOptions, String> {
    let mut options = WorkerOptions { port: DEFAULT_WORKER_PORT, ..Default::default() };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value."));
        match arg.as_str() {
            "--port" => options.port = value("--port")?.parse().map_err(|_| "--port needs a number.")?,
            "--name" => options.name = Some(value("--name")?),
            "--token" => options.token = Some(value("--token")?),
            "--data" => options.data = Some(PathBuf::from(value("--data")?)),
            "--weights" => {
                let folder = std::path::absolute(value("--weights")?).map_err(|error| error.to_string())?;
                options.weights.push(folder);
            }
            "--backend" => options.backend = value("--backend")?.parse()?,
            "--no-mdns" => options.advertise = false,
            "--help" | "-h" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            other => return Err(format!("Unknown option {other}.\n\n{USAGE}")),
        }
    }
    Ok(options)
}

fn main() {
    if let Err(error) = parse().and_then(run_worker) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
