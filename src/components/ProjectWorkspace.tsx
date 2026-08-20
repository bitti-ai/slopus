import { ArrowLeft, BookOpen, Download, Film, Save, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GenerationJob, ProjectConfig, ProjectRecord } from "../lib/project";
import { cancelVidfabGeneration, CHECKING_PROVIDERS, type RuntimeStatus } from "../lib/runtime";
import { ExitGuardDialog, type OngoingGeneration } from "./ExitGuardDialog";
import { AgentDock } from "./workspace/AgentDock";
import { ExportView } from "./workspace/ExportView";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView, type ConfigUpdate } from "./workspace/TimelineView";

export type ProjectView = "timeline" | "generator" | "references" | "export";

/** A generation the app is still working on. These are exactly the two statuses
 *  the Generator splits into its "Rendering now" and "Waiting to render" groups
 *  and locks a shot's references on; the topbar count and the exit guard both
 *  read this one predicate, so a badge saying "2" and a warning about what
 *  leaving costs can never disagree. */
export const isGenerationOngoing = (job: GenerationJob) => job.status === "generating" || job.status === "queued";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, initialView = "timeline", runtime = null, onBack, onSave, onOngoingGenerationsChange }: {
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
}) {
  const [config, setConfig] = useState(project.config);
  const [view, setView] = useState<ProjectView>(initialView);
  const [selectedGenerationJobId, setSelectedGenerationJobId] = useState<string | undefined>(project.config.generationJobs[0]?.id);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /* The back control asks before it navigates when there is a run to lose. */
  const [leaveGuard, setLeaveGuard] = useState(false);

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
    /* Nothing resumes, and nothing is written until a shot finishes, so a run
       the user has walked away from can only burn the GPU for a result no one
       is listening for — the events that record it land in the Generator, which
       is about to unmount. Stopped the same way its own stop button stops it. */
    ongoing.forEach((job) => { void cancelVidfabGeneration(job.id).catch(() => undefined); });
    onBack();
  };

  /* Takes an updater as well as a value, because a write built from something
     asynchronous cannot safely name the config it starts from — see
     TimelineView's measurement flush. Views that only ever change the project
     from a click still pass a plain value. */
  const changeConfig = (next: ConfigUpdate) => {
    setConfig(next);
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
  const recordMeasurement = (update: (current: ProjectConfig) => ProjectConfig) => setConfig(update);

  const save = async (record?: ProjectRecord) => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(record ?? { ...project, config });
      setDirty(false);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
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
        {([ ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => {
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
      {view === "timeline" && <TimelineView config={config} folderPath={project.folderPath} onChange={changeConfig} onMeasured={recordMeasurement} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
      {view === "generator" && <GeneratorView config={config} folderPath={project.folderPath} runtime={runtime?.vidfab ?? null} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} />}
      {view === "references" && <ReferencesView config={config} folderPath={project.folderPath} onChange={changeConfig} />}
      {view === "export" && <ExportView config={config} folderPath={project.folderPath} />}
    </div>
    <footer className="project-agent-row"><AgentDock
      context={view === "timeline" ? "the edit" : view === "generator" ? "this generation queue" : view === "export" ? "this export" : "project references"}
      record={{ ...project, config }}
      providers={runtime?.providers ?? CHECKING_PROVIDERS}
      /* Routed through the same save() as the Save button. Clearing `dirty`
         up front reported a saved project even when the write then failed,
         and swallowed the reason; save() clears only on success and surfaces
         the failure in the toast. */
      onRecord={(record) => { setConfig(record.config); void save(record); }}
    /></footer>
    {leaveGuard && <ExitGuardDialog jobs={ongoing} destination="library" onConfirm={leave} onCancel={() => setLeaveGuard(false)} />}
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
  </div>;
}
