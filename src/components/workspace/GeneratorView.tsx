import { AlertCircle, Ban, Check, ChevronRight, Clock3, Film, LoaderCircle, MoreHorizontal, Play, RefreshCw, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { GenerationJob, ProjectConfig } from "../../lib/project";

export function GeneratorView({ config, onChange, onOpenTimeline }: { config: ProjectConfig; onChange: (next: ProjectConfig) => void; onOpenTimeline: () => void }) {
  const [selectedId, setSelectedId] = useState(config.generationJobs.find((job) => job.status === "generating")?.id ?? config.generationJobs[0]?.id);
  const [prompt, setPrompt] = useState("");
  const jobs = config.generationJobs;
  const selected = jobs.find((job) => job.id === selectedId);
  const active = jobs.filter((job) => job.status === "generating");
  const queued = jobs.filter((job) => job.status === "queued");
  const completed = jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled");
  const boundRefs = useMemo(() => config.references.filter((ref) => selected?.referenceIds.includes(ref.id)), [config.references, selected]);
  const updateJob = (id: string, updates: Partial<GenerationJob>) => onChange({ ...config, generationJobs: jobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  const retry = (job: GenerationJob) => updateJob(job.id, { status: "queued", stage: "queued", progress: 0, error: null, updatedAt: new Date().toISOString() });
  const queueNew = () => {
    const cleanPrompt = prompt.trim() || "Slow cinematic insert that bridges the studio and rooftop scenes.";
    const id = `job-${Date.now()}`;
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id,
      title: cleanPrompt.split(/\s+/).slice(0, 5).join(" "),
      prompt: cleanPrompt,
      status: "queued",
      stage: "queued",
      progress: 0,
      providerId: "minimax-h3",
      creativeBrief: cleanPrompt,
      compiledPrompt: `integrated_multimodal_description: [Shot 1] ${cleanPrompt}\n\noverall_soundscape: Quiet environmental ambience.\n\nnon_diegetic_music: N/A`,
      referenceIds: config.references.slice(0, 2).map((ref) => ref.id),
      createdAt: now,
      updatedAt: now,
    };
    onChange({ ...config, generationJobs: [job, ...jobs] });
    setSelectedId(id);
    setPrompt("");
  };

  return <div className="generator-view">
    <aside className="queue-panel">
      <div className="queue-panel__title"><div><span>GENERATION QUEUE</span><b>{active.length} active · {queued.length} waiting</b></div><button><MoreHorizontal size={16} /></button></div>
      <QueueGroup title="Active" jobs={active} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="Up next" jobs={queued} selectedId={selectedId} onSelect={setSelectedId} />
      <QueueGroup title="History" jobs={completed} selectedId={selectedId} onSelect={setSelectedId} />
      <div className="queue-runtime"><span><i /> Generator ready</span><small>One clip renders at a time</small></div>
    </aside>

    <main className="generator-main">
      <header className="generator-heading"><div><span className="eyebrow">Create shots</span><h1>Generator</h1><p>Turn a scene idea into timeline-ready footage. References and project settings stay attached.</p></div><button className="secondary-button" onClick={onOpenTimeline}><Film size={15} /> View timeline</button></header>
      <section className="generation-composer">
        <div className="generation-composer__top"><Sparkles size={17} /><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the next shot — subject, action, camera movement, light, and sound…" /><button onClick={queueNew}><WandSparkles size={15} /> Add to queue</button></div>
        <div className="generation-settings"><span>H3 VIDEO</span><button>6 seconds <ChevronRight size={12} /></button><button>{config.settings.aspectRatio} <ChevronRight size={12} /></button><button>{config.settings.resolution.toUpperCase()} <ChevronRight size={12} /></button><i /><span>{config.references.length} project references available</span></div>
      </section>

      {selected ? <section className="job-detail">
        <div className="job-detail__visual">
          <div className={`generation-preview generation-preview--${selected.status}`}><span className="generation-preview__flare" /><div className="generation-preview__model"><i /><i /><i /><i /></div>{selected.status === "generating" && <div className="generation-scanner" />}<span className="preview-status">{selected.status === "generating" ? <><LoaderCircle size={14} /> Generating frame 122 / 180</> : selected.status === "completed" ? <><Check size={14} /> Ready for timeline</> : <><Clock3 size={14} /> Waiting in queue</>}</span></div>
          <div className="job-progress-block"><div><b>{selected.status === "generating" ? `${Math.round(selected.progress * 100)}%` : selected.status === "completed" ? "Complete" : selected.status === "failed" ? "Generation failed" : selected.status === "cancelled" ? "Cancelled" : "Queued"}</b><span>{selected.stage === "generating" ? "Synthesizing motion and sound · about 1m 42s remaining" : stageCopy(selected)}</span></div><div className="progress-track"><i style={{ width: `${selected.progress * 100}%` }} /></div><div className="stage-rail">{["Prepare", "Generate", "Encode", "Ready"].map((stage, index) => <span key={stage} className={selected.progress >= index / 3 ? "done" : ""}><i>{selected.progress >= index / 3 ? <Check size={9} /> : index + 1}</i>{stage}</span>)}</div></div>
        </div>
        <aside className="job-detail__info">
          <div className="job-title"><span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span><div><span>{selected.status.toUpperCase()}</span><h2>{selected.title}</h2></div></div>
          <div className="job-prompt"><span>PROMPT</span><p>{selected.prompt}</p></div>
          <div className="job-meta"><label><span>MODEL</span><b>MiniMax H3</b></label><label><span>OUTPUT</span><b>6s · {config.settings.resolution.toUpperCase()}</b></label><label><span>CREATED</span><b>Today, 14:32</b></label><label><span>SEED</span><b>482,091</b></label></div>
          <div className="job-refs"><span>REFERENCES · {boundRefs.length}</span>{boundRefs.map((ref, index) => <div key={ref.id}><i className={`ref-mini ref-mini--${index}`} /> <b>{ref.name}</b><small>{ref.intendedUse.join(", ")}</small></div>)}</div>
          <div className="job-actions">
            {selected.status === "generating" && <button className="danger-button" onClick={() => updateJob(selected.id, { status: "cancelled", stage: "failed" })}><Square size={13} /> Cancel generation</button>}
            {(selected.status === "failed" || selected.status === "cancelled") && <button className="primary-button" onClick={() => retry(selected)}><RefreshCw size={13} /> Retry generation</button>}
            {selected.status === "completed" && <button className="primary-button" onClick={onOpenTimeline}><Play size={13} /> Open in timeline</button>}
            {selected.status === "queued" && <button className="danger-button" onClick={() => updateJob(selected.id, { status: "cancelled", stage: "failed" })}><X size={13} /> Remove from queue</button>}
          </div>
        </aside>
      </section> : <div className="job-empty"><Sparkles size={25} /><h2>Queue your first shot</h2><p>Describe it above and Pol Studio will keep it connected to your edit.</p></div>}
    </main>
  </div>;
}

function QueueGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: GenerationJob[]; selectedId?: string; onSelect: (id: string) => void }) {
  return <section className="queue-group"><h3>{title}<span>{jobs.length}</span></h3>{jobs.map((job) => <button key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => onSelect(job.id)}><span className={`queue-thumb queue-thumb--${job.status}`}>{statusIcon(job.status)}</span><span><b>{job.title}</b><small>{job.status === "generating" ? `${Math.round(job.progress * 100)}% · ${job.stage}` : job.status === "completed" ? "Ready · 6 seconds" : job.status}</small>{job.status === "generating" && <i className="mini-progress"><em style={{ width: `${job.progress * 100}%` }} /></i>}</span><ChevronRight size={13} /></button>)}</section>;
}

const statusIcon = (status: GenerationJob["status"]) => status === "generating" ? <LoaderCircle size={14} /> : status === "completed" ? <Check size={14} /> : status === "failed" ? <AlertCircle size={14} /> : status === "cancelled" ? <Ban size={14} /> : <Clock3 size={14} />;
const stageCopy = (job: GenerationJob) => job.status === "queued" ? "Waiting for the active clip to finish" : job.status === "completed" ? "Encoded and saved to media/generated" : job.error ?? "This job can be retried at any time";
