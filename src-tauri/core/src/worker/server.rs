//! The headless worker: the desktop app's generation queue behind a small
//! HTTP API. Every route runs on its own thread; generation itself stays on
//! the one serial native queue.
use super::{
    discovery,
    protocol::*,
    store::FileStore,
};
use crate::{
    diagnostics,
    names::generated_file_stem,
    settings::{ProviderOption, ProviderSetting},
    rendered, slopfab,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::Read,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};
use tiny_http::{Header, Method, Request, Response, Server};

/// Which GPU backend the worker runs generation on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Backend {
    /// CUDA 13, then CUDA 12, when available; otherwise Vulkan.
    #[default]
    Auto,
    /// CUDA 13, then CUDA 12; an error when neither loads.
    Cuda,
    Cuda13,
    Cuda12,
    Vulkan,
}

impl Backend {
    fn is_cuda(self) -> bool {
        matches!(self, Self::Cuda | Self::Cuda13 | Self::Cuda12)
    }

    /// The engine's CUDA toolkit request.
    pub fn cuda_version(self) -> &'static str {
        match self {
            Self::Cuda13 => "13",
            Self::Cuda12 => "12",
            _ => "auto",
        }
    }
}

impl std::str::FromStr for Backend {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, String> {
        match value.to_ascii_lowercase().replace(['-', ' ', '.'], "").as_str() {
            "auto" => Ok(Self::Auto),
            "cuda" => Ok(Self::Cuda),
            "cuda13" => Ok(Self::Cuda13),
            "cuda12" => Ok(Self::Cuda12),
            "vulkan" => Ok(Self::Vulkan),
            _ => Err(format!("Unknown backend '{value}'. Use auto, cuda, cuda13, cuda12 or vulkan.")),
        }
    }
}

/// The backend to run on, and a warning to show when Auto had to fall back.
/// Forcing CUDA where it cannot load is an error rather than a silent Vulkan run.
pub fn choose_backend(requested: Backend, probe: &slopfab::BackendProbe) -> Result<(bool, Option<String>), String> {
    let problem = probe.cuda_problem.as_deref().unwrap_or("CUDA was not found");
    let flag = match requested {
        Backend::Cuda13 => "--backend cuda13",
        Backend::Cuda12 => "--backend cuda12",
        _ => "--backend cuda",
    };
    let install = match requested {
        _ if !cfg!(windows) => "Install the NVIDIA driver and CUDA 13 cuBLAS (the Linux runtime is built for CUDA 13)",
        Backend::Cuda13 => "Install the CUDA 13 toolkit",
        Backend::Cuda12 => "Install the CUDA 12.8 toolkit",
        _ => "Install CUDA 12.8 (RTX 30/40) or CUDA 13 (RTX 50)",
    };
    match (requested, probe.cuda) {
        (Backend::Vulkan, _) => Ok((true, None)),
        (_, Some(_)) => Ok((false, None)),
        (backend, None) if backend.is_cuda() && probe.nvidia_gpu => Err(format!("{flag}: CUDA is not available ({problem}). {install}, or use --backend vulkan.")),
        (backend, None) if backend.is_cuda() => Err(format!("{flag}: no NVIDIA GPU was found. Use --backend vulkan.")),
        (Backend::Auto, None) if probe.nvidia_gpu => Ok((true, Some(format!(
            "WARNING: This NVIDIA GPU supports CUDA, but CUDA was not detected ({problem}). Using the slower Vulkan backend. {} for faster generation.",
            if cfg!(windows) { "Install CUDA 12.8 (RTX 30/40) or CUDA 13 (RTX 50)" } else { "Install CUDA 13 cuBLAS" }
        )))),
        (_, None) => Ok((true, None)),
    }
}

#[derive(Debug, Clone)]
pub struct WorkerOptions {
    pub port: u16,
    pub name: Option<String>,
    pub token: Option<String>,
    pub data: Option<PathBuf>,
    pub weights: Vec<PathBuf>,
    pub backend: Backend,
    pub advertise: bool,
}

impl Default for WorkerOptions {
    fn default() -> Self {
        Self { port: DEFAULT_PORT, name: None, token: None, data: None, weights: Vec::new(), backend: Backend::Auto, advertise: true }
    }
}

struct JobLog {
    events: Mutex<Vec<WireEvent>>,
    changed: Condvar,
    latents: Option<PathBuf>,
    created: Instant,
}

impl JobLog {
    fn push(&self, kind: &str, payload: serde_json::Value) {
        if let Ok(mut events) = self.events.lock() {
            let seq = events.len() as u64 + 1;
            events.push(WireEvent { seq, kind: kind.into(), payload });
        }
        self.changed.notify_all();
    }

    /// Long poll: returns as soon as anything after `after` exists.
    fn after(&self, after: u64, wait: Duration) -> Vec<WireEvent> {
        let Ok(events) = self.events.lock() else { return Vec::new() };
        let (events, _) = self
            .changed
            .wait_timeout_while(events, wait, |events| events.len() as u64 <= after)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        events.iter().filter(|event| event.seq > after).cloned().collect()
    }
}

struct Preparation {
    status: Mutex<FilePreparation>,
    cancel: Arc<AtomicBool>,
    created: Instant,
}

struct Worker {
    id: String,
    name: String,
    token: Option<String>,
    vulkan: bool,
    data: PathBuf,
    store: Arc<FileStore>,
    runtime: slopfab::SlopfabRuntime,
    jobs: Mutex<HashMap<String, Arc<JobLog>>>,
    preparations: Mutex<HashMap<String, Arc<Preparation>>>,
    upscales: Mutex<HashMap<String, Arc<crate::upscale_stream::Session>>>,
}

struct HttpError(u16, String);

impl From<String> for HttpError {
    fn from(message: String) -> Self {
        Self(400, message)
    }
}
impl From<&str> for HttpError {
    fn from(message: &str) -> Self {
        Self(400, message.into())
    }
}

type Reply = Result<Response<Box<dyn Read + Send>>, HttpError>;

fn json<T: Serialize>(value: &T) -> Reply {
    let body = serde_json::to_vec(value).map_err(|error| HttpError(500, error.to_string()))?;
    Ok(bytes(body, "application/json"))
}

fn bytes(body: Vec<u8>, kind: &str) -> Response<Box<dyn Read + Send>> {
    let length = body.len();
    Response::new(
        200.into(),
        vec![Header::from_bytes("Content-Type", kind).unwrap()],
        Box::new(std::io::Cursor::new(body)) as Box<dyn Read + Send>,
        Some(length),
        None,
    )
}

fn body<T: DeserializeOwned>(request: &mut Request) -> Result<T, HttpError> {
    let mut text = Vec::new();
    request
        .as_reader()
        .take(64 * 1024 * 1024)
        .read_to_end(&mut text)
        .map_err(|error| HttpError(400, error.to_string()))?;
    serde_json::from_slice(&text).map_err(|error| HttpError(400, format!("Invalid request body: {error}")))
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn parsed_header<T: std::str::FromStr>(request: &Request, name: &str) -> Result<T, HttpError> {
    header(request, name)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| HttpError(400, format!("Missing or invalid {name} header.")))
}

fn data_directory(options: &WorkerOptions) -> PathBuf {
    options.data.clone().unwrap_or_else(|| {
        if cfg!(windows) {
            std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Slopus Worker")
        } else {
            // XDG base directories: $XDG_DATA_HOME, else ~/.local/share.
            std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
                .unwrap_or_else(std::env::temp_dir)
                .join("slopus-worker")
        }
    })
}

fn worker_id(data: &std::path::Path) -> Result<String, String> {
    let path = data.join("worker-id");
    if let Ok(id) = fs::read_to_string(&path) {
        if valid_key(id.trim()) {
            return Ok(id.trim().to_string());
        }
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let id = format!("{:016x}", u64::from_le_bytes(random));
    fs::write(&path, &id).map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(id)
}

pub fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        // Shells set HOSTNAME without exporting it, so services rarely see it.
        .or_else(|| fs::read_to_string("/etc/hostname").ok().map(|name| name.trim().to_string()))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "Slopus worker".into())
}

/// Runs the worker until the process exits.
pub fn run(options: WorkerOptions) -> Result<(), String> {
    let data = data_directory(&options);
    fs::create_dir_all(&data).map_err(|error| format!("Could not create {}: {error}", data.display()))?;
    if let Err(error) = diagnostics::initialize_in(&data.join("logs")) {
        eprintln!("Could not initialize diagnostic logging: {error}");
    }
    let roots = crate::weights::worker_weight_roots(&options.weights, &data)?;
    // Vulkan needs no CUDA probe; the engine then keeps its default toolkit choice.
    let probed = if options.backend == Backend::Vulkan { Err(String::new()) }
        else { slopfab::probe_backend(&slopfab::default_dll_path(), options.backend.cuda_version()) };
    let (vulkan, backend) = match probed {
        Ok(probe) => {
            let (vulkan, warning) = choose_backend(options.backend, &probe)?;
            if let Some(warning) = warning {
                eprintln!("{warning}");
                diagnostics::warn("worker", "backend.fallback", &warning, serde_json::json!({}));
            }
            (vulkan, if vulkan { "Vulkan" } else { probe.cuda.unwrap_or("CUDA") })
        }
        Err(_) if options.backend == Backend::Vulkan => (true, "Vulkan"),
        // The engine could not load; the worker still answers and reports why.
        Err(_) => (false, "unavailable"),
    };
    let worker = Arc::new(Worker {
        id: worker_id(&data)?,
        name: options.name.clone().unwrap_or_else(computer_name),
        token: options.token.clone().filter(|token| !token.is_empty()),
        vulkan,
        store: Arc::new(FileStore::new(&data, roots.clone())?),
        data,
        runtime: slopfab::SlopfabRuntime::default(),
        jobs: Mutex::default(),
        preparations: Mutex::default(),
        upscales: Mutex::default(),
    });
    let server = Server::http(("0.0.0.0", options.port)).map_err(|error| format!("Could not listen on port {}: {error}", options.port))?;
    let cleanup = Arc::downgrade(&worker);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        let Some(worker) = cleanup.upgrade() else { break };
        if let Ok(mut sessions) = worker.upscales.lock() {
            sessions.retain(|_, session| {
                let keep = session.idle_for() < Duration::from_secs(30 * 60);
                if !keep { session.cancel(); }
                keep
            });
        };
    });
    let info = worker.info();
    println!("Slopus worker '{}' ({}) listening on port {}.", info.name, info.id, options.port);
    println!("Engine: {} {}", info.runtime.state, info.runtime.version.as_deref().unwrap_or(""));
    println!("Backend: {backend}{}", if options.backend == Backend::Auto { " (automatic; override with --backend)" } else { "" });
    println!("Weights: {}", roots.iter().map(|root| root.display().to_string()).collect::<Vec<_>>().join("; "));
    println!("Data: {}", worker.data.display());
    if worker.token.is_some() {
        println!("Clients must enter this worker's access token.");
    }
    diagnostics::info("worker", "started", "Slopus worker started.", serde_json::json!({ "port": options.port, "id": info.id }));
    let _advertisement = if options.advertise {
        match discovery::advertise(&info, options.port) {
            Ok(daemon) => Some(daemon),
            Err(error) => {
                eprintln!("mDNS advertisement failed; clients must add this worker by address: {error}");
                None
            }
        }
    } else {
        None
    };
    for request in server.incoming_requests() {
        let worker = worker.clone();
        std::thread::spawn(move || worker.handle(request));
    }
    Ok(())
}

impl Worker {
    fn info(&self) -> WorkerInfo {
        let status = slopfab::status(&BTreeMap::new());
        let loaded = matches!(status.state, "ready" | "modelsMissing");
        WorkerInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            version: env!("CARGO_PKG_VERSION").into(),
            protocol: PROTOCOL_VERSION,
            requires_token: self.token.is_some(),
            gpus: crate::weights::hardware_devices(),
            runtime: WorkerRuntime {
                state: if loaded { "ready".into() } else { status.state.into() },
                version: status.version,
                platform: if self.vulkan && loaded { Some("Vulkan".into()) } else { status.platform.map(Into::into) },
                cuda_available: status.cuda_available,
                cuda_device_names: status.cuda_device_names,
                detail: if loaded { format!("Engine loaded from {}.", status.dll_path) } else { status.detail },
            },
        }
    }

    fn handle(&self, mut request: Request) {
        let started = Instant::now();
        let method = request.method().clone();
        let url = request.url().to_string();
        let reply = self.route(&mut request, &method, &url);
        let response = match reply {
            Ok(response) => response,
            Err(HttpError(status, message)) => {
                if status >= 500 || !url.ends_with("/events") {
                    diagnostics::warn("worker", "request.failed", &message, serde_json::json!({ "url": url, "status": status }));
                }
                let body = serde_json::to_vec(&serde_json::json!({ "error": message })).unwrap_or_default();
                bytes(body, "application/json").with_status_code(status)
            }
        };
        let _ = request.respond(response);
        if started.elapsed() > Duration::from_secs(30) && !url.contains("/events") {
            diagnostics::debug("worker", "request.slow", "Slow worker request.", serde_json::json!({ "url": url, "ms": started.elapsed().as_millis() as u64 }));
        }
    }

    fn route(&self, request: &mut Request, method: &Method, url: &str) -> Reply {
        let (path, query) = url.split_once('?').unwrap_or((url, ""));
        let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
        if parts.first() != Some(&"v1") {
            return Err(HttpError(404, "Unknown worker route.".into()));
        }
        if !matches!(parts.as_slice(), ["v1", "info"]) {
            if let Some(token) = &self.token {
                if header(request, TOKEN_HEADER) != Some(token.as_str()) {
                    return Err(HttpError(401, "This worker requires an access token. Enter it in Settings → Workers.".into()));
                }
            }
        }
        match (method, &parts[1..]) {
            (Method::Get, ["info"]) => json(&self.info()),
            (Method::Post, ["upscales", id]) => {
                generated_file_stem(id)?;
                let options: StartUpscale = body(request)?;
                if !(1..=5).contains(&options.segment_frames) || options.width < 16 || options.height < 16 {
                    return Err("Invalid SeedVR2 dimensions or segment size.".into());
                }
                if self.vulkan { return Err("SeedVR2 requires a CUDA worker.".into()); }
                let mut sessions = self.upscales.lock().map_err(|_| "Lock failed.")?;
                sessions.retain(|_, session| {
                    let keep = session.idle_for() < Duration::from_secs(30 * 60);
                    if !keep { session.cancel(); }
                    keep
                });
                if !sessions.is_empty() { return Err("Another upscale export is running on this worker.".into()); }
                let store = self.store.clone();
                let session = crate::upscale_stream::Session::start((options.input_width, options.input_height), (options.width, options.height), move |stop, read, write| {
                    let files = [options.model.unwrap_or(FileRef::Url { url: SEEDVR2_MODEL.into(), lora: false }),
                        options.vae.unwrap_or(FileRef::Url { url: SEEDVR2_VAE.into(), lora: false })];
                    store.prepare(&files, stop, |_| {})?;
                    let config = slopfab::upscale::UpscaleConfig { method: slopfab::upscale::UpscaleMethod::Seedvr2,
                        model_path: store.resolve(&files[0])?.to_string_lossy().into_owned(),
                        vae_path: Some(store.resolve(&files[1])?.to_string_lossy().into_owned()) };
                    slopfab::upscale::run(&config, (options.input_width, options.input_height), (options.width, options.height), options.segment_frames as i32, stop, read, write)
                })?;
                sessions.insert(id.to_string(), session);
                json(&true)
            }
            (Method::Post, ["upscales", id, "frames"]) => {
                let session = self.upscale(id)?;
                let mut pixels = Vec::new();
                request.as_reader().take(512 * 1024 * 1024 + 1).read_to_end(&mut pixels).map_err(|e| e.to_string())?;
                session.push(pixels)?;
                json(&true)
            }
            (Method::Post, ["upscales", id, "finish"]) => { self.upscale(id)?.finish()?; json(&true) }
            (Method::Get, ["upscales", id, "frames"]) => Ok(bytes(self.upscale(id)?.read()?, "application/octet-stream")),
            (Method::Get, ["upscales", id]) => { self.upscale(id)?.touch(); json(&true) }
            (Method::Delete, ["upscales", id]) => {
                if let Some(session) = self.upscales.lock().map_err(|_| "Lock failed.")?.remove(*id) { session.cancel(); }
                json(&true)
            }
            (Method::Post, ["uploads", "missing"]) => {
                let files: Vec<FileRef> = body(request)?;
                json(&MissingUploads { missing: self.store.missing(&files)? })
            }
            (Method::Put, ["uploads", key, entry @ ..]) => {
                let entry = entry.iter().map(|part| percent_decode(part)).collect::<Result<Vec<_>, _>>()?.join("/");
                let bytes = request.body_length().ok_or("Uploads need a Content-Length.")? as u64;
                let key = key.to_string();
                self.store.receive(&key, &entry, bytes, request.as_reader())?;
                json(&true)
            }
            (Method::Post, ["prepare", id]) => {
                let files: Vec<FileRef> = body(request)?;
                self.start_preparation(id, files)?;
                json(&true)
            }
            (Method::Get, ["prepare", id]) => {
                let preparation = self.preparations.lock().map_err(|_| "Lock failed.")?.get(*id).cloned()
                    .ok_or(HttpError(404, "No preparation with this id.".into()))?;
                let status = preparation.status.lock().map_err(|_| "Lock failed.")?.clone();
                json(&status)
            }
            (Method::Post, ["prepare", id, "cancel"]) => {
                if let Some(preparation) = self.preparations.lock().map_err(|_| "Lock failed.")?.get(*id) {
                    preparation.cancel.store(true, Ordering::Relaxed);
                }
                json(&true)
            }
            (Method::Post, ["plan"]) => {
                let job: RemoteJob = body(request)?;
                let (request, settings) = self.materialize(job)?;
                json(&slopfab::resolve_plan(&request, &settings, &self.runtime.references)?)
            }
            (Method::Post, ["refmods"]) => {
                let export: RefmodExport = body(request)?;
                let id = generated_file_stem(&export.job.request.job_id)?;
                let (request, settings) = self.materialize(export.job)?;
                let directory = self.data.join("refmods");
                fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
                let path = directory.join(format!("{id}.safetensors"));
                let refmod = slopfab::export_refmod(&request, &settings, &self.runtime.references, &path, &export.name, &export.description)
                    .and_then(|_| fs::read(&path).map_err(|error| error.to_string()));
                let _ = fs::remove_file(&path);
                Ok(bytes(refmod?, "application/octet-stream"))
            }
            (Method::Post, ["jobs", id]) => {
                let start: StartJob = body(request)?;
                self.start_job(id, start)?;
                json(&true)
            }
            (Method::Get, ["jobs", id, "events"]) => {
                let after = query.split('&').find_map(|pair| pair.strip_prefix("after=")).and_then(|value| value.parse().ok()).unwrap_or(0);
                let log = self.job(id)?;
                json(&log.after(after, Duration::from_secs(20)))
            }
            (Method::Post, ["jobs", id, "cancel"]) => json(&self.runtime.cancel(id)),
            (Method::Get, ["jobs", id, "summary"]) => {
                json(&rendered::summary(id).ok_or(HttpError(404, "The frames of this job are not in memory.".into()))?)
            }
            (Method::Get, ["jobs", id, "frames", index]) => {
                let index: u32 = index.parse().map_err(|_| "Invalid frame index.")?;
                let frame = rendered::frame(id, index)?.ok_or(HttpError(404, format!("Frame {index} of {id} is not in memory.")))?;
                Ok(bytes(frame, "application/octet-stream"))
            }
            (Method::Get, ["jobs", id, "audio"]) => {
                Ok(bytes(rendered::audio(id).ok_or(HttpError(404, "The audio of this job is not in memory.".into()))?, "application/octet-stream"))
            }
            (Method::Get, ["jobs", id, "latents"]) => {
                let log = self.job(id)?;
                let path = log.latents.clone().ok_or(HttpError(404, "This job saves no latents.".into()))?;
                let file = fs::File::open(&path).map_err(|error| HttpError(404, format!("Latents are unavailable: {error}")))?;
                let length = file.metadata().map(|meta| meta.len() as usize).ok();
                Ok(Response::new(200.into(), vec![Header::from_bytes("Content-Type", "application/octet-stream").unwrap()],
                    Box::new(file) as Box<dyn Read + Send>, length, None))
            }
            (Method::Delete, ["jobs", id]) => {
                self.release_job(id);
                json(&true)
            }
            (Method::Post, ["reference-videos"]) => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Create { duration_seconds: f64 }
                let create: Create = body(request)?;
                json(&self.runtime.references.create_reference_video(create.duration_seconds, &BTreeMap::new())?)
            }
            (Method::Post, ["reference-videos", "release"]) => {
                let ids: Vec<String> = body(request)?;
                self.runtime.references.release_reference_videos(&ids)?;
                json(&true)
            }
            (Method::Post, ["reference-videos", id, "frames"]) => {
                let width = parsed_header(request, "x-reference-width")?;
                let height = parsed_header(request, "x-reference-height")?;
                let time = parsed_header(request, "x-reference-time")?;
                let mut pixels = Vec::new();
                request.as_reader().take(512 * 1024 * 1024).read_to_end(&mut pixels).map_err(|error| error.to_string())?;
                self.runtime.references.append_reference_video(id, &pixels, width, height, time)?;
                json(&true)
            }
            (Method::Post, ["reference-videos", id, "audio"]) => {
                let channels = parsed_header(request, "x-reference-channels")?;
                let rate = parsed_header(request, "x-reference-rate")?;
                let mut samples = Vec::new();
                request.as_reader().take(1024 * 1024 * 1024).read_to_end(&mut samples).map_err(|error| error.to_string())?;
                self.runtime.references.set_reference_video_audio(id, &samples, channels, rate)?;
                json(&true)
            }
            (Method::Post, ["reference-audios"]) => {
                let channels = parsed_header(request, "x-reference-channels")?;
                let rate = parsed_header(request, "x-reference-rate")?;
                let mut samples = Vec::new();
                request.as_reader().take(1024 * 1024 * 1024).read_to_end(&mut samples).map_err(|error| error.to_string())?;
                json(&self.runtime.references.create_reference_audio(&samples, channels, rate)?)
            }
            (Method::Post, ["reference-audios", "release"]) => {
                let ids: Vec<String> = body(request)?;
                self.runtime.references.release_reference_audios(&ids)?;
                json(&true)
            }
            _ => Err(HttpError(404, "Unknown worker route.".into())),
        }
    }

    fn job(&self, id: &str) -> Result<Arc<JobLog>, HttpError> {
        self.jobs.lock().map_err(|_| "Lock failed.")?.get(id).cloned().ok_or(HttpError(404, "No job with this id.".into()))
    }

    fn upscale(&self, id: &str) -> Result<Arc<crate::upscale_stream::Session>, HttpError> {
        self.upscales.lock().map_err(|_| "Lock failed.")?.get(id).cloned().ok_or(HttpError(404, "Upscale session has ended.".into()))
    }

    fn start_preparation(&self, id: &str, files: Vec<FileRef>) -> Result<(), String> {
        generated_file_stem(id)?;
        let preparation = Arc::new(Preparation {
            status: Mutex::new(FilePreparation { state: "running".into(), ..Default::default() }),
            cancel: Arc::new(AtomicBool::new(false)),
            created: Instant::now(),
        });
        {
            let mut preparations = self.preparations.lock().map_err(|_| "Lock failed.")?;
            // Keep finished results long enough for their client to read them.
            preparations.retain(|_, entry| entry.created.elapsed() < Duration::from_secs(60 * 60)
                || entry.status.lock().is_ok_and(|status| status.state == "running"));
            if preparations.get(id).is_some_and(|entry| entry.status.lock().is_ok_and(|status| status.state != "running")) {
                preparations.remove(id);
            }
            if preparations.contains_key(id) {
                return Err("Files for this job are already being prepared.".into());
            }
            preparations.insert(id.to_string(), preparation.clone());
        }
        let store = self.store.clone();
        let shared = preparation;
        std::thread::spawn(move || {
            let result = store.prepare(&files, &shared.cancel, |status| {
                if let Ok(mut current) = shared.status.lock() {
                    *current = status.clone();
                }
            });
            if let Ok(mut status) = shared.status.lock() {
                match result {
                    Ok(()) => status.state = "done".into(),
                    Err(_) if shared.cancel.load(Ordering::Relaxed) => status.state = "cancelled".into(),
                    Err(error) => {
                        status.state = "failed".into();
                        status.error = Some(error);
                    }
                }
            }
        });
        Ok(())
    }

    /// Turns a client's job into one this machine can run: tokens become this
    /// worker's own files, and machine choices are this worker's.
    fn materialize(&self, job: RemoteJob) -> Result<(slopfab::GenerationRequest, BTreeMap<String, ProviderSetting>), String> {
        let paths = job.files.iter().map(|file| self.store.resolve(file)).collect::<Result<Vec<_>, _>>()?;
        let mut request = job.request;
        let mut settings = job.settings;
        settings.retain(|name, _| name == "slopfab");
        visit_paths(&mut request, &mut settings, |_, value| {
            let index = parse_file_token(value).ok_or("A worker job can only name files sent with it.")?;
            *value = paths.get(index).ok_or("A worker job names a file it did not send.")?.to_string_lossy().into_owned();
            Ok(())
        })?;
        if let Some(slopfab) = settings.get_mut("slopfab") {
            // The backend is a property of the computer that runs the job.
            slopfab.options.remove("inferenceBackend");
            if self.vulkan {
                slopfab.options.insert("inferenceBackend".into(), ProviderOption::String("vulkan".into()));
            }
        }
        let file = |index: Option<usize>| index.map(|index| paths.get(index).cloned().ok_or("A worker job names a file it did not send.")).transpose();
        request.continuation_path = file(job.continuation)?;
        request.image_edit_path = file(job.image_edit_source)?;
        if request.image_edit.is_some() && request.image_edit_path.is_none() {
            return Err("Image edits require their source image.".into());
        }
        request.image_edit_pixels = None;
        request.save_latents_path = None;
        Ok((request, settings))
    }

    fn start_job(&self, id: &str, start: StartJob) -> Result<(), String> {
        generated_file_stem(id)?;
        if start.job.request.job_id != id {
            return Err("The job id does not match its request.".into());
        }
        self.prune_jobs();
        let (mut request, settings) = self.materialize(start.job)?;
        let latents = if start.save_latents && !request.still_image {
            let directory = self.data.join("jobs").join(id);
            let _ = fs::remove_dir_all(&directory);
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            Some(directory.join("latents.safetensors"))
        } else {
            None
        };
        request.save_latents_path = latents.clone();
        let log = Arc::new(JobLog { events: Mutex::default(), changed: Condvar::new(), latents, created: Instant::now() });
        {
            let mut jobs = self.jobs.lock().map_err(|_| "Lock failed.")?;
            if jobs.contains_key(id) {
                return Err("This job was already started on the worker.".into());
            }
            jobs.insert(id.to_string(), log.clone());
        }
        let sink = log.clone();
        let result = self.runtime.enqueue(
            Arc::new(move |event| match event {
                slopfab::NativeEvent::Job(value) => sink.push("job", serde_json::to_value(value).unwrap_or_default()),
                slopfab::NativeEvent::Progress(value) => sink.push("progress", serde_json::to_value(value).unwrap_or_default()),
            }),
            request,
            &settings,
        );
        if result.is_err() {
            self.release_job(id);
        }
        result
    }

    fn release_job(&self, id: &str) {
        rendered::release(id);
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.remove(id);
        }
        if generated_file_stem(id).is_ok() {
            let _ = fs::remove_dir_all(self.data.join("jobs").join(id));
        }
    }

    /// Clients release their jobs; this catches the ones that vanished.
    fn prune_jobs(&self) {
        let stale: Vec<String> = self.jobs.lock().map(|jobs| jobs.iter()
            .filter(|(_, log)| log.created.elapsed() > Duration::from_secs(12 * 60 * 60))
            .map(|(id, _)| id.clone()).collect()).unwrap_or_default();
        for id in stale {
            self.release_job(&id);
        }
    }
}

fn percent_decode(part: &str) -> Result<String, String> {
    let bytes = part.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = part.get(index + 1..index + 3).ok_or("Invalid escape in upload path.")?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| "Invalid escape in upload path.")?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "Upload paths must be UTF-8.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(nvidia_gpu: bool, cuda: Option<&'static str>) -> slopfab::BackendProbe {
        slopfab::BackendProbe { nvidia_gpu, cuda, cuda_problem: (nvidia_gpu && cuda.is_none()).then(|| "cublas64_12.dll not found".into()) }
    }

    #[test]
    fn auto_uses_cuda_when_it_loads_and_warns_before_falling_back_on_nvidia() {
        assert_eq!(choose_backend(Backend::Auto, &probe(true, Some("CUDA 13"))).unwrap(), (false, None));
        let (vulkan, warning) = choose_backend(Backend::Auto, &probe(true, None)).unwrap();
        assert!(vulkan);
        assert!(warning.unwrap().contains("cublas64_12.dll not found"));
        assert_eq!(choose_backend(Backend::Auto, &probe(false, None)).unwrap(), (true, None), "AMD and Intel use Vulkan quietly");
    }

    #[test]
    fn a_requested_cuda_major_must_load() {
        assert_eq!(Backend::Cuda13.cuda_version(), "13");
        assert_eq!(Backend::Cuda12.cuda_version(), "12");
        assert_eq!(Backend::Auto.cuda_version(), "auto");
        assert_eq!("CUDA-12".parse::<Backend>().unwrap(), Backend::Cuda12);
        assert_eq!("cuda13".parse::<Backend>().unwrap(), Backend::Cuda13);
        assert_eq!(choose_backend(Backend::Cuda12, &probe(true, Some("CUDA 12"))).unwrap(), (false, None));
        let error = choose_backend(Backend::Cuda13, &probe(true, None)).unwrap_err();
        let hint = if cfg!(windows) { "CUDA 13 toolkit" } else { "CUDA 13 cuBLAS" };
        assert!(error.starts_with("--backend cuda13") && error.contains(hint), "{error}");
    }

    #[test]
    fn an_explicit_backend_overrides_detection_but_cuda_must_exist() {
        assert_eq!(choose_backend(Backend::Vulkan, &probe(true, Some("CUDA 12"))).unwrap(), (true, None));
        assert_eq!(choose_backend(Backend::Cuda, &probe(true, Some("CUDA 12"))).unwrap(), (false, None));
        assert!(choose_backend(Backend::Cuda, &probe(true, None)).unwrap_err().contains("CUDA is not available"));
        assert!(choose_backend(Backend::Cuda, &probe(false, None)).unwrap_err().contains("no NVIDIA GPU"));
        assert_eq!("VULKAN".parse::<Backend>().unwrap(), Backend::Vulkan);
        assert!("metal".parse::<Backend>().is_err());
    }
}
