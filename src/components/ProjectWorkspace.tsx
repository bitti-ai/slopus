import { ArrowLeft, BookOpen, ChevronDown, Cloud, Film, Play, Redo2, Save, Share2, Sparkles, Undo2 } from "lucide-react";
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

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ ...project, config });
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
      <div className="project-title"><strong>{config.name}</strong><span><Cloud size={11} /> Local project <i>•</i> {dirty ? "Unsaved changes" : "All changes saved"}</span></div>
      <div className="project-history"><button className="icon-button" aria-label="Undo"><Undo2 size={15} /></button><button className="icon-button" aria-label="Redo"><Redo2 size={15} /></button></div>
      <div className="project-topbar__actions"><button className="secondary-button" onClick={() => void save()} disabled={saving}><Save size={14} /> {saving ? "Saving…" : "Save"}</button><button className="secondary-button"><Share2 size={14} /> Share</button><button className="primary-button"><Play size={14} fill="currentColor" /> Export <ChevronDown size={12} /></button></div>
    </header>

    <nav className="project-nav" aria-label="Project views">
      <div>{([ ["timeline", Film, "Timeline"], ["generator", Sparkles, "Generator"], ["references", BookOpen, "References"] ] as const).map(([id, Icon, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}><Icon size={14} /> {label}{id === "generator" && <span>{config.generationJobs.filter((job) => job.status === "generating" || job.status === "queued").length}</span>}</button>)}</div>
      <span className="project-nav__meta">{config.settings.aspectRatio} · {config.settings.resolution.toUpperCase()} · {config.settings.frameRate} FPS</span>
    </nav>

    <div className={`project-content project-content--${view}`}>
      {view === "timeline" && <TimelineView config={config} onChange={changeConfig} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
      {view === "generator" && <GeneratorView config={config} runtime={runtime?.vidfab ?? null} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onOpenTimeline={() => setView("timeline")} />}
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
      onRecord={(record) => { setConfig(record.config); setDirty(false); void onSave(record); }}
    /></footer>
    {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
  </div>;
}
