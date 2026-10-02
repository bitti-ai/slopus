//! The desktop side of LAN workers: which worker is selected, how to reach it,
//! and running a generation there as if the native queue were local. The
//! webview keeps using the same commands and events either way.
use super::{
    discovery::{self, Announced},
    protocol::*,
};
use crate::{
    diagnostics,
    project::ProviderSetting,
    rendered,
    slopfab::{self, GenerationRequest, GpuDevice},
    weights,
};
use reqwest::blocking::{Body, Client, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

#[derive(Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    /// The selected worker's id. None runs generation on this computer.
    selected: Option<String>,
    /// Addresses added by hand, for networks where mDNS does not reach.
    manual: Vec<String>,
    /// Where each worker was last reached, so a selection survives a restart
    /// before mDNS has answered.
    known: BTreeMap<String, KnownWorker>,
    tokens: BTreeMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnownWorker {
    name: String,
    address: String,
}

#[derive(Clone)]
struct Probe {
    info: Result<WorkerInfo, String>,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    app: OnceLock<AppHandle>,
    file: OnceLock<PathBuf>,
    saved: Mutex<Saved>,
    announced: Mutex<Vec<Announced>>,
    probes: Mutex<HashMap<String, Probe>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    daemon: Mutex<Option<mdns_sd::ServiceDaemon>>,
}

#[derive(Clone, Default)]
pub struct Workers(Arc<Inner>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerView {
    /// The worker id, or the address of a manual worker never reached.
    key: String,
    id: Option<String>,
    name: String,
    address: Option<String>,
    online: bool,
    compatible: bool,
    discovered: bool,
    manual: bool,
    selected: bool,
    version: Option<String>,
    requires_token: bool,
    has_token: bool,
    gpus: Vec<GpuDevice>,
    runtime: Option<WorkerRuntime>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerList {
    selected_id: Option<String>,
    workers: Vec<WorkerView>,
}

/// A selected worker that answered. Cheap to clone; one per remote call.
#[derive(Clone)]
pub(crate) struct Connection {
    base: String,
    token: Option<String>,
    pub(crate) name: String,
    pub(crate) address: String,
    pub(crate) info: WorkerInfo,
    http: Client,
}

/// A worker the list should show, before anyone has asked it anything.
struct Candidate {
    id: Option<String>,
    name: String,
    addresses: Vec<String>,
    discovered: bool,
    manual: bool,
}

const PROBE_FRESH: Duration = Duration::from_secs(10);

fn normalize_address(address: &str) -> Result<String, String> {
    let trimmed = address.trim().trim_start_matches("http://").trim_end_matches('/');
    if trimmed.is_empty() || trimmed.contains(['/', '?', '#', '@', ' ']) {
        return Err("Enter a worker address like 192.168.1.20 or worker-pc:47321.".into());
    }
    let has_port = trimmed.rsplit_once(':').is_some_and(|(host, port)| !host.is_empty() && !host.ends_with(':') && port.parse::<u16>().is_ok());
    Ok(if has_port { trimmed.to_string() } else { format!("{trimmed}:{DEFAULT_PORT}") })
}

fn socket_address(address: &std::net::SocketAddr) -> String {
    match address {
        std::net::SocketAddr::V6(v6) => format!("[{}]:{}", v6.ip(), v6.port()),
        std::net::SocketAddr::V4(v4) => v4.to_string(),
    }
}

fn http_client(timeout: Option<Duration>) -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(timeout)
        .build()
        .unwrap_or_default()
}

fn worker_error(name: &str, response: Response) -> String {
    let status = response.status();
    #[derive(Deserialize)]
    struct Failure { error: String }
    match response.json::<Failure>() {
        Ok(failure) => format!("Worker {name}: {}", failure.error),
        Err(_) => format!("Worker {name} answered {status}."),
    }
}

impl Connection {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::blocking::RequestBuilder {
        let builder = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(token) => builder.header(TOKEN_HEADER, token),
            None => builder,
        }
    }

    fn send(&self, builder: reqwest::blocking::RequestBuilder) -> Result<Response, String> {
        let response = builder.send().map_err(|error| format!("Could not reach worker {}: {error}", self.name))?;
        if response.status().is_success() { Ok(response) } else { Err(worker_error(&self.name, response)) }
    }

    pub(crate) fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        self.send(self.request(reqwest::Method::GET, path))?.json().map_err(|error| format!("Worker {}: {error}", self.name))
    }

    pub(crate) fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T, String> {
        self.send(self.request(reqwest::Method::POST, path).json(body))?.json().map_err(|error| format!("Worker {}: {error}", self.name))
    }

    pub(crate) fn post_bytes(&self, path: &str, headers: &[(&str, String)], bytes: Vec<u8>) -> Result<(), String> {
        let mut builder = self.request(reqwest::Method::POST, path).body(bytes);
        for (name, value) in headers {
            builder = builder.header(*name, value);
        }
        self.send(builder).map(|_| ())
    }

    fn bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        let response = self.send(self.request(reqwest::Method::GET, path))?;
        response.bytes().map(|bytes| bytes.to_vec()).map_err(|error| format!("Worker {}: {error}", self.name))
    }

    fn release(&self, job_id: &str) {
        let _ = self.send(self.request(reqwest::Method::DELETE, &format!("/v1/jobs/{job_id}")));
    }
}

fn probe(address: &str, token: Option<&str>) -> Result<WorkerInfo, String> {
    let mut builder = http_client(Some(Duration::from_secs(3))).get(format!("http://{address}/v1/info"));
    if let Some(token) = token {
        builder = builder.header(TOKEN_HEADER, token);
    }
    let response = builder.send().map_err(|error| format!("Not reachable: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Answered {}.", response.status()));
    }
    let info: WorkerInfo = response.json().map_err(|_| "This address is not a Slopus worker.".to_string())?;
    if !valid_key(&info.id) {
        return Err("This address is not a Slopus worker.".into());
    }
    Ok(info)
}

impl Workers {
    /// Loads the saved selection and starts listening for workers.
    pub fn start(&self, app: &AppHandle, data_directory: &Path) {
        let _ = self.0.app.set(app.clone());
        let file = data_directory.join("workers.json");
        if let Some(saved) = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice::<Saved>(&bytes).ok()) {
            if let Ok(mut current) = self.0.saved.lock() {
                *current = saved;
            }
        }
        let _ = self.0.file.set(file);
        let inner = Arc::downgrade(&self.0);
        match discovery::browse(move |announced| {
            let Some(inner) = inner.upgrade() else { return };
            if let Ok(mut current) = inner.announced.lock() {
                *current = announced;
            }
            if let Some(app) = inner.app.get() {
                let _ = app.emit("workers-changed", ());
            }
        }) {
            Ok(daemon) => {
                if let Ok(mut current) = self.0.daemon.lock() {
                    *current = Some(daemon);
                }
            }
            Err(error) => diagnostics::warn("workers", "discovery.failed", &error, serde_json::json!({})),
        }
    }

    fn save(&self, saved: &Saved) {
        if let Some(file) = self.0.file.get() {
            if let Ok(bytes) = serde_json::to_vec_pretty(saved) {
                if let Err(error) = crate::storage::atomic::write_atomically(file, &bytes) {
                    diagnostics::warn("workers", "save.failed", &error, serde_json::json!({}));
                }
            }
        }
    }

    fn saved(&self) -> Saved {
        self.0.saved.lock().map(|saved| saved.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Saved)) -> Saved {
        let saved = match self.0.saved.lock() {
            Ok(mut saved) => {
                change(&mut saved);
                saved.clone()
            }
            Err(_) => return Saved::default(),
        };
        self.save(&saved);
        if let Some(app) = self.0.app.get() {
            let _ = app.emit("workers-changed", ());
        }
        saved
    }

    fn probe_cached(&self, address: &str, token: Option<&str>, fresh: Duration) -> Result<WorkerInfo, String> {
        if let Some(probe) = self.0.probes.lock().ok().and_then(|probes| probes.get(address).cloned()) {
            if probe.at.elapsed() < fresh {
                return probe.info;
            }
        }
        let info = probe(address, token);
        if let Ok(mut probes) = self.0.probes.lock() {
            probes.insert(address.to_string(), Probe { info: info.clone(), at: Instant::now() });
        }
        info
    }

    /// Every address a worker id might answer on, best first.
    fn addresses_for(&self, id: &str, saved: &Saved) -> Vec<String> {
        let mut addresses: Vec<String> = self.0.announced.lock().map(|announced| announced.iter()
            .filter(|worker| worker.id == id)
            .flat_map(|worker| worker.addresses.iter().map(socket_address))
            .collect()).unwrap_or_default();
        if let Some(known) = saved.known.get(id) {
            addresses.push(known.address.clone());
        }
        addresses.dedup();
        addresses
    }

    /// The selected worker, or None to generate on this computer. A selected
    /// worker that does not answer is an error rather than a silent fallback:
    /// the user chose where their GPU time is spent.
    pub(crate) fn active(&self) -> Result<Option<Connection>, String> {
        let saved = self.saved();
        let Some(id) = saved.selected.clone() else { return Ok(None) };
        let name = saved.known.get(&id).map(|known| known.name.clone()).unwrap_or_else(|| "worker".into());
        let token = saved.tokens.get(&id).cloned();
        let mut last_error = None;
        for address in self.addresses_for(&id, &saved) {
            match self.probe_cached(&address, token.as_deref(), PROBE_FRESH) {
                Ok(info) if info.id == id => {
                    if info.protocol != PROTOCOL_VERSION {
                        return Err(format!("Worker {} uses a different Slopus version ({}). Update it to match this app.", info.name, info.version));
                    }
                    if info.requires_token && token.is_none() {
                        return Err(format!("Worker {} requires an access token. Enter it in Settings → Workers.", info.name));
                    }
                    if saved.known.get(&id).is_none_or(|known| known.address != address || known.name != info.name) {
                        let (worker_name, worker_address) = (info.name.clone(), address.clone());
                        self.update(|saved| { saved.known.insert(id.clone(), KnownWorker { name: worker_name, address: worker_address }); });
                    }
                    return Ok(Some(Connection {
                        base: format!("http://{address}"),
                        token,
                        name: info.name.clone(),
                        address,
                        info,
                        http: http_client(None),
                    }));
                }
                Ok(_) => last_error = Some("Another worker now answers at its last address.".to_string()),
                Err(error) => last_error = Some(error),
            }
        }
        Err(format!(
            "The selected worker {name} is offline{}. Start it, or choose This computer in Settings → Workers.",
            last_error.map(|error| format!(" ({error})")).unwrap_or_default()
        ))
    }

    pub fn list(&self) -> WorkerList {
        let saved = self.saved();
        let announced = self.0.announced.lock().map(|announced| announced.clone()).unwrap_or_default();
        let mut candidates: Vec<Candidate> = announced.iter()
            .map(|worker| Candidate { id: Some(worker.id.clone()), name: worker.name.clone(), addresses: worker.addresses.iter().map(socket_address).collect(), discovered: true, manual: false })
            .collect();
        for address in &saved.manual {
            candidates.push(Candidate { id: None, name: address.clone(), addresses: vec![address.clone()], discovered: false, manual: true });
        }
        if let Some(id) = &saved.selected {
            if let Some(known) = saved.known.get(id) {
                candidates.push(Candidate { id: Some(id.clone()), name: known.name.clone(), addresses: vec![known.address.clone()], discovered: false, manual: false });
            }
        }
        let probes: Vec<_> = std::thread::scope(|scope| {
            let handles: Vec<_> = candidates.iter().map(|Candidate { id, addresses, .. }| {
                let token = id.as_ref().and_then(|id| saved.tokens.get(id)).cloned();
                scope.spawn(move || {
                    let mut last = Err("No address.".to_string());
                    for address in addresses {
                        last = self.probe_cached(address, token.as_deref(), Duration::from_secs(3)).map(|info| (info, address.clone()));
                        if last.is_ok() { break; }
                    }
                    last
                })
            }).collect();
            handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err("Probe failed.".into()))).collect()
        });
        let mut views: Vec<WorkerView> = Vec::new();
        for (Candidate { id, name, addresses, discovered, manual }, probe) in candidates.into_iter().zip(probes) {
            let (id, view) = match probe {
                Ok((info, address)) => (Some(info.id.clone()), WorkerView {
                    key: info.id.clone(), id: Some(info.id.clone()), name: info.name.clone(), address: Some(address),
                    online: true, compatible: info.protocol == PROTOCOL_VERSION, discovered, manual,
                    selected: saved.selected.as_deref() == Some(info.id.as_str()), version: Some(info.version.clone()),
                    requires_token: info.requires_token, has_token: saved.tokens.contains_key(&info.id),
                    gpus: info.gpus.clone(), runtime: Some(info.runtime.clone()), error: None,
                }),
                Err(error) => (id.clone(), WorkerView {
                    key: id.clone().unwrap_or_else(|| addresses.first().cloned().unwrap_or_default()),
                    selected: id.is_some() && saved.selected == id, has_token: id.as_ref().is_some_and(|id| saved.tokens.contains_key(id)),
                    id, name, address: addresses.first().cloned(), online: false, compatible: false, discovered, manual,
                    version: None, requires_token: false, gpus: Vec::new(), runtime: None, error: Some(error),
                }),
            };
            match views.iter_mut().find(|view| id.is_some() && view.id == id) {
                Some(existing) => {
                    existing.discovered |= view.discovered;
                    existing.manual |= view.manual;
                    if !existing.online && view.online {
                        let (discovered, manual) = (existing.discovered, existing.manual);
                        *existing = WorkerView { discovered, manual, ..view };
                    }
                }
                None => views.push(view),
            }
        }
        views.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        WorkerList { selected_id: saved.selected, workers: views }
    }

    pub fn select(&self, id: Option<String>) -> Result<WorkerList, String> {
        if let Some(id) = &id {
            let list = self.list();
            let worker = list.workers.iter().find(|worker| worker.id.as_ref() == Some(id))
                .ok_or("This worker is not available.")?;
            if !worker.online {
                return Err(format!("Worker {} is offline.", worker.name));
            }
            if !worker.compatible {
                return Err(format!("Worker {} runs a different Slopus version. Update it to match this app.", worker.name));
            }
            let known = KnownWorker { name: worker.name.clone(), address: worker.address.clone().unwrap_or_default() };
            self.update(|saved| {
                saved.known.insert(id.clone(), known);
                saved.selected = Some(id.clone());
            });
        } else {
            self.update(|saved| saved.selected = None);
        }
        diagnostics::info("workers", "selected", "Generation worker selected.", serde_json::json!({ "remote": id.is_some() }));
        Ok(self.list())
    }

    pub fn add(&self, address: &str) -> Result<WorkerList, String> {
        let address = normalize_address(address)?;
        let info = probe(&address, None).map_err(|error| format!("{address}: {error}"))?;
        if let Ok(mut probes) = self.0.probes.lock() {
            probes.insert(address.clone(), Probe { info: Ok(info.clone()), at: Instant::now() });
        }
        self.update(|saved| {
            if !saved.manual.contains(&address) {
                saved.manual.push(address.clone());
            }
            saved.known.insert(info.id.clone(), KnownWorker { name: info.name.clone(), address: address.clone() });
        });
        Ok(self.list())
    }

    pub fn remove(&self, key: &str) -> WorkerList {
        self.update(|saved| {
            let address = saved.known.get(key).map(|known| known.address.clone());
            saved.manual.retain(|manual| manual != key && Some(manual) != address.as_ref());
            saved.known.remove(key);
            saved.tokens.remove(key);
            if saved.selected.as_deref() == Some(key) {
                saved.selected = None;
            }
        });
        self.list()
    }

    pub fn set_token(&self, id: &str, token: &str) -> WorkerList {
        let token = token.trim().to_string();
        self.update(|saved| {
            if token.is_empty() { saved.tokens.remove(id); } else { saved.tokens.insert(id.to_string(), token.clone()); }
        });
        if let Ok(mut probes) = self.0.probes.lock() {
            probes.clear();
        }
        self.list()
    }

    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Some(app) = self.0.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    fn register(&self, job_id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut jobs = self.0.jobs.lock().map_err(|_| "Worker job lock failed.")?;
        if jobs.contains_key(job_id) {
            return Err("This generation job is already queued.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        jobs.insert(job_id.to_string(), cancel.clone());
        Ok(cancel)
    }

    fn unregister(&self, job_id: &str) {
        if let Ok(mut jobs) = self.0.jobs.lock() {
            jobs.remove(job_id);
        }
    }

    /// Cancels a job this computer sent to a worker. False when it sent none.
    pub(crate) fn cancel(&self, job_id: &str) -> bool {
        let Some(flag) = self.0.jobs.lock().ok().and_then(|jobs| jobs.get(job_id).cloned()) else { return false };
        flag.store(true, Ordering::Release);
        if let Ok(Some(connection)) = self.active() {
            let job_id = job_id.to_string();
            std::thread::spawn(move || {
                let _ = connection.post::<serde_json::Value>(&format!("/v1/jobs/{job_id}/cancel"), &());
                let _ = connection.post::<serde_json::Value>(&format!("/v1/prepare/{job_id}/cancel"), &());
            });
        }
        true
    }

    /// Uploads what only this computer has, then lets the worker download the
    /// rest. Both report progress as queue events on the job.
    fn send_files(&self, connection: &Connection, job: &RemoteJob, sources: &HashMap<String, PathBuf>, cancel: &Arc<AtomicBool>) -> Result<(), String> {
        let request = &job.request;
        let missing: MissingUploads = connection.post("/v1/uploads/missing", &job.files)?;
        let entries: Vec<(&String, &UploadEntry, bool)> = job.files.iter().flat_map(|file| match file {
            FileRef::Upload { key, entries, directory, .. } => entries.iter()
                .filter(|entry| missing.missing.iter().any(|(k, path)| k == key && *path == entry.path))
                .map(|entry| (key, entry, *directory)).collect(),
            FileRef::Url { .. } => Vec::new(),
        }).collect();
        let total: u64 = entries.iter().map(|(_, entry, _)| entry.bytes).sum();
        let sent = Arc::new(Mutex::new((0u64, Instant::now())));
        for (key, entry, directory) in entries {
            if cancel.load(Ordering::Acquire) {
                return Err("Generation was cancelled before it started.".into());
            }
            let root = sources.get(key).ok_or("Upload source missing.")?;
            let local = if directory { root.join(safe_relative_path(&entry.path)?) } else { root.clone() };
            let file = File::open(&local).map_err(|error| format!("Could not read {}: {error}", local.display()))?;
            if file.metadata().map(|meta| meta.len()).ok() != Some(entry.bytes) {
                return Err(format!("{} changed while it was being sent. Try again.", local.display()));
            }
            let reader = Progress { inner: file, cancel: cancel.clone(), sent: sent.clone(), report: {
                let workers = self.clone();
                let request = request.clone();
                let name = entry.path.clone();
                Box::new(move |done| workers.emit("slopfab-progress", transfer_event(&request, "workerUpload", format!("Sending {name} to the worker"), done, Some(total))))
            } };
            let encoded = entry.path.split('/').map(encode_segment).collect::<Vec<_>>().join("/");
            connection.send(connection.request(reqwest::Method::PUT, &format!("/v1/uploads/{key}/{encoded}"))
                .body(Body::sized(reader, entry.bytes)))
                .map_err(|error| if cancel.load(Ordering::Acquire) { "Generation was cancelled before it started.".into() } else { error })?;
        }
        if !job.files.iter().any(|file| matches!(file, FileRef::Url { .. })) {
            return Ok(());
        }
        let id = &request.job_id;
        connection.post::<bool>(&format!("/v1/prepare/{id}"), &job.files)?;
        loop {
            std::thread::sleep(Duration::from_millis(400));
            if cancel.load(Ordering::Acquire) {
                let _ = connection.post::<bool>(&format!("/v1/prepare/{id}/cancel"), &());
                return Err("Generation was cancelled before it started.".into());
            }
            let status: FilePreparation = connection.get(&format!("/v1/prepare/{id}"))?;
            match status.state.as_str() {
                "done" => return Ok(()),
                "failed" => return Err(format!("Worker {} could not get the weights: {}", connection.name, status.error.unwrap_or_default())),
                "cancelled" => return Err("Generation was cancelled before it started.".into()),
                _ => {
                    let file = status.file.as_deref().and_then(|url| url.rsplit('/').next()).unwrap_or("weights");
                    let detail = format!("Worker downloading {file} ({} of {})", (status.completed + 1).min(status.files), status.files);
                    self.emit("slopfab-progress", transfer_event(request, "workerDownload", detail, status.downloaded, status.total));
                }
            }
        }
    }

    pub(crate) fn plan(&self, connection: &Connection, request: &GenerationRequest, settings: &BTreeMap<String, ProviderSetting>) -> Result<serde_json::Value, String> {
        let (job, sources) = build_job(request, settings)?;
        let cancel = self.register(&request.job_id)?;
        let result = self.send_files(connection, &job, &sources, &cancel)
            .and_then(|_| connection.post::<serde_json::Value>("/v1/plan", &job));
        self.unregister(&request.job_id);
        result
    }

    /// Starts a job on the worker and follows it on a background thread. The
    /// webview receives the same queued/progress/framesReady events, and the
    /// frames wait in this process's render store like a local render.
    pub(crate) fn enqueue(&self, connection: Connection, request: GenerationRequest, settings: &BTreeMap<String, ProviderSetting>) -> Result<(), String> {
        crate::media::artifacts::generated_file_stem(&request.job_id)?;
        let (job, sources) = build_job(&request, settings)?;
        let cancel = self.register(&request.job_id)?;
        let workers = self.clone();
        let latents = request.save_latents_path.clone();
        diagnostics::info("workers", "job.sending", "Generation is being sent to a worker.", serde_json::json!({
            "jobId": request.job_id, "files": job.files.len(),
        }));
        std::thread::Builder::new().name("worker-job".into()).spawn(move || {
            let id = request.job_id.clone();
            let result = workers.send_files(&connection, &job, &sources, &cancel)
                .and_then(|_| connection.post::<bool>(&format!("/v1/jobs/{id}"), &StartJob { job, save_latents: latents.is_some() }))
                .and_then(|_| workers.follow(&connection, &id, latents.as_deref()));
            if let Err(error) = result {
                let state = if cancel.load(Ordering::Acquire) { "cancelled" } else { "failed" };
                diagnostics::warn("workers", "job.failed", &error, serde_json::json!({ "jobId": id, "state": state }));
                workers.emit("slopfab-job", serde_json::json!({ "jobId": id, "state": state, "detail": error, "output": null }));
                connection.release(&id);
            }
            workers.unregister(&id);
        }).map_err(|error| error.to_string())?;
        Ok(())
    }

    fn follow(&self, connection: &Connection, id: &str, latents: Option<&Path>) -> Result<(), String> {
        let mut after = 0;
        let mut failures = 0;
        loop {
            let events: Vec<WireEvent> = match connection.get(&format!("/v1/jobs/{id}/events?after={after}")) {
                Ok(events) => { failures = 0; events }
                Err(error) => {
                    failures += 1;
                    if failures >= 15 {
                        return Err(format!("Lost the connection to worker {}: {error}", connection.name));
                    }
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
            };
            for event in events {
                after = event.seq;
                if event.kind == "progress" {
                    self.emit("slopfab-progress", event.payload);
                    continue;
                }
                let mut payload = event.payload;
                match payload.get("state").and_then(|state| state.as_str()) {
                    Some("framesReady") => {
                        let evicted = self.collect(connection, id, latents)?;
                        if let Some(job) = evicted.filter(|job| job != id) {
                            payload["detail"] = format!("Frames and audio are ready to be encoded. The frames of {job} were dropped to make room and that scene would have to be rendered again.").into();
                        }
                        self.emit("slopfab-job", payload);
                        return Ok(());
                    }
                    Some("failed") | Some("cancelled") => {
                        self.emit("slopfab-job", payload);
                        connection.release(id);
                        return Ok(());
                    }
                    _ => self.emit("slopfab-job", payload),
                }
            }
        }
    }

    /// Brings a finished job home: latents into the project now, frames on
    /// demand as the webview encodes them.
    fn collect(&self, connection: &Connection, id: &str, latents: Option<&Path>) -> Result<Option<String>, String> {
        if let Some(destination) = latents {
            let mut response = connection.send(connection.request(reqwest::Method::GET, &format!("/v1/jobs/{id}/latents")))?;
            let temporary = destination.with_extension("safetensors.part");
            let copied = File::create(&temporary)
                .and_then(|mut file| io::copy(&mut response, &mut file).and_then(|bytes| file.sync_all().map(|_| bytes)))
                .map_err(|error| format!("Could not save latents from the worker: {error}"));
            match copied {
                Ok(_) => fs::rename(&temporary, destination).map_err(|error| error.to_string())?,
                Err(error) => {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
            }
        }
        let summary: rendered::RenderedSummary = connection.get(&format!("/v1/jobs/{id}/summary"))?;
        let audio: Vec<f32> = connection.bytes(&format!("/v1/jobs/{id}/audio"))?
            .chunks_exact(4).map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap())).collect();
        let values = summary.frame_count as usize * summary.width as usize * summary.height as usize * 3;
        let video = rendered::from_source(
            id,
            Box::new(RemoteFrames { connection: connection.clone(), job_id: id.to_string() }),
            audio,
            summary.frame_count,
            summary.width,
            summary.height,
            3,
            values,
            summary.fps,
            summary.audio_channels,
            summary.audio_sample_rate,
        )?;
        diagnostics::info("workers", "job.collected", "Worker generation is ready to encode.", serde_json::json!({
            "jobId": id, "frames": summary.frame_count, "latents": latents.is_some(),
        }));
        Ok(rendered::keep(video))
    }

    pub(crate) fn status(&self, connection: &Connection, settings: &BTreeMap<String, ProviderSetting>) -> slopfab::SlopfabStatus {
        slopfab::worker_status(settings, &connection.info.runtime, format!("Worker {} ({})", connection.name, connection.address))
    }
}

/// Frames stay on the worker until the encoder asks for them, and the
/// worker's copy is released with this one.
struct RemoteFrames {
    connection: Connection,
    job_id: String,
}

impl rendered::FrameSource for RemoteFrames {
    fn frame_rgba(&self, index: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let frame = self.connection.bytes(&format!("/v1/jobs/{}/frames/{index}", self.job_id))?;
        if frame.len() != width as usize * height as usize * 4 {
            return Err(format!("Worker {} sent an incomplete frame {index}.", self.connection.name));
        }
        Ok(frame)
    }
}

impl Drop for RemoteFrames {
    fn drop(&mut self) {
        let (connection, job_id) = (self.connection.clone(), self.job_id.clone());
        std::thread::spawn(move || connection.release(&job_id));
    }
}

struct Progress {
    inner: File,
    cancel: Arc<AtomicBool>,
    sent: Arc<Mutex<(u64, Instant)>>,
    report: Box<dyn Fn(u64) + Send>,
}

impl Read for Progress {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let count = self.inner.read(buffer)?;
        if let Ok(mut sent) = self.sent.lock() {
            sent.0 += count as u64;
            if sent.1.elapsed() >= Duration::from_millis(250) {
                sent.1 = Instant::now();
                (self.report)(sent.0);
            }
        }
        Ok(count)
    }
}

fn encode_segment(segment: &str) -> String {
    segment.bytes().map(|byte| match byte {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (byte as char).to_string(),
        _ => format!("%{byte:02X}"),
    }).collect()
}

fn transfer_event(request: &GenerationRequest, stage: &str, detail: String, done: u64, total: Option<u64>) -> serde_json::Value {
    serde_json::json!({
        "jobId": request.job_id, "stage": stage, "step": 0, "totalSteps": 0, "plannedSteps": 0,
        "elapsedSeconds": 0.0, "frames": request.frames, "canvasWidth": request.canvas_width,
        "canvasHeight": request.canvas_height, "referenceCount": request.reference_count(),
        "timingProfile": "", "detail": detail, "transferred": done, "transferTotal": total,
    })
}

fn is_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn modified(meta: &fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |time| time.as_nanos())
}

/// Identifies upload content by name, size and modification time, so an
/// unchanged file is sent once and an edited one is sent again.
fn upload_key(name: &str, files: &[(String, u64, u128)]) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    let mut feed = |bytes: &[u8]| for byte in bytes { hash = (hash ^ *byte as u64).wrapping_mul(0x100000001b3); };
    feed(name.as_bytes());
    for (path, bytes, modified) in files {
        feed(path.as_bytes());
        feed(&bytes.to_le_bytes());
        feed(&modified.to_le_bytes());
    }
    format!("{hash:016x}")
}

fn walk(root: &Path, relative: &str, out: &mut Vec<(String, u64, u128)>) -> Result<(), String> {
    let directory = if relative.is_empty() { root.to_path_buf() } else { root.join(relative) };
    let mut entries = fs::read_dir(&directory).map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = if relative.is_empty() { name } else { format!("{relative}/{name}") };
        let meta = entry.metadata().map_err(|error| error.to_string())?;
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else if meta.is_file() {
            out.push((path, meta.len(), modified(&meta)));
        }
        if out.len() > 10_000 {
            return Err(format!("{} has too many files to send to a worker.", root.display()));
        }
    }
    Ok(())
}

fn file_ref(kind: PathKind, value: &str, sources: &mut HashMap<String, PathBuf>) -> Result<FileRef, String> {
    let lora = kind == PathKind::Lora;
    if is_url(value) {
        return Ok(FileRef::Url { url: value.trim().to_string(), lora });
    }
    let path = PathBuf::from(value);
    if kind != PathKind::Input {
        if let Some(url) = weights::recorded_download_url(&path) {
            return Ok(FileRef::Url { url, lora });
        }
    }
    let meta = fs::metadata(&path).map_err(|_| format!("{} was not found on this computer.", path.display()))?;
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    safe_relative_path(&name)?;
    let (directory, files) = if meta.is_dir() {
        if kind != PathKind::Folder {
            return Err(format!("{} is a folder, not a file.", path.display()));
        }
        let mut files = Vec::new();
        walk(&path, "", &mut files)?;
        (true, files)
    } else {
        (false, vec![(name.clone(), meta.len(), modified(&meta))])
    };
    let key = upload_key(&name, &files);
    sources.insert(key.clone(), path);
    Ok(FileRef::Upload {
        key, name, directory, lora,
        entries: files.into_iter().map(|(path, bytes, _)| UploadEntry { path, bytes }).collect(),
    })
}

/// Replaces every path of a resolved local request with a token for the worker.
pub(crate) fn build_job(request: &GenerationRequest, settings: &BTreeMap<String, ProviderSetting>) -> Result<(RemoteJob, HashMap<String, PathBuf>), String> {
    let mut request = request.clone();
    let mut settings: BTreeMap<String, ProviderSetting> = settings.iter()
        .filter(|(name, _)| name.as_str() == "slopfab").map(|(name, value)| (name.clone(), value.clone())).collect();
    let mut files = Vec::new();
    let mut indices: HashMap<String, usize> = HashMap::new();
    let mut sources = HashMap::new();
    let mut add = |kind: PathKind, value: &str, files: &mut Vec<FileRef>| -> Result<usize, String> {
        if let Some(index) = indices.get(value) {
            return Ok(*index);
        }
        files.push(file_ref(kind, value, &mut sources)?);
        indices.insert(value.to_string(), files.len() - 1);
        Ok(files.len() - 1)
    };
    visit_paths(&mut request, &mut settings, |kind, value| {
        *value = file_token(add(kind, value, &mut files)?);
        Ok(())
    })?;
    let continuation = request.continuation_path.take()
        .map(|path| add(PathKind::Input, &path.to_string_lossy(), &mut files)).transpose()?;
    let image_edit_source = request.image_edit_path.take()
        .map(|path| add(PathKind::Input, &path.to_string_lossy(), &mut files)).transpose()?;
    request.save_latents_path = None;
    request.image_edit_pixels = None;
    Ok((RemoteJob { request, settings, files, continuation, image_edit_source }, sources))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::ProviderOption;

    #[test]
    fn addresses_get_the_default_port_and_reject_urls_with_paths() {
        assert_eq!(normalize_address("192.168.1.20").unwrap(), format!("192.168.1.20:{DEFAULT_PORT}"));
        assert_eq!(normalize_address(" http://pc:9000/ ").unwrap(), "pc:9000");
        assert!(normalize_address("pc/v1/info").is_err());
        assert!(normalize_address("").is_err());
    }

    #[test]
    fn jobs_send_urls_for_downloads_and_uploads_for_local_files() {
        let folder = tempfile::tempdir().unwrap();
        let image = folder.path().join("ref one.png");
        fs::write(&image, b"png").unwrap();
        let tokenizer = folder.path().join("tokenizer");
        fs::create_dir_all(tokenizer.join("nested")).unwrap();
        fs::write(tokenizer.join("vocab.json"), b"{}").unwrap();
        fs::write(tokenizer.join("nested/merges.txt"), b"m").unwrap();
        let options = BTreeMap::from([
            ("transformer".to_string(), ProviderOption::String("https://example.com/t.safetensors".into())),
            ("tokenizer".to_string(), ProviderOption::String(tokenizer.to_string_lossy().into_owned())),
            ("attention".to_string(), ProviderOption::String("sage2".into())),
        ]);
        let settings = BTreeMap::from([
            ("slopfab".to_string(), ProviderSetting { enabled: true, model: None, options }),
            ("openrouter".to_string(), ProviderSetting { enabled: true, model: None, options: BTreeMap::from([("apiKey".to_string(), ProviderOption::String("secret".into()))]) }),
        ]);
        let request = GenerationRequest {
            job_id: "work-1".into(),
            reference_paths: vec![image.to_string_lossy().into_owned(), image.to_string_lossy().into_owned()],
            continuation_path: Some(image.clone()),
            ..Default::default()
        };
        let (job, sources) = build_job(&request, &settings).unwrap();
        assert!(!job.settings.contains_key("openrouter"), "credentials never leave this computer");
        assert_eq!(job.files.len(), 3, "a repeated path is sent once");
        assert_eq!(job.files[0], FileRef::Url { url: "https://example.com/t.safetensors".into(), lora: false });
        let FileRef::Upload { directory: true, entries, .. } = &job.files[1] else { panic!("tokenizer folder") };
        assert_eq!(entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>(), vec!["nested/merges.txt", "vocab.json"]);
        assert_eq!(job.request.reference_paths, vec![file_token(2), file_token(2)]);
        assert_eq!(job.continuation, Some(2));
        assert_eq!(sources.len(), 2);
        assert!(build_job(&GenerationRequest { reference_paths: vec![folder.path().join("missing.png").to_string_lossy().into_owned()], ..Default::default() }, &BTreeMap::new()).is_err());
    }
}
