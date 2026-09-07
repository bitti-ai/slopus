import { ArrowLeft, BookOpen, Bot, Download, Film, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GenerationJob, ProjectConfig, ProjectRecord } from "../lib/project";
import { CHECKING_PROVIDERS, executeAgentCommands, type RuntimeStatus, type SlopfabStatus } from "../lib/runtime";
import { purgeTimelineThumbnails } from "../lib/timelineThumbnails";
import { WorkQueue, projectQueueKey } from "../lib/workQueue";
import { AgentDock } from "./workspace/AgentDock";
import { ExportView } from "./workspace/ExportView";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView, type ConfigUpdate } from "./workspace/TimelineView";
import { UnsavedProjectDialog } from "./UnsavedProjectDialog";

export type ProjectView = "timeline" | "generator" | "references" | "agent" | "export";

/** The scene badge includes native generation and the final encoding step. */
export const isGenerationOngoing = (job: GenerationJob) =>
  job.status === "generating" || job.status === "queued" || job.status === "ready";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, initialView = "timeline", runtime = null, onBack, onSave, workQueue, onGeneratorRuntimeChange }: {
  project: ProjectRecord;
  initialView?: ProjectView;
  /** What is installed on this computer, probed once at startup by App. Null
   *  while that probe is still in flight — not "nothing is installed". */
  runtime?: RuntimeStatus | null;
  onBack: () => void;
  onSave: (project: ProjectRecord) => Promise<void>;
  workQueue?: WorkQueue;
  /** Keeps the app-wide probe result aligned when the active generator is
   *  changed directly from the Generator screen. */
  onGeneratorRuntimeChange?: (runtime: SlopfabStatus) => void;
}) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const [localQueue] = useState(() => new WorkQueue((record) => saveRef.current(record)));
  const queue = workQueue ?? localQueue;
  const session = useMemo(() => queue.project(project), [queue, project.folderPath, project.config.id]);
  const { config, saving, dirty, saveError } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [view, setView] = useState<ProjectView>(initialView);
  const [leaving, setLeaving] = useState(false);
  const [savingToLeave, setSavingToLeave] = useState(false);
  const [selectedGenerationJobId, setSelectedGenerationJobId] = useState<string | undefined>(project.config.generationJobs[0]?.id);
  const knownSceneIds = useRef(new Set(project.config.generationJobs.map((job) => job.id)));
  const projectItems = items.filter((item) => item.projectKey === projectQueueKey(project));
  const generationCompletionTimes = Object.fromEntries(projectItems.filter((item) => item.completionAt !== null).map((item) => [item.sceneId, item.completionAt as number]));
  const cancellingJobIds = new Set(projectItems.filter((item) => item.cancelling).map((item) => item.sceneId));
  useEffect(() => workQueue ? undefined : queue.start(), [queue, workQueue]);
  const changeConfig = (next: ConfigUpdate) => session.update(next);
  const recordMeasurement = (update: (current: ProjectConfig) => ProjectConfig) => session.update(update, false);
  const save = () => session.save().catch(() => undefined);
  const leave = async (keepChanges: boolean) => {
    setSavingToLeave(true);
    try {
      if (keepChanges) await session.save();
      else await session.discard();
      onBack();
    } catch { /* The session supplies the save error and keeps the dialog open. */ }
    finally { setSavingToLeave(false); }
  };

  /* Scene removal can come from the Generator or from Slop replacing the
     project document. Keep derived disk caches honest at this shared boundary
     so neither path can leave orphaned thumbnails behind. */
  useEffect(() => {
    const current = new Set(config.generationJobs.map((job) => job.id));
    for (const jobId of knownSceneIds.current) {
      if (!current.has(jobId)) void purgeTimelineThumbnails(project.folderPath, jobId).catch(() => undefined);
    }
    knownSceneIds.current = current;
  }, [config.generationJobs, project.folderPath]);

  return <div className="project-shell">
    {leaving && <UnsavedProjectDialog name={config.name} busy={savingToLeave} error={saveError} onSave={() => void leave(true)} onDiscard={() => void leave(false)} />}
    <header className="project-topbar">
      <div className="project-topbar__lead">
        <button
          className="icon-button icon-button--strong"
          onClick={() => { if (dirty) setLeaving(true); else onBack(); }}
          aria-label="Back to project library"
          title="Back to your projects"
        ><ArrowLeft size={18} /></button>
        {/* The name column is the topbar's elastic column and truncates on narrow
            windows, so the full name stays available on hover. */}
        <div className="project-title"><strong title={config.name}>{config.name}</strong></div>
      </div>

      <nav className="project-nav" aria-label="Project views">
        {([ ["agent", Bot, "Agent"], ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => {
          const running = id === "generator" ? config.generationJobs.filter(isGenerationOngoing).length : 0;
          return <button key={id} type="button" className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
            <Icon size={18} aria-hidden="true" /> {label}
            {running > 0 && <span title={`${running} generation${running === 1 ? "" : "s"} running or queued`}>{running}</span>}
          </button>;
        })}
      </nav>

      <div className="project-topbar__actions">
        {/* A real view now: it renders the timeline through WebCodecs and writes
            an .mp4. It stays honest about what it cannot do inside itself. */}
        <button
          className="secondary-button"
          type="button"
          aria-current={view === "export" ? "page" : undefined}
          onClick={() => setView("export")}
          title="Render the timeline to a video file"
        >
          <Download size={16} aria-hidden="true" /> Export
        </button>
        {/* The standing "All changes saved" pill is gone; the button itself is
            now the only save state there is, so it has to carry it. Off means
            the file on disk already matches what is on screen. */}
        <button className="primary-button" onClick={() => void save()} disabled={saving || !dirty} title={saving ? "Saving…" : dirty ? "Save your changes to this project folder" : "Everything is already saved"}>
          <Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </header>

    <div className={`project-content project-content--${view}`}>
      {view === "timeline" && <TimelineView config={config} folderPath={project.folderPath} generationCompletionTimes={generationCompletionTimes} onChange={changeConfig} onMeasured={recordMeasurement} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
      {view === "generator" && <GeneratorView onGenerate={(submissions) => queue.enqueue(session, submissions)} onCancelGeneration={(ids) => queue.cancelScenes(session, ids)} cancellingJobIds={cancellingJobIds} config={config} folderPath={project.folderPath} generationCompletionTimes={generationCompletionTimes} runtime={runtime?.slopfab ?? null} onRuntimeChange={onGeneratorRuntimeChange} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} />}
      {view === "references" && <ReferencesView config={config} folderPath={project.folderPath} onChange={changeConfig} onRegenerateIcon={(id) => queue.regenerateReferenceIcon(session, id)} pendingIconIds={new Set(config.references.filter((reference) => queue.isReferenceIconPending(session, reference.id)).map((reference) => reference.id))} />}
      {view === "export" && <ExportView config={config} folderPath={project.folderPath} />}
    </div>
    <footer className={`project-agent-row${view === "agent" ? " project-agent-row--page" : ""}`}><AgentDock
      context={view === "timeline" ? "the edit" : view === "generator" ? "this generation queue" : view === "references" ? "project references" : view === "export" ? "this export" : "this project"}
      record={{ ...project, config }}
      providers={runtime?.providers ?? CHECKING_PROVIDERS}
      expanded={view === "agent"}
      onPromptStart={() => setView("agent")}
      /* The provider only proposes typed commands. Apply them to the session's
         latest state—edits can continue while it thinks—then route the result
         through the same ordered save queue as the Save button. */
      onCommands={async (commands) => {
        const next = await executeAgentCommands(session.getSnapshot().config, commands);
        session.update(next);
        await save();
      }}
    /></footer>
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={session.dismissError}>Dismiss</button></div>}
  </div>;
}
