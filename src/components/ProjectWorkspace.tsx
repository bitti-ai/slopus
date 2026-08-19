import { ArrowLeft, BookOpen, Download, Film, Save, Sparkles } from "lucide-react";
import { useState } from "react";
import type { ProjectConfig, ProjectRecord } from "../lib/project";
import { CHECKING_PROVIDERS, type RuntimeStatus } from "../lib/runtime";
import { AgentDock } from "./workspace/AgentDock";
import { ExportView } from "./workspace/ExportView";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView } from "./workspace/TimelineView";

export type ProjectView = "timeline" | "generator" | "references" | "export";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, initialView = "timeline", runtime = null, onBack, onSave }: {
  project: ProjectRecord;
  initialView?: ProjectView;
  /** What is installed on this computer, probed once at startup by App. Null
   *  while that probe is still in flight — not "nothing is installed". */
  runtime?: RuntimeStatus | null;
  onBack: () => void;
  onSave: (project: ProjectRecord) => Promise<void>;
}) {
  const [config, setConfig] = useState(project.config);
  const [view, setView] = useState<ProjectView>(initialView);
  const [selectedGenerationJobId, setSelectedGenerationJobId] = useState<string | undefined>(project.config.generationJobs[0]?.id);
  /* Switching tabs unmounts the generator, so its composer text lives here.
     Half a shot description used to vanish on a trip to the timeline and back. */
  const [generatorPrompt, setGeneratorPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const changeConfig = (next: ProjectConfig) => {
    setConfig(next);
    setDirty(true);
  };

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
        <button className="icon-button icon-button--strong" onClick={onBack} aria-label="Back to project library"><ArrowLeft size={18} /></button>
        {/* The name column is the topbar's elastic column and truncates on narrow
            windows, so the full name stays available on hover. */}
        <div className="project-title"><strong title={config.name}>{config.name}</strong></div>
      </div>

      <nav className="project-nav" aria-label="Project views">
        {([ ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => {
          const running = id === "generator" ? config.generationJobs.filter((job) => job.status === "generating" || job.status === "queued").length : 0;
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
      {view === "timeline" && <TimelineView config={config} folderPath={project.folderPath} onChange={changeConfig} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
      {view === "generator" && <GeneratorView config={config} folderPath={project.folderPath} runtime={runtime?.vidfab ?? null} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} draftPrompt={generatorPrompt} onDraftPromptChange={setGeneratorPrompt} />}
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
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
  </div>;
}
