import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Ban, Check, ChevronRight, Clock3, Film, LoaderCircle, MoreHorizontal, Play, RefreshCw, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../../lib/persistence";
import { createDraftGenerationJob, type GenerationJob, type ProjectAsset, type ProjectConfig, type TimelineClip, type TimelineTrack } from "../../lib/project";
import { cancelVidfabGeneration, enqueueVidfabGeneration, resolveVidfabPlan, type VidfabGenerationRequest, type VidfabStatus } from "../../lib/runtime";

interface GeneratorViewProps {
  config: ProjectConfig;
  runtime?: VidfabStatus | null;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
}

export function GeneratorView({ config, runtime = null, onChange, onOpenTimeline, selectedJobId }: GeneratorViewProps) {
  const [selectedId, setSelectedId] = useState(selectedJobId ?? config.generationJobs.find((job) => job.status === "generating")?.id ?? config.generationJobs[0]?.id);
  const [prompt, setPrompt] = useState("");
  const [planNotes, setPlanNotes] = useState<Record<string, string>>({});
  const configRef = useRef(config);
  configRef.current = config;
  const jobs = config.generationJobs;
  const selected = jobs.find((job) => job.id === selectedId);
  const active = jobs.filter((job) => job.status === "generating");
  const queued = jobs.filter((job) => job.status === "queued");
  const drafts = jobs.filter((job) => job.status === "draft");
  const completed = jobs.filter((job) => ["ready", "completed", "failed", "cancelled"].includes(job.status));
  const boundRefs = useMemo(() => config.references.filter((ref) => selected?.referenceIds.includes(ref.id)), [config.references, selected]);
  const runtimeReady = runtime?.state === "ready";

  useEffect(() => { if (selectedJobId) setSelectedId(selectedJobId); }, [selectedJobId]);

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    const current = configRef.current;
    onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  };
  const requestFor = (job: GenerationJob): VidfabGenerationRequest => ({
    jobId: job.id,
    prompt: job.compiledPrompt,
    frames: Math.round(6 * config.settings.frameRate),
    steps: 50,
    seed: 482091,
    aspectRatio: config.settings.aspectRatio,
    referencePaths: [],
  });

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscriptions = Promise.all([
      listen<{ jobId: string; stage: string; step: number; totalSteps: number }>("vidfab-progress", ({ payload }) => {
        if (disposed) return;
        const progress = payload.totalSteps > 0 ? Math.min(.92, .12 + Math.max(0, payload.step) / payload.totalSteps * .72) : payload.stage === "delivering" ? .95 : .08;
        updateJob(payload.jobId, { status: "generating", stage: payload.stage === "starting" || payload.stage === "transformerLoad" ? "preparing" : "generating", progress, updatedAt: new Date().toISOString() });
      }),
      listen<{ jobId: string; state: string; detail: string }>("vidfab-job", ({ payload }) => {
        if (disposed) return;
        const updates: Partial<GenerationJob> = payload.state === "framesReady"
          ? { status: "ready", stage: "completed", progress: 1, error: payload.detail }
          : payload.state === "failed" ? { status: "failed", stage: "failed", error: payload.detail }
          : payload.state === "cancelled" ? { status: "cancelled", stage: "failed", error: payload.detail }
          : { status: "queued", stage: "queued" };
        updateJob(payload.jobId, { ...updates, updatedAt: new Date().toISOString() });
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop())); };
    // configRef keeps handlers current without resubscribing per progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);

  const prepareOrRetry = async (job: GenerationJob) => {
    const now = new Date().toISOString();
    updateJob(job.id, { status: runtimeReady ? "queued" : "draft", stage: "queued", progress: 0, error: runtimeReady ? null : runtime?.detail ?? "Runtime unavailable.", updatedAt: now });
    if (runtimeReady) await enqueueVidfabGeneration(requestFor(job), configRef.current);
  };

  const createJob = async () => {
    const cleanPrompt = prompt.trim() || `A new scene for ${config.name}.`;
    const draft = createDraftGenerationJob(cleanPrompt, { referenceIds: config.references.slice(0, 2).map((ref) => ref.id) });
    const job: GenerationJob = runtimeReady ? { ...draft, status: "queued" } : draft;
    const next = { ...config, generationJobs: [job, ...jobs] };
    onChange(next);
    setSelectedId(job.id);
    setPrompt("");
    try {
      const request = requestFor(job);
      const plan = await resolveVidfabPlan(request, next);
      setPlanNotes((current) => ({ ...current, [job.id]: `${plan.alignedFrames} frames · ${plan.canvasWidth}×${plan.canvasHeight}. ${plan.boundary}` }));
      if (runtimeReady) await enqueueVidfabGeneration(request, next);
      else updateJob(job.id, { error: runtime?.detail ?? "Generator runtime is unavailable; the editable draft remains saved." });
    } catch (reason) {
      updateJob(job.id, { error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const startDraft = async (job: GenerationJob) => {
    if (!runtimeReady) return;
    updateJob(job.id, { status: "queued", stage: "queued", error: null, updatedAt: new Date().toISOString() });
    await enqueueVidfabGeneration(requestFor(job), configRef.current);
  };

  const insertIntoStory = (job: GenerationJob) => {
    if (!job.outputRelativePath) return;
    const now = new Date().toISOString();
    const existingAsset = config.assets.find((asset) => asset.relativePath === job.outputRelativePath);
    const asset: ProjectAsset = existingAsset ?? { id: `asset-${crypto.randomUUID()}`, kind: "generated", name: job.title, relativePath: job.outputRelativePath, mimeType: "video/mp4", durationMs: 6_000, createdAt: now };
    const existingStory = config.timeline.tracks.find((track) => track.name === "Story");
    const story: TimelineTrack = existingStory ?? { id: `track-${crypto.randomUUID()}`, kind: "video", name: "Story", locked: false, muted: false, clips: [] };
    if (story.locked) return;
    const startMs = story.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    const clip: TimelineClip = { id: `clip-${crypto.randomUUID()}`, assetId: asset.id, trackId: story.id, startMs, durationMs: asset.durationMs ?? 6_000, sourceStartMs: 0, label: job.title, color: "#4f6ba8", status: "generated" };
    const tracks = existingStory ? config.timeline.tracks.map((track) => track.id === story.id ? { ...track, clips: [...track.clips, clip] } : track) : [{ ...story, clips: [clip] }, ...config.timeline.tracks];
    onChange({ ...config, assets: existingAsset ? config.assets : [...config.assets, asset], timeline: { tracks }, generationJobs: jobs.map((item) => item.id === job.id ? { ...item, clipId: clip.id, updatedAt: now } : item) });
    onOpenTimeline();
  };

  const cancelJob = (job: GenerationJob) => {
    if (job.status === "generating" || job.status === "queued") void cancelVidfabGeneration(job.id);
    updateJob(job.id, { status: "cancelled", stage: "failed", updatedAt: new Date().toISOString() });
  };

  return <div className="generator-view">
    <aside className="queue-panel">
      <div className="queue-panel__title"><div><span>GENERATION QUEUE</span><b>{active.length} active · {queued.length} waiting</b></div><button><MoreHorizontal size={16} /></button></div>
      <QueueGroup title="Active" jobs={active} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="Up next" jobs={queued} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="Drafts" jobs={drafts} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="History" jobs={completed} selectedId={selectedId} onSelect={setSelectedId} />
      <div className={`queue-runtime queue-runtime--${runtime?.state ?? "checking"}`} title={runtime?.detail}><span><i /> {runtimeLabel(runtime)}</span><small>{runtimeReady ? "One raw-buffer job at a time" : "Generation runtime unavailable"}</small></div>
    </aside>

    <main className="generator-main">
      <header className="generator-heading"><div><span className="eyebrow">Create shots</span><h1>Generator</h1><p>Turn a scene idea into an editable plan. Runtime availability is reported before costly generation.</p></div><button className="secondary-button" onClick={onOpenTimeline}><Film size={15} /> View timeline</button></header>
      <section className="generation-composer">
        <div className="generation-composer__top"><Sparkles size={17} /><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the next shot — subject, action, camera movement, light, and sound…" /><button onClick={() => void createJob()}><WandSparkles size={15} /> {runtimeReady ? "Add to queue" : "Save draft"}</button></div>
        <div className="generation-settings"><span>H3 VIDEO</span><button>6 seconds <ChevronRight size={12} /></button><button>{config.settings.aspectRatio} <ChevronRight size={12} /></button><button>{config.settings.resolution.toUpperCase()} <ChevronRight size={12} /></button><i /><span>{config.references.length} project references available</span></div>
      </section>

      {selected ? <section className="job-detail">
        <div className="job-detail__visual">
          <div className={`generation-preview generation-preview--${selected.status}`}><span className="generation-preview__flare" /><div className="generation-preview__model"><i /><i /><i /><i /></div>{selected.status === "generating" && <div className="generation-scanner" />}<span className="preview-status">{previewStatus(selected)}</span></div>
          <div className="job-progress-block"><div><b>{progressTitle(selected)}</b><span>{selected.stage === "generating" ? "vidfab is synthesizing raw motion and sound" : stageCopy(selected)}</span></div><div className="progress-track"><i style={{ width: `${selected.progress * 100}%` }} /></div><div className="stage-rail">{["Prepare", "Generate", "Deliver", "Encode later"].map((stage, index) => <span key={stage} className={selected.progress > 0 && selected.progress >= index / 3 ? "done" : ""}><i>{selected.progress > 0 && selected.progress >= index / 3 ? <Check size={9} /> : index + 1}</i>{stage}</span>)}</div></div>
        </div>
        <aside className="job-detail__info">
          <div className="job-title"><span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span><div><span>{selected.status.toUpperCase()}</span><h2>{selected.title}</h2></div></div>
          <div className="job-prompt"><span>CREATIVE BRIEF</span><p>{selected.creativeBrief}</p></div>
          {(planNotes[selected.id] || selected.error) && <div className="job-runtime-note"><span>RUNTIME BOUNDARY</span><p>{planNotes[selected.id] ?? selected.error}</p></div>}
          <div className="job-meta"><label><span>MODEL</span><b>MiniMax H3</b></label><label><span>DELIVERY</span><b>{selected.outputRelativePath ?? "Raw buffers"}</b></label><label><span>CONTAINER</span><b>{selected.outputRelativePath ? "Project asset" : "Not encoded"}</b></label><label><span>STATUS</span><b>{selected.status}</b></label></div>
          <div className="job-refs"><span>REFERENCES · {boundRefs.length}</span>{boundRefs.map((ref, index) => <div key={ref.id}><i className={`ref-mini ref-mini--${index}`} /> <b>{ref.name}</b><small>{ref.intendedUse.join(", ")}</small></div>)}</div>
          <div className="job-actions">
            {selected.status === "generating" && <button className="danger-button" onClick={() => cancelJob(selected)}><Square size={13} /> Cancel generation</button>}
            {(selected.status === "failed" || selected.status === "cancelled") && <button className="primary-button" onClick={() => void prepareOrRetry(selected)}><RefreshCw size={13} /> {runtimeReady ? "Retry generation" : "Prepare retry"}</button>}
            {selected.status === "draft" && <button className="primary-button" disabled={!runtimeReady} onClick={() => void startDraft(selected)}><WandSparkles size={13} /> {runtimeReady ? "Generate with vidfab" : "Runtime unavailable — draft saved"}</button>}
            {selected.status === "ready" && <button className="primary-button" disabled>Raw frames ready — encoding not implemented</button>}
            {selected.status === "completed" && selected.outputRelativePath && !selected.clipId && <button className="primary-button" onClick={() => insertIntoStory(selected)}><Play size={13} /> Insert into Story</button>}
            {selected.status === "completed" && selected.clipId && <button className="primary-button" onClick={onOpenTimeline}><Play size={13} /> Open in timeline</button>}
            {selected.status === "completed" && !selected.outputRelativePath && <button className="primary-button" disabled>Output unavailable</button>}
            {selected.status === "queued" && <button className="danger-button" onClick={() => cancelJob(selected)}><X size={13} /> Remove from queue</button>}
          </div>
        </aside>
      </section> : <div className="job-empty"><Sparkles size={25} /><h2>Draft your first shot</h2><p>Describe it above and Pol Studio will keep it connected to your edit.</p></div>}
    </main>
  </div>;
}

function QueueGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: GenerationJob[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <section className="queue-group"><h3>{title}<span>{jobs.length}</span></h3>{jobs.map((job) => <button key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => onSelect(job.id)}><span className={`queue-thumb queue-thumb--${job.status}`}>{statusIcon(job.status)}</span><span><b>{job.title}</b><small>{job.status === "generating" ? `${Math.round(job.progress * 100)}% · ${job.stage}` : job.status === "completed" ? job.outputRelativePath ? "Project asset · 6 seconds" : "Output unavailable" : job.status === "ready" ? "Raw buffers · encoding pending" : job.status}</small>{job.status === "generating" && <i className="mini-progress"><em style={{ width: `${job.progress * 100}%` }} /></i>}</span><ChevronRight size={13} /></button>)}</section>;
}

const statusIcon = (status: GenerationJob["status"]) => status === "generating" ? <LoaderCircle size={14} /> : status === "completed" || status === "ready" ? <Check size={14} /> : status === "failed" ? <AlertCircle size={14} /> : status === "cancelled" ? <Ban size={14} /> : <Clock3 size={14} />;
const progressTitle = (job: GenerationJob) => job.status === "generating" ? `${Math.round(job.progress * 100)}%` : job.status === "ready" ? "Frames ready" : job.status === "completed" ? "Complete" : job.status === "failed" ? "Generation failed" : job.status === "cancelled" ? "Cancelled" : job.status === "draft" ? "Draft" : "Queued";
const stageCopy = (job: GenerationJob) => job.status === "draft" ? "Draft saved — connect a compatible runtime to render" : job.status === "queued" ? "Waiting for the active vidfab job" : job.status === "ready" ? "Raw frames delivered; host encoding is not implemented" : job.status === "completed" ? job.outputRelativePath ? "Encoded project asset" : "Completed without a saved output" : job.error ?? "This job can be retried when the runtime is ready";
const previewStatus = (job: GenerationJob) => job.status === "generating" ? <><LoaderCircle size={14} /> vidfab · {Math.round(job.progress * 100)}%</> : job.status === "ready" ? <><Check size={14} /> Raw frames ready</> : job.status === "completed" && job.outputRelativePath ? <><Check size={14} /> Ready for timeline</> : job.status === "completed" ? <><AlertCircle size={14} /> Output unavailable</> : job.status === "cancelled" ? <><Ban size={14} /> Generation cancelled</> : job.status === "failed" ? <><AlertCircle size={14} /> Generation failed</> : job.status === "draft" ? <><Clock3 size={14} /> Draft saved — runtime unavailable</> : <><Clock3 size={14} /> Waiting in queue</>;
const runtimeLabel = (runtime: VidfabStatus | null) => !runtime ? "Checking generator…" : runtime.state === "ready" ? "vidfab ready" : runtime.state === "modelsMissing" ? "Models not configured" : runtime.state === "demo" ? "Browser demo" : runtime.state === "incompatible" ? "Incompatible vidfab" : "vidfab unavailable";
