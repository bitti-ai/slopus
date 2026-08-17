import { ArrowLeft, BookOpen, Cloud, Download, Film, Save, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectConfig, ProjectRecord } from "../lib/project";
import { getRuntimeStatus, type ProviderId, type RuntimeStatus } from "../lib/runtime";
import { AgentDock } from "./workspace/AgentDock";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView } from "./workspace/TimelineView";

export type ProjectView = "timeline" | "generator" | "references";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, initialView = "timeline", onBack, onSave }: {
  project: ProjectRecord;
  initialView?: ProjectView;
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
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);

  useEffect(() => {
    void getRuntimeStatus(config).then(setRuntime).catch(() => setRuntime(null));
    // Runtime configuration only needs reprobe when provider settings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.providerSettings]);

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

  const selectProvider = (provider: ProviderId) => {
    changeConfig({ ...config, providerSettings: {
      ...config.providerSettings,
      agent: { enabled: true, model: null, options: { ...(config.providerSettings.agent?.options ?? {}), selectedProvider: provider } },
    } });
  };

  return <div className="project-shell">
    <header className="project-topbar">
      <button className="icon-button icon-button--strong" onClick={onBack} aria-label="Back to project library"><ArrowLeft size={18} /></button>
      {/* The name column is the topbar's elastic column and truncates on narrow
          windows, so the full name stays available on hover. */}
      <div className="project-title"><strong title={config.name}>{config.name}</strong><span><Cloud size={13} aria-hidden="true" /> Local project</span></div>
      <p className={`save-state save-state--${dirty ? "dirty" : "saved"}`} aria-live="polite"><i aria-hidden="true" />{dirty ? "Unsaved changes" : "All changes saved"}</p>
      <div className="project-topbar__actions">
        {/* Export is not wired to anything yet, so it must not look like a working action. */}
        <button className="secondary-button" type="button" disabled title="Export isn’t available yet. PolStudio can’t save generated shots as video files yet, so there is nothing to export.">
          <Download size={16} aria-hidden="true" /> Export <span className="project-topbar__soon">Soon</span>
        </button>
        <button className="primary-button" onClick={() => void save()} disabled={saving}><Save size={16} aria-hidden="true" /> {saving ? "Saving…" : "Save"}</button>
      </div>
    </header>

    <nav className="project-nav" aria-label="Project views">
      <div>{([ ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => {
        const running = id === "generator" ? config.generationJobs.filter((job) => job.status === "generating" || job.status === "queued").length : 0;
        return <button key={id} type="button" className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
          <Icon size={18} aria-hidden="true" /> {label}
          {running > 0 && <span title={`${running} generation${running === 1 ? "" : "s"} running or queued`}>{running}</span>}
        </button>;
      })}</div>
      <span className="project-nav__meta" title="Aspect ratio, resolution, and frame rate for this project">{config.settings.aspectRatio} · {config.settings.resolution.toUpperCase()} · {config.settings.frameRate} FPS</span>
    </nav>

    <div className={`project-content project-content--${view}`}>
      {view === "timeline" && <TimelineView config={config} onChange={changeConfig} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
      {view === "generator" && <GeneratorView config={config} folderPath={project.folderPath} runtime={runtime?.vidfab ?? null} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} draftPrompt={generatorPrompt} onDraftPromptChange={setGeneratorPrompt} />}
      {view === "references" && <ReferencesView config={config} folderPath={project.folderPath} onChange={changeConfig} />}
    </div>
    <footer className="project-agent-row"><AgentDock
      context={view === "timeline" ? "the edit" : view === "generator" ? "this generation queue" : "project references"}
      record={{ ...project, config }}
      providers={runtime?.providers ?? [
        { id: "claude", label: "Claude Code", state: "unavailable", executable: null, version: null, detail: "Checking provider…" },
        { id: "codex", label: "Codex", state: "unavailable", executable: null, version: null, detail: "Checking provider…" },
      ]}
      onProviderChange={selectProvider}
      /* Routed through the same save() as the Save button. Clearing `dirty`
         up front showed "All changes saved" even when the write then failed,
         and swallowed the reason; save() clears only on success and surfaces
         the failure in the toast. */
      onRecord={(record) => { setConfig(record.config); void save(record); }}
    /></footer>
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
  </div>;
}
