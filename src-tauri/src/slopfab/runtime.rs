use super::{
    config::Configuration,
    events::{EventSink, NativeEvent},
    ffi,
    generation::run_generation,
    planning::validate_generation_controls,
    references::ReferenceVideos,
    types::*,
};
use crate::{diagnostics, project::ProviderSetting, rendered};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};

#[derive(Clone)]
pub struct SlopfabRuntime {
    pub(super) sender: mpsc::Sender<QueueItem>,
    pub references: ReferenceVideos,
    pub(super) cancellations: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl Default for SlopfabRuntime {
    fn default() -> Self {
        let (sender, receiver) = mpsc::channel::<QueueItem>();
        let cancellations = Arc::new(Mutex::new(HashMap::new()));
        let worker_flags = cancellations.clone();
        thread::Builder::new().name("slopfab-serial-queue".into()).spawn(move || {
            while let Ok(item) = receiver.recv() {
                let started = std::time::Instant::now();
                diagnostics::info("slopfab", "generation.started", "Native generation worker started.", serde_json::json!({
                    "jobId": item.request.job_id,
                    "frames": item.request.frames,
                    "steps": item.request.steps,
                    "canvasWidth": item.request.canvas_width,
                    "canvasHeight": item.request.canvas_height,
                    "referenceCount": item.request.reference_count(),
                    "randomSeed": item.request.seed == -1,
                }));
                let result = run_generation(&item);
                let (state, detail, output) = match result {
                    Ok((metadata, pictures)) => {
                        /* The pictures wait in memory for the webview, which
                           encodes them and asks Rust to write the file. What
                           had to be dropped to make room is said out loud —
                           an abandoned render is a scene that has to be run
                           again, and the user is owed that sentence. */
                        let evicted = rendered::keep(pictures);
                        let detail = match evicted {
                            Some(job) if job != item.request.job_id => format!(
                                "Frames and audio are ready to be encoded. The frames of {job} were dropped to make room and that scene would have to be rendered again."
                            ),
                            _ => "Frames and audio are ready to be encoded.".to_string(),
                        };
                        ("framesReady", detail, Some(metadata))
                    }
                    Err(error) if item.cancel.load(Ordering::Acquire) => ("cancelled", error, None),
                    Err(error) => ("failed", error, None),
                };
                let context = serde_json::json!({
                    "jobId": item.request.job_id,
                    "state": state,
                    "elapsedMs": started.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    "output": output.as_ref().map(|value| serde_json::json!({
                        "frames": value.frames, "width": value.width, "height": value.height,
                        "fps": value.fps, "audioChannels": value.audio_channels,
                        "audioSamples": value.audio_samples,
                        "secondsConditioning": value.seconds_conditioning,
                        "secondsDenoise": value.seconds_denoise,
                        "secondsVideoDecode": value.seconds_video_decode,
                        "secondsAudioDecode": value.seconds_audio_decode,
                        "secondsTotal": value.seconds_total,
                        "stepsComputed": value.steps_computed,
                        "stepsSkipped": value.steps_skipped,
                    })),
                });
                if state == "failed" {
                    diagnostics::error("slopfab", "generation.finished", &detail, context);
                } else if state == "cancelled" {
                    diagnostics::warn("slopfab", "generation.finished", &detail, context);
                } else {
                    diagnostics::info("slopfab", "generation.finished", &detail, context);
                }
                (item.events)(NativeEvent::Job(JobEvent { job_id: item.request.job_id.clone(), state, detail, output }));
                let queue_empty = if let Ok(mut flags) = worker_flags.lock() {
                    flags.remove(&item.request.job_id);
                    flags.is_empty()
                } else {
                    false
                };
                // Reuse is scoped to one contiguous batch. Keeping it while a
                // queued scene exists avoids repeating conditioning and
                // reference preparation; clearing at the drain boundary gives
                // the otherwise multi-gigabyte cache a deterministic lifetime.
                if queue_empty {
                    if let Err(error) = clear_reused_models(&item.configuration) {
                        diagnostics::warn("slopfab", "models.clear_failed", &error, serde_json::json!({}));
                    }
                }
            }
        }).expect("could not start slopfab queue worker");
        Self {
            sender,
            references: ReferenceVideos::default(),
            cancellations,
        }
    }
}

pub(super) fn clear_reused_models(configuration: &Configuration) -> Result<(), String> {
    let api = ffi::Api::load(&configuration.dll_path)?;
    api.version()?;
    api.clear_reused_models()
}

impl SlopfabRuntime {
    pub fn enqueue(
        &self,
        events: EventSink,
        mut request: GenerationRequest,
        settings: &BTreeMap<String, ProviderSetting>,
    ) -> Result<(), String> {
        let configuration = Configuration::from_settings(settings);
        request.steps = configuration.generation_steps(request.steps)?;
        diagnostics::info(
            "slopfab",
            "generation.enqueue_requested",
            "Generation was submitted to the native queue.",
            serde_json::json!({
                "jobId": request.job_id,
                "frames": request.frames,
                "steps": request.steps,
                "canvasWidth": request.canvas_width,
                "canvasHeight": request.canvas_height,
                "referenceCount": request.reference_count(),
                "inputChars": request.prompt.chars().count(),
            }),
        );
        if request.job_id.trim().is_empty() {
            return Err("Generation job id cannot be empty.".into());
        }
        configuration.validate_inputs(&request)?;
        validate_generation_controls(&request)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let mut flags = self
            .cancellations
            .lock()
            .map_err(|_| "Generation queue lock failed.")?;
        if flags.contains_key(&request.job_id) {
            return Err("This generation job is already queued.".into());
        }
        flags.insert(request.job_id.clone(), cancel.clone());
        drop(flags);
        let queued_id = request.job_id.clone();
        events(NativeEvent::Job(JobEvent {
            job_id: queued_id.clone(),
            state: "queued",
            detail: "Queued behind any active slopfab generation.".into(),
            output: None,
        }));
        if self
            .sender
            .send(QueueItem {
                events: events.clone(),
                references: self.references.clone(),
                request,
                configuration,
                cancel,
            })
            .is_err()
        {
            self.cancellations
                .lock()
                .map_err(|_| "Generation queue lock failed.")?
                .remove(&queued_id);
            return Err("Generation queue is unavailable.".into());
        }
        diagnostics::info(
            "slopfab",
            "generation.queued",
            "Generation entered the native queue.",
            serde_json::json!({ "jobId": queued_id }),
        );
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let accepted = self
            .cancellations
            .lock()
            .ok()
            .and_then(|flags| flags.get(job_id).cloned())
            .is_some_and(|flag| {
                flag.store(true, Ordering::Release);
                true
            });
        diagnostics::info(
            "slopfab",
            "generation.cancel_requested",
            if accepted {
                "Cancellation was accepted."
            } else {
                "No queued generation matched the cancellation."
            },
            serde_json::json!({
                "jobId": job_id, "accepted": accepted,
            }),
        );
        accepted
    }
}

pub(super) struct QueueItem {
    pub(super) references: ReferenceVideos,
    pub(super) events: EventSink,
    pub(super) request: GenerationRequest,
    pub(super) configuration: Configuration,
    pub(super) cancel: Arc<AtomicBool>,
}
