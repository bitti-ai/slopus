import { ArrowLeft, BookOpen, Bot, Download, Film, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "../lib/diagnostics";
import type { GenerationJob, ProjectConfig, ProjectRecord } from "../lib/project";
import { cancelVidfabGeneration, CHECKING_PROVIDERS, executeAgentCommands, type RuntimeStatus, type VidfabStatus } from "../lib/runtime";
import { purgeTimelineThumbnails } from "../lib/timelineThumbnails";
import { ExitGuardDialog, type OngoingGeneration } from "./ExitGuardDialog";
import { AgentDock } from "./workspace/AgentDock";
import { ExportView } from "./workspace/ExportView";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView, type ConfigUpdate } from "./workspace/TimelineView";
import { useGenerationEvents } from "./workspace/useGenerationEvents";

export type ProjectView = "timeline" | "generator" | "references" | "agent" | "export";

/** A generation the app is still working on: waiting for the engine, being
 *  rendered by it, or — `ready` — rendered and being encoded into the file that
 *  will land in the project folder.
 *
 *  That last one belongs here for the same reason as the other two: until the
 *  .mp4 is written there is nothing on disk, and closing the window in the
 *  seconds it takes to encode throws away the whole render. The topbar count
 *  and the exit guard both read this one predicate, so a badge saying "2" and a
 *  warning about what leaving costs can never disagree. */
export const isGenerationOngoing = (job: GenerationJob) =>
  job.status === "generating" || job.status === "queued" || job.status === "ready";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, initialView = "timeline", runtime = null, onBack, onSave, onOngoingGenerationsChange, onGeneratorRuntimeChange }: {
  project: ProjectRecord;
  initialView?: ProjectView;
  /** What is installed on this computer, probed once at startup by App. Null
   *  while that probe is still in flight — not "nothing is installed". */
  runtime?: RuntimeStatus | null;
  onBack: () => void;
  onSave: (project: ProjectRecord) => Promise<void>;
  /** Told what is still generating whenever that changes, and told nothing is
   *  the moment this screen goes away. App needs it for the window's close
   *  button: the jobs live in this component's config, which the library never
   *  sees. Optional, so a test can mount the workspace on its own. */
  onOngoingGenerationsChange?: (jobs: OngoingGeneration[]) => void;
  /** Keeps the app-wide probe result aligned when the active generator is
   *  changed directly from the Generator screen. */
  onGeneratorRuntimeChange?: (runtime: VidfabStatus) => void;
}) {
  const [config, setConfigState] = useState(project.config);
  const configRef = useRef(config);
  configRef.current = config;
  const [view, setView] = useState<ProjectView>(initialView);
  const [selectedGenerationJobId, setSelectedGenerationJobId] = useState<string | undefined>(project.config.generationJobs[0]?.id);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leaveGuard, setLeaveGuard] = useState(false);
  const [generationCompletionTimes, setGenerationCompletionTimes] = useState<Readonly<Record<string, number>>>({});
  /** Every save is ordered. Without this, an older manual save and a generation
   *  completion save could race and whichever disk write happened to finish
   *  last would win, even if it held the older project. */
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  // Measurements also replace the config object, but deliberately do not make
  // the project dirty. A revision counts only writes that the Save button is
  // responsible for, so a measurement landing during a save cannot make a
  // successfully persisted project look unsaved.
  const dirtyRevision = useRef(0);
  const knownSceneIds = useRef(new Set(project.config.generationJobs.map((job) => job.id)));

  const applyConfig = (next: ConfigUpdate): ProjectConfig => {
    const resolved = typeof next === "function" ? next(configRef.current) : next;
    configRef.current = resolved;
    setConfigState(resolved);
    return resolved;
  };

  const persist = (record: ProjectRecord): Promise<void> => {
    const savedRevision = dirtyRevision.current;
    pendingSaves.current += 1;
    setSaving(true);
    const attempt = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        setSaveError(null);
        await onSave(record);
      });
    saveQueue.current = attempt.then(() => undefined, () => undefined);
    return attempt
      .then(() => {
        // A later edit did not ride in this write, so its Save button must stay
        // enabled. Background measurements do not advance this revision.
        if (dirtyRevision.current === savedRevision) setDirty(false);
      })
      .catch((reason) => {
        const detail = describeDiagnosticError(reason);
        writeDiagnostic("error", "workspace", "project.save_failed", detail, { projectId: configRef.current.id, ...errorContext(reason) });
        setSaveError(detail);
      })
      .finally(() => {
        pendingSaves.current -= 1;
        if (pendingSaves.current === 0) setSaving(false);
      });
  };

  /* What the engine says about a render, and the saving of the file it
     produces. Mounted HERE, not in the Generator: a render takes minutes, and
     a user who spends them on the timeline used to unmount the only listeners
     there were — the finished frames then arrived at nobody and were dropped. */
  useGenerationEvents({
    folderPath: project.folderPath,
    onChange: (update) => { applyConfig(update); dirtyRevision.current += 1; setDirty(true); },
    onCompleted: () => { void persist({ ...project, config: configRef.current }); },
    onEstimate: (jobId, completionAt) => setGenerationCompletionTimes((current) => {
      if (completionAt === null) {
        if (!(jobId in current)) return current;
        const next = { ...current };
        delete next[jobId];
        return next;
      }
      if (current[jobId] === completionAt) return current;
      return { ...current, [jobId]: completionAt };
    }),
  });

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

  /* Derived through a key of identity and status rather than from the job
     objects: a render in progress rewrites generationJobs on every progress
     tick, and a list rebuilt from that would push a new array at App several
     times a second for a change nobody can see. */
  const ongoingKey = config.generationJobs.filter(isGenerationOngoing).map((job) => `${job.id} · ${job.status} · ${job.title}`).join(" | ");
  const ongoing = useMemo<OngoingGeneration[]>(
    () => config.generationJobs.filter(isGenerationOngoing).map((job) => ({ id: job.id, title: job.title, running: job.status === "generating" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ongoingKey],
  );
  useEffect(() => { onOngoingGenerationsChange?.(ongoing); }, [ongoing, onOngoingGenerationsChange]);
  /* Leaving this screen leaves nothing generating as far as the window's close
     button is concerned: whatever the engine is still doing, its events land in
     the Generator, which unmounts with everything else here. */
  useEffect(() => () => onOngoingGenerationsChange?.([]), [onOngoingGenerationsChange]);

  /* The question stops being worth asking if the last run finishes while it is
     on screen. Close it rather than navigate: the user never answered it, and
     leaving on their behalf is not an answer. */
  useEffect(() => { if (ongoing.length === 0) setLeaveGuard(false); }, [ongoing.length]);

  const leave = () => {
    /* Nothing resumes, and a render that finishes after this screen is gone has
       nowhere to be recorded: the listeners that save it (useGenerationEvents)
       belong to this component and go with it. Rather than burn the GPU for a
       result no one will keep, the runs are stopped the same way their own stop
       button stops them. */
    ongoing.forEach((job) => { void cancelVidfabGeneration(job.id).catch(() => undefined); });
    onBack();
  };

  /* Takes an updater as well as a value, because a write built from something
     asynchronous cannot safely name the config it starts from — see
     TimelineView's measurement flush. Views that only ever change the project
     from a click still pass a plain value. */
  const changeConfig = (next: ConfigUpdate) => {
    applyConfig(next);
    dirtyRevision.current += 1;
    setDirty(true);
  };

  /* A file's length and size, read off the file by the media panel's decode.
     It is new information and the project keeps it — the next save writes it —
     but the user edited nothing by opening a panel, so it must not turn Save
     on. That button is the app's whole claim about what is and is not on disk,
     and "you have unsaved changes" was false: there was nothing the user could
     lose. Everything measured here is re-derivable from the files themselves,
     so a measurement that never rides along with a real save costs a re-decode
     and nothing else. */
  const recordMeasurement = (update: (current: ProjectConfig) => ProjectConfig) => { applyConfig(update); };

  const save = async (record?: ProjectRecord) => {
    await persist(record ?? { ...project, config: configRef.current });
  };

  return <div className="project-shell">
    <header className="project-topbar">
      <div className="project-topbar__lead">
        <button
          className="icon-button icon-button--strong"
          onClick={() => (ongoing.length > 0 ? setLeaveGuard(true) : onBack())}
          aria-label="Back to project library"
          title={ongoing.length > 0 ? "Back to your projects — asks first, because leaving stops what is generating" : "Back to your projects"}
        ><ArrowLeft size={18} /></button>
        {/* The name column is the topbar's elastic column and truncates on narrow
            windows, so the full name stays available on hover. */}
        <div className="project-title"><strong title={config.name}>{config.name}</strong></div>
      </div>

      <nav className="project-nav" aria-label="Project views">
        {([ ["agent", Bot, "Agent"], ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => {
          const running = id === "generator" ? ongoing.length : 0;
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
      {view === "generator" && <GeneratorView config={config} folderPath={project.folderPath} generationCompletionTimes={generationCompletionTimes} runtime={runtime?.vidfab ?? null} onRuntimeChange={onGeneratorRuntimeChange} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} />}
      {view === "references" && <ReferencesView config={config} folderPath={project.folderPath} onChange={changeConfig} />}
      {view === "export" && <ExportView config={config} folderPath={project.folderPath} />}
    </div>
    <footer className={`project-agent-row${view === "agent" ? " project-agent-row--page" : ""}`}><AgentDock
      context={view === "timeline" ? "the edit" : view === "generator" ? "this generation queue" : view === "references" ? "project references" : view === "export" ? "this export" : "this project"}
      record={{ ...project, config }}
      providers={runtime?.providers ?? CHECKING_PROVIDERS}
      expanded={view === "agent"}
      onPromptStart={() => setView("agent")}
      /* The provider only proposes typed commands. Apply them to configRef's
         latest state—edits can continue while it thinks—then route the result
         through the same ordered save queue as the Save button. */
      onCommands={async (commands) => {
        const next = await executeAgentCommands(configRef.current, commands);
        applyConfig(next);
        dirtyRevision.current += 1;
        setDirty(true);
        await save({ ...project, config: next });
      }}
    /></footer>
    {leaveGuard && <ExitGuardDialog jobs={ongoing} destination="library" onConfirm={leave} onCancel={() => setLeaveGuard(false)} />}
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
  </div>;
}
