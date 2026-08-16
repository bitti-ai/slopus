import {
  ArrowLeft,
  ChevronDown,
  Cloud,
  FolderOpen,
  Image,
  Layers3,
  MonitorPlay,
  MousePointer2,
  Play,
  Plus,
  Redo2,
  Save,
  Send,
  Share2,
  Sparkles,
  Undo2,
  WandSparkles,
} from "lucide-react";
import { useState } from "react";
import type { ProjectRecord } from "../lib/project";

export function formatDurationTimecode(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

export function ProjectWorkspace({ project, onBack, onSave }: {
  project: ProjectRecord;
  onBack: () => void;
  onSave: (project: ProjectRecord) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [agentPrompt, setAgentPrompt] = useState("");
  const { config } = project;
  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(project);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workspace">
      <header className="workspace__topbar">
        <button className="icon-button icon-button--strong" onClick={onBack} aria-label="Back to project library"><ArrowLeft size={18} /></button>
        <div className="workspace__project-name">
          <strong>{config.name}</strong>
          <span><Cloud size={12} /> Local project <i>•</i> {config.settings.resolution.toUpperCase()}</span>
        </div>
        <div className="workspace__history">
          <button className="icon-button" aria-label="Undo"><Undo2 size={16} /></button>
          <button className="icon-button" aria-label="Redo"><Redo2 size={16} /></button>
        </div>
        <div className="workspace__actions">
          <button className="secondary-button" onClick={() => void save()} disabled={saving}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
          <button className="secondary-button"><Share2 size={15} /> Share</button>
          <button className="primary-button"><Play size={15} fill="currentColor" /> Export <ChevronDown size={13} /></button>
        </div>
      </header>

      <div className="workspace__body">
        <aside className="toolrail" aria-label="Editor tools">
          <button className="toolrail__item toolrail__item--active"><MousePointer2 size={19} /><span>Select</span></button>
          <button className="toolrail__item"><Sparkles size={19} /><span>Generate</span></button>
          <button className="toolrail__item"><Image size={19} /><span>Media</span></button>
          <button className="toolrail__item"><Layers3 size={19} /><span>Elements</span></button>
        </aside>

        <section className="inspector-panel">
          <div className="inspector-panel__heading"><div><span className="eyebrow">Agent brief</span><h2>First cut</h2></div><WandSparkles size={18} /></div>
          <div className="agent-brief">
            <p>{config.brief.prompt}</p>
            <div className="agent-brief__meta"><span>{config.brief.targetDurationSeconds} sec</span><span>{config.settings.aspectRatio}</span><span>{config.settings.resolution}</span></div>
          </div>
          <button className="agent-action"><Sparkles size={16} /><span><strong>Plan my video</strong><small>Build scenes from this brief</small></span></button>
          <div className="panel-section">
            <div className="panel-section__title"><span>Project assets</span><button className="icon-button"><Plus size={15} /></button></div>
            <button className="asset-drop"><FolderOpen size={21} /><strong>Add local media</strong><small>Video, audio, or images</small></button>
          </div>
          <div className="project-location"><FolderOpen size={14} /><span><strong>Project folder</strong><small title={project.folderPath}>{project.folderPath}</small></span></div>
        </section>

        <main className="stage">
          <div className="stage__toolbar"><span>Fit</span><ChevronDown size={13} /><i /><span>100%</span></div>
          <div className={`canvas-frame canvas-frame--${config.settings.aspectRatio.replace(":", "-")}`}>
            <div className="canvas-frame__glow" />
            <div className="canvas-frame__empty">
              <span><MonitorPlay size={26} /></span>
              <h2>Your canvas is ready</h2>
              <p>Ask the agent to plan a first cut or add media from your project folder.</p>
              <button className="primary-button"><Sparkles size={15} /> Plan first cut</button>
            </div>
          </div>
          <div className="transport"><span>00:00:00</span><button><Play size={17} fill="currentColor" /></button><span>{formatDurationTimecode(config.brief.targetDurationSeconds)}</span></div>
          <div className="workspace-prompt">
            <Sparkles size={15} />
            <input
              aria-label="Ask the Pol Studio agent"
              value={agentPrompt}
              onChange={(event) => setAgentPrompt(event.target.value)}
              placeholder="Ask Pol to plan scenes, revise the mood, or find a stronger opening…"
            />
            <button disabled={!agentPrompt.trim()} aria-label="Send to agent"><Send size={14} /></button>
          </div>
        </main>
      </div>

      <section className="timeline-placeholder">
        <div className="timeline-placeholder__top"><div><strong>Timeline</strong><span>Scene-based editing will appear here</span></div><button className="secondary-button"><Plus size={14} /> Add scene</button></div>
        <div className="timeline-placeholder__track"><span>V1</span><div><i /><i /><i /><p>Drop media or generate a first cut to begin</p></div></div>
      </section>
      {saveError && <div className="toast" role="alert"><strong>Couldn’t save project</strong><span>{saveError}</span><button onClick={() => setSaveError(null)}>Dismiss</button></div>}
    </div>
  );
}
