import { AlertCircle, Ban, Check, ChevronRight, Clock3, Film, LoaderCircle, MoreHorizontal, Play, RefreshCw, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createDraftGenerationJob, type GenerationJob, type ProjectAsset, type ProjectConfig, type TimelineClip, type TimelineTrack } from "../../lib/project";

interface GeneratorViewProps {
  config: ProjectConfig;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
}

export function GeneratorView({ config, onChange, onOpenTimeline, selectedJobId }: GeneratorViewProps) {
  const [selectedId, setSelectedId] = useState(selectedJobId ?? config.generationJobs.find((job) => job.status === "generating")?.id ?? config.generationJobs[0]?.id);
  const [prompt, setPrompt] = useState("");
  const jobs = config.generationJobs;
  const selected = jobs.find((job) => job.id === selectedId);
  const active = jobs.filter((job) => job.status === "generating");
  const queued = jobs.filter((job) => job.status === "queued");
  const drafts = jobs.filter((job) => job.status === "draft");
  const completed = jobs.filter((job) => ["ready", "completed", "failed", "cancelled"].includes(job.status));
  const boundRefs = useMemo(() => config.references.filter((ref) => selected?.referenceIds.includes(ref.id)), [config.references, selected]);

  useEffect(() => {
    if (selectedJobId) setSelectedId(selectedJobId);
  }, [selectedJobId]);

  const updateJob = (id: string, updates: Partial<GenerationJob>) => onChange({ ...config, generationJobs: jobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  const prepareRetry = (job: GenerationJob) => updateJob(job.id, { status: "draft", stage: "queued", progress: 0, error: null, updatedAt: new Date().toISOString() });
  const saveDraft = () => {
    const cleanPrompt = prompt.trim() || `A new scene for ${config.name}.`;
    const job = createDraftGenerationJob(cleanPrompt, { referenceIds: config.references.slice(0, 2).map((ref) => ref.id) });
    onChange({ ...config, generationJobs: [job, ...jobs] });
    setSelectedId(job.id);
    setPrompt("");
  };

  const insertIntoStory = (job: GenerationJob) => {
    if (!job.outputRelativePath) return;
    const now = new Date().toISOString();
    const existingAsset = config.assets.find((asset) => asset.relativePath === job.outputRelativePath);
    const asset: ProjectAsset = existingAsset ?? {
      id: `asset-${crypto.randomUUID()}`,
      kind: "generated",
      name: job.title,
      relativePath: job.outputRelativePath,
      mimeType: "video/mp4",
      durationMs: 6_000,
      createdAt: now,
    };
    const existingStory = config.timeline.tracks.find((track) => track.name === "Story");
    const story: TimelineTrack = existingStory ?? { id: `track-${crypto.randomUUID()}`, kind: "video", name: "Story", locked: false, muted: false, clips: [] };
    if (story.locked) return;
    const startMs = story.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    const clip: TimelineClip = {
      id: `clip-${crypto.randomUUID()}`,
      assetId: asset.id,
      trackId: story.id,
      startMs,
      durationMs: asset.durationMs ?? 6_000,
      sourceStartMs: 0,
      label: job.title,
      color: "#4f6ba8",
      status: "generated",
    };
    const tracks = existingStory
      ? config.timeline.tracks.map((track) => track.id === story.id ? { ...track, clips: [...track.clips, clip] } : track)
      : [{ ...story, clips: [clip] }, ...config.timeline.tracks];
    onChange({
      ...config,
      assets: existingAsset ? config.assets : [...config.assets, asset],
      timeline: { tracks },
      generationJobs: jobs.map((item) => item.id === job.id ? { ...item, clipId: clip.id, updatedAt: now } : item),
    });
    onOpenTimeline();
  };

  return <div className="generator-view">
    <aside className="queue-panel">
      <div className="queue-panel__title"><div><span>GENERATION QUEUE</span><b>{active.length} active · {queued.length} waiting</b></div><button><MoreHorizontal size={16} /></button></div>
      <QueueGroup title="Active" jobs={active} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="Up next" jobs={queued} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="Drafts" jobs={drafts} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="History" jobs={completed} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="queue-runtime queue-runtime--unavailable"><span><i /> Generation runtime unavailable</span><small>Drafts are safe to edit and retry when a runtime is connected.</small></div>
    </aside>

    <main className="generator-main">
      <header className="generator-heading"><div><span className="eyebrow">Create shots</span><h1>Generator</h1><p>Turn a scene idea into timeline-ready footage. References and project settings stay attached.</p></div><button className="secondary-button" onClick={onOpenTimeline}><Film size={15} /> View timeline</button></header>
      <section className="generation-composer">
        <div className="generation-composer__top"><Sparkles size={17} /><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the next shot — subject, action, camera movement, light, and sound…" /><button onClick={saveDraft}><WandSparkles size={15} /> Save draft</button></div>
        <div className="generation-settings"><span>H3 VIDEO</span><button>6 seconds <ChevronRight size={12} /></button><button>{config.settings.aspectRatio} <ChevronRight size={12} /></button><button>{config.settings.resolution.toUpperCase()} <ChevronRight size={12} /></button><i /><span>{config.references.length} project references available</span></div>
      </section>

      {selected ? <section className="job-detail">
        <div className="job-detail__visual">
          <div className={`generation-preview generation-preview--${selected.status}`}><span className="generation-preview__flare" /><div className="generation-preview__model"><i /><i /><i /><i /></div>{selected.status === "generating" && <div className="generation-scanner" />}<span className="preview-status">{previewStatus(selected)}</span></div>
          <div className="job-progress-block"><div><b>{progressTitle(selected)}</b><span>{selected.stage === "generating" ? "Synthesizing motion and sound" : stageCopy(selected)}</span></div><div className="progress-track"><i style={{ width: `${selected.progress * 100}%` }} /></div><div className="stage-rail">{["Prepare", "Generate", "Encode", "Ready"].map((stage, index) => <span key={stage} className={selected.progress > 0 && selected.progress >= index / 3 ? "done" : ""}><i>{selected.progress > 0 && selected.progress >= index / 3 ? <Check size={9} /> : index + 1}</i>{stage}</span>)}</div></div>
        </div>
        <aside className="job-detail__info">
          <div className="job-title"><span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span><div><span>{selected.status.toUpperCase()}</span><h2>{selected.title}</h2></div></div>
          <div className="job-prompt"><span>CREATIVE BRIEF</span><p>{selected.creativeBrief}</p></div>
          <div className="job-meta"><label><span>MODEL</span><b>MiniMax H3</b></label><label><span>OUTPUT</span><b>{selected.outputRelativePath ?? "Not generated"}</b></label><label><span>CREATED</span><b>{new Date(selected.createdAt).toLocaleDateString()}</b></label><label><span>STATUS</span><b>{selected.status}</b></label></div>
          <div className="job-refs"><span>REFERENCES · {boundRefs.length}</span>{boundRefs.map((ref, index) => <div key={ref.id}><i className={`ref-mini ref-mini--${index}`} /> <b>{ref.name}</b><small>{ref.intendedUse.join(", ")}</small></div>)}</div>
          <div className="job-actions">
            {selected.status === "generating" && <button className="danger-button" onClick={() => updateJob(selected.id, { status: "cancelled", stage: "failed", updatedAt: new Date().toISOString() })}><Square size={13} /> Cancel generation</button>}
            {(selected.status === "failed" || selected.status === "cancelled") && <button className="primary-button" onClick={() => prepareRetry(selected)}><RefreshCw size={13} /> Prepare retry</button>}
            {selected.status === "draft" && <button className="primary-button" disabled><WandSparkles size={13} /> Runtime unavailable — draft saved</button>}
            {selected.status === "completed" && selected.outputRelativePath && !selected.clipId && <button className="primary-button" onClick={() => insertIntoStory(selected)}><Play size={13} /> Insert into Story</button>}
            {selected.status === "completed" && selected.clipId && <button className="primary-button" onClick={onOpenTimeline}><Play size={13} /> Open in timeline</button>}
            {selected.status === "completed" && !selected.outputRelativePath && <button className="primary-button" disabled>Output unavailable</button>}
            {selected.status === "queued" && <button className="danger-button" onClick={() => updateJob(selected.id, { status: "cancelled", stage: "failed", updatedAt: new Date().toISOString() })}><X size={13} /> Remove from queue</button>}
          </div>
        </aside>
      </section> : <div className="job-empty"><Sparkles size={25} /><h2>Draft your first shot</h2><p>Describe it above and Pol Studio will keep it connected to your edit.</p></div>}
    </main>
  </div>;
}

function QueueGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: GenerationJob[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <section className="queue-group"><h3>{title}<span>{jobs.length}</span></h3>{jobs.map((job) => <button key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => onSelect(job.id)}><span className={`queue-thumb queue-thumb--${job.status}`}>{statusIcon(job.status)}</span><span><b>{job.title}</b><small>{job.status === "generating" ? `${Math.round(job.progress * 100)}% · ${job.stage}` : job.status === "completed" ? job.outputRelativePath ? "Ready · 6 seconds" : "Output unavailable" : job.status}</small>{job.status === "generating" && <i className="mini-progress"><em style={{ width: `${job.progress * 100}%` }} /></i>}</span><ChevronRight size={13} /></button>)}</section>;
}

const statusIcon = (status: GenerationJob["status"]) => status === "generating" ? <LoaderCircle size={14} /> : status === "completed" ? <Check size={14} /> : status === "failed" ? <AlertCircle size={14} /> : status === "cancelled" ? <Ban size={14} /> : <Clock3 size={14} />;
const progressTitle = (job: GenerationJob) => job.status === "generating" ? `${Math.round(job.progress * 100)}%` : job.status === "completed" ? "Complete" : job.status === "failed" ? "Generation failed" : job.status === "cancelled" ? "Cancelled" : job.status === "draft" ? "Draft" : "Queued";
const stageCopy = (job: GenerationJob) => job.status === "draft" ? "Draft saved — connect a generation runtime to render" : job.status === "queued" ? "Waiting for the active clip to finish" : job.status === "completed" ? job.outputRelativePath ? "Encoded and saved to media/generated" : "Completed without a saved output" : job.error ?? "This job can be retried at any time";
const previewStatus = (job: GenerationJob) => job.status === "generating" ? <><LoaderCircle size={14} /> Generating frame 122 / 180</> : job.status === "completed" && job.outputRelativePath ? <><Check size={14} /> Ready for timeline</> : job.status === "completed" ? <><AlertCircle size={14} /> Output unavailable</> : job.status === "cancelled" ? <><Ban size={14} /> Generation cancelled</> : job.status === "failed" ? <><AlertCircle size={14} /> Generation failed</> : job.status === "draft" ? <><Clock3 size={14} /> Draft saved — runtime unavailable</> : <><Clock3 size={14} /> Waiting in queue</>;
