import { Agent16, Agent16Filled, Back16, ChevronDown12, Download16, Download16Filled, Film16, Film16Filled, Image16, Image16Filled, Redo16, References16, References16Filled, Save16, Sparkle16, Sparkle16Filled, Undo16 } from "./ui/icons";
import { ImageEditor } from "./workspace/ImageEditor";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GenerationJob, ProjectConfig, ProjectRecord } from "../lib/project";
import { CHECKING_PROVIDERS, executeAgentCommands, type RuntimeStatus, type SlopfabStatus } from "../lib/runtime";
import { purgeTimelineThumbnails } from "../lib/timelineThumbnails";
import { WorkQueue, projectQueueKey } from "../lib/workQueue";
import { useShortcut } from "../lib/commands";
import { AgentDock } from "./workspace/AgentDock";
import { ExportView } from "./workspace/ExportView";
import { ImageExportView } from "./workspace/ImageExportView";
import { GeneratorView } from "./workspace/GeneratorView";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView, type ConfigUpdate } from "./workspace/TimelineView";
import { UnsavedProjectDialog } from "./UnsavedProjectDialog";
import { PromptComposer } from "./PromptComposer";
import { TitleBar } from "./TitleBar";
import { InfoBadge, InfoBar, SelectorBar, Splitter, StatusBar, tooltipProps, usePaneSize } from "./ui";
import { ProjectStatusSlot } from "./workspace/ProjectStatus";
import { outputDimensions, videoDurationMs } from "../lib/export";

/** "agent" is not a view any more — the agent is a docked pane — but opening
 *  a project "on the agent" still means something: the pane opens with it. */
export type ProjectView = "timeline" | "generator" | "references" | "agent" | "export" | "editor";
type ShownView = Exclude<ProjectView, "agent">;

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

/** A sequence's length as the status bar gives it: "32 s", "2.5 s", "1:05". */
export function formatSequenceLength(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 1 : 0))} s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** "Saved 18:42" for today, "Saved 24 Sep" for an older save. */
export function formatSavedAt(savedAt: number | null, now = Date.now()): string {
  if (savedAt === null) return "Saved";
  const when = new Date(savedAt);
  const today = new Date(now).toDateString() === when.toDateString();
  return `Saved ${today
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

const AGENT_PANE_KEY = "slopus.workspace.agentPane";
const readAgentPane = (): boolean => {
  try { return localStorage.getItem(AGENT_PANE_KEY) !== "closed"; } catch { return true; }
};
const writeAgentPane = (open: boolean) => {
  try { localStorage.setItem(AGENT_PANE_KEY, open ? "open" : "closed"); } catch { /* storage unavailable */ }
};

const VIEW_LABELS: Record<ShownView, string> = {
  timeline: "Timeline", generator: "Generator", references: "References", export: "Export", editor: "Editor",
};

const AGENT_PANE_MIN = 280;
const AGENT_PANE_MAX = 640;
/** The widest the agent pane may be in a window this wide: 35% of it. */
export const agentPaneMax = (windowWidth: number) =>
  Math.max(AGENT_PANE_MIN, Math.min(AGENT_PANE_MAX, Math.round(windowWidth * 0.35)));

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1280 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/* The project window.

     [←] [icon] Project name   Timeline Generator References Export   [↶][↷] [Save] [Agent][Queue][⚙] [– □ ×]
     ─────────────────────────────────────────────────────────────────────────────────────────────────────
     InfoBars (save failed, export failed)
     ┌ the view ─────────────────────────────────────────┐┃┌ Agent ──────────┐
     │                                                   │┃│                 │
     └───────────────────────────────────────────────────┘┃└─────────────────┘

   The title bar is the caption AND the app's header (i-frame-1): Back, the
   project name (click for project settings), the view switcher as a
   SelectorBar (tabs, not links; Ctrl+1…4), Undo/Redo, Save, and the pane and
   app buttons. The agent is a docked pane on the right with a Splitter;
   Ctrl+Shift+A or the title-bar button shows and hides it, and both its width
   and whether it is open are remembered.

   Undo/Redo (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z) is project-wide: every edit a view
   hands up through onChange, the agent's commands and the project settings go
   through session.edit() and are undo steps; background work (generation
   results, icons, measurements) is not (see projectSession.ts). Text fields
   keep their own native undo — the shortcuts do not fire in them. */
export function ProjectWorkspace({ project, initialView = "timeline", runtime = null, onBack, onSave, workQueue, onGeneratorRuntimeChange, titleBarActions, active = true }: {
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
  /** App-wide title-bar buttons (work queue, settings), after the project's own. */
  titleBarActions?: ReactNode;
  /** False while the workspace is hidden behind another page (Settings): its
   *  keyboard shortcuts stand down. */
  active?: boolean;
}) {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const [localQueue] = useState(() => new WorkQueue((record) => saveRef.current(record)));
  const queue = workQueue ?? localQueue;
  const session = useMemo(() => queue.project(project), [queue, project.folderPath, project.config.id]);
  const { config, saving, dirty, saveError, canUndo, canRedo, savedAt } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const imageProject = config.generationType === "image";
  const [view, setView] = useState<ShownView>(() => {
    if (imageProject) return initialView === "references" || initialView === "export" ? initialView : "editor";
    return initialView === "agent" || initialView === "editor" ? "timeline" : initialView;
  });
  const [agentOpen, setAgentOpenState] = useState(() => initialView === "agent" || readAgentPane());
  const [agentBusy, setAgentBusy] = useState(false);
  const setAgentOpen = (open: boolean) => { setAgentOpenState(open); writeAgentPane(open); };
  /* 360px is a comfortable conversation column, but at the 900px window
     minimum it would take 40% of the width from the editor. The pane gives
     way instead: never more than about a third of the window (and never
     under 280px). A wider size the user dragged to comes back as the window
     grows. */
  const windowWidth = useWindowWidth();
  const agentPane = usePaneSize("workspace.agent", 360, { min: AGENT_PANE_MIN, max: agentPaneMax(windowWidth) });
  const agentPaneRef = useRef<HTMLElement>(null);
  const agentToggle = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const [savingToLeave, setSavingToLeave] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [savingProjectSettings, setSavingProjectSettings] = useState(false);
  const [selectedGenerationJobId, setSelectedGenerationJobId] = useState<string | undefined>(project.config.generationJobs[0]?.id);
  const knownSceneIds = useRef(new Set(project.config.generationJobs.map((job) => job.id)));
  const projectItems = items.filter((item) => item.projectKey === projectQueueKey(project));
  const generationCompletionTimes = Object.fromEntries(projectItems.filter((item) => item.completionAt !== null).map((item) => [item.sceneId, item.completionAt as number]));
  const cancellingJobIds = new Set(projectItems.filter((item) => item.cancelling).map((item) => item.sceneId));
  const panelId = useId();
  /* The status bar's leading side is filled by the view through a portal. */
  const [statusSlot, setStatusSlot] = useState<HTMLElement | null>(null);
  useEffect(() => workQueue ? undefined : queue.start(), [queue, workQueue]);
  /* Every edit a view reports is an undo step. A view may pass a key to
     coalesce a run of edits (a drag, typing) into one; the default key already
     merges edits that arrive within half a second of each other. */
  const changeConfig = (next: ConfigUpdate, key?: string) => session.edit(next, key);
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
  const goBack = () => { if (dirty) setLeaving(true); else onBack(); };

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

  const { width: frameWidth, height: frameHeight } = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  const lengthMs = useMemo(() => videoDurationMs(config), [config]);
  const sequenceFormat = `${frameWidth}×${frameHeight} · ${config.settings.frameRate} fps · ${formatSequenceLength(lengthMs)}`;

  const views: ShownView[] = imageProject ? ["editor", "references", "export"] : ["timeline", "generator", "references", "export"];
  const running = config.generationJobs.filter(isGenerationOngoing).length;
  const toggleAgent = () => {
    const open = !agentOpen;
    setAgentOpen(open);
    if (open) requestAnimationFrame(() => agentPaneRef.current?.querySelector<HTMLElement>("textarea:not(:disabled), button:not(:disabled)")?.focus());
    else if (agentPaneRef.current?.contains(document.activeElement)) agentToggle.current?.focus();
  };

  /* ── Accelerators (i-frame-4) ─────────────────────────────────────────── */
  const idle = active && !editingProject && !leaving;
  useShortcut("Ctrl+S", () => { if (dirty && !saving) void save(); }, { enabled: idle, allowInInput: true });
  useShortcut("Ctrl+Z", () => { session.undo(); }, { enabled: idle });
  useShortcut(["Ctrl+Y", "Ctrl+Shift+Z"], () => { session.redo(); }, { enabled: idle });
  useShortcut(["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4"], (event) => {
    const next = views[Number(event.code?.replace("Digit", "") || event.key) - 1];
    if (!next) return false;
    setView(next);
  }, { enabled: idle, allowInInput: true });
  useShortcut("Ctrl+E", () => { setView("export"); }, { enabled: idle, allowInInput: true });
  useShortcut("Ctrl+Shift+A", toggleAgent, { enabled: idle, allowInInput: true });
  useShortcut("Alt+ArrowLeft", goBack, { enabled: idle });

  const viewIcon = (id: ShownView, selected: boolean) => id === "timeline" ? (selected ? <Film16Filled /> : <Film16 />)
    : id === "generator" ? (selected ? <Sparkle16Filled /> : <Sparkle16 />)
      : id === "references" ? (selected ? <References16Filled /> : <References16 />)
        : id === "export" ? (selected ? <Download16Filled /> : <Download16 />)
          : selected ? <Image16Filled /> : <Image16 />;
  const shortcutOf = (index: number) => `Ctrl+${index + 1}`;

  return <div className="project-shell">
    {editingProject && <PromptComposer project={config} busy={savingProjectSettings} error={saveError} onClose={() => setEditingProject(false)} onCreate={async (input) => {
      setSavingProjectSettings(true);
      try {
        session.edit((current) => ({
          ...current, name: input.name,
          brief: { ...current.brief, aspectRatio: input.aspectRatio, resolution: input.resolution },
          settings: { ...current.settings, aspectRatio: input.aspectRatio, resolution: input.resolution, defaultLook: input.defaultLook },
        }), "project-settings");
        await session.save();
        setEditingProject(false);
      } catch { /* Keep the dialog open; the session supplies the save error. */ }
      finally { setSavingProjectSettings(false); }
    }} />}
    {leaving && <UnsavedProjectDialog name={config.name} busy={savingToLeave} error={saveError} onSave={() => void leave(true)} onDiscard={() => void leave(false)} onBack={() => setLeaving(false)} />}

    <TitleBar
      className="project-titlebar"
      leading={<button type="button" className="icon-button" onClick={goBack} aria-label="Back to project library" data-tooltip="Back to projects" data-tooltip-shortcut="Alt+Left" aria-keyshortcuts="Alt+ArrowLeft"><Back16 /></button>}
      title={<button type="button" className="project-title" aria-label={`Edit project settings for ${config.name}`} aria-haspopup="dialog" aria-expanded={editingProject} data-tooltip="Project settings" onClick={() => { session.dismissError(); setEditingProject(true); }}><span className="project-title__name">{config.name}</span><ChevronDown12 aria-hidden="true" /></button>}
      actions={<>
        <button type="button" className="icon-button" disabled={!canUndo} onClick={() => session.undo()} aria-label="Undo" data-tooltip="Undo" data-tooltip-shortcut="Ctrl+Z" aria-keyshortcuts="Control+Z"><Undo16 /></button>
        <button type="button" className="icon-button" disabled={!canRedo} onClick={() => session.redo()} aria-label="Redo" data-tooltip="Redo" data-tooltip-shortcut="Ctrl+Y" aria-keyshortcuts="Control+Y Control+Shift+Z"><Redo16 /></button>
        <span className="titlebar-separator" aria-hidden="true" />
        <div className="project-commands">
          {/* The standing "All changes saved" pill is gone; the button itself is
              the save state. Off means the file on disk already matches what is
              on screen. */}
          <button type="button" className="primary-button" onClick={() => void save()} disabled={saving || !dirty} data-tooltip={saving ? "Saving…" : dirty ? "Save" : "Everything is saved"} data-tooltip-shortcut="Ctrl+S" aria-keyshortcuts="Control+S">
            <Save16 aria-hidden="true" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <span className="titlebar-separator" aria-hidden="true" />
        <button ref={agentToggle} type="button" className={`icon-button${agentOpen ? " icon-button--checked" : ""}${agentBusy ? " icon-button--busy" : ""}`} aria-label="Agent" aria-pressed={agentOpen} aria-busy={agentBusy} aria-controls={`${panelId}-agent`} data-tooltip={`${agentOpen ? "Hide agent" : "Show agent"}${agentBusy ? " · working" : ""}`} data-tooltip-shortcut="Ctrl+Shift+A" aria-keyshortcuts="Control+Shift+A" onClick={toggleAgent}>{agentOpen ? <Agent16Filled /> : <Agent16 />}</button>
        {titleBarActions}
      </>}
    >
      <SelectorBar<ShownView>
        className="project-views"
        aria-label="Project views"
        value={view}
        onChange={setView}
        items={views.map((id) => ({
          value: id,
          controls: `${panelId}-view`,
          label: id === "generator" && running > 0
            ? <span className="project-views__label" data-tooltip={`${running} generation${running === 1 ? "" : "s"} running or queued`} data-tooltip-shortcut={shortcutOf(views.indexOf(id))}><span className="project-views__name" data-label={VIEW_LABELS[id]}>{VIEW_LABELS[id]}</span><InfoBadge value={running} severity="informational" /></span>
            : <span className="project-views__label" data-tooltip={VIEW_LABELS[id]} data-tooltip-shortcut={shortcutOf(views.indexOf(id))}><span className="project-views__name" data-label={VIEW_LABELS[id]}>{VIEW_LABELS[id]}</span></span>,
          icon: viewIcon(id, id === view),
        }))}
      />
    </TitleBar>

    {saveError && <div className="project-infobars">
      {!editingProject && !leaving && <InfoBar severity="error" title="Couldn’t save project" message={saveError} onClose={session.dismissError} />}
    </div>}

    <ProjectStatusSlot.Provider value={statusSlot}>
    <div className={`project-body${agentOpen ? " project-body--agent" : ""}`} style={agentPane.style}>
      <div id={`${panelId}-view`} role="tabpanel" aria-label={VIEW_LABELS[view]} className={`project-content project-content--${view}`}>
        {view === "editor" && imageProject && <ImageEditor config={config} folderPath={project.folderPath} onChange={changeConfig} onGenerate={(template) => queue.enqueueImage(session, template)} onCancel={(id) => queue.cancel(id)} work={projectItems.filter((item) => item.kind === "image").at(-1)} />}
        {view === "timeline" && <TimelineView config={config} openSceneId={selectedGenerationJobId} folderPath={project.folderPath} generationCompletionTimes={generationCompletionTimes} onChange={changeConfig} onMeasured={recordMeasurement} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView(imageProject ? "editor" : "generator"); }} />}
        {view === "generator" && <GeneratorView onGenerate={(submissions) => queue.enqueue(session, submissions)} onCancelGeneration={(ids) => queue.cancelScenes(session, ids)} cancellingJobIds={cancellingJobIds} config={config} folderPath={project.folderPath} generationCompletionTimes={generationCompletionTimes} runtime={runtime?.slopfab ?? null} onRuntimeChange={onGeneratorRuntimeChange} onChange={changeConfig} selectedJobId={selectedGenerationJobId} onSelectedJobChange={setSelectedGenerationJobId} onOpenTimeline={() => setView("timeline")} />}
        {view === "references" && <ReferencesView config={config} folderPath={project.folderPath} onChange={changeConfig} onRegenerateIcon={(id) => queue.regenerateReferenceIcon(session, id)} onGenerateBuiltinIcons={() => queue.generateBuiltinReferenceIcons(session)} onRegenerateBuiltinIcon={(id) => queue.regenerateBuiltinReferenceIcon(session, id)} pendingBuiltinIconIds={queue.pendingBuiltinIconIds()} pendingIconIds={new Set(config.references.filter((reference) => queue.isReferenceIconPending(session, reference.id)).map((reference) => reference.id))} onOpenGenerator={(jobId) => { setSelectedGenerationJobId(jobId); setView("generator"); }} />}
        {view === "export" && (imageProject
          ? <ImageExportView config={config} folderPath={project.folderPath} />
          : <ExportView config={config} folderPath={project.folderPath} onClose={() => setView("timeline")} />)}
      </div>
      {agentOpen && <Splitter {...agentPane.splitterProps} reverse aria-label="Resize agent pane" aria-controls={`${panelId}-agent`} />}
      {/* Kept mounted while hidden, so a running turn and the conversation
          survive the pane being closed. */}
      <aside ref={agentPaneRef} id={`${panelId}-agent`} className="project-agent-pane" aria-label="Agent" hidden={!agentOpen}>
        <AgentDock
          context={view === "editor" ? "this image composition" : view === "timeline" ? "the edit" : view === "generator" ? "this generation queue" : view === "references" ? "project references" : "this export"}
          record={{ ...project, config }}
          providers={runtime?.providers ?? CHECKING_PROVIDERS}
          onClose={() => { setAgentOpen(false); agentToggle.current?.focus(); }}
          onPromptStart={() => { if (!agentOpen) setAgentOpen(true); }}
          onBusyChange={setAgentBusy}
          /* The provider only proposes typed commands. Apply them to the session's
             latest state—edits can continue while it thinks—as one undo step, then
             route the result through the same ordered save queue as the Save button. */
          onCommands={async (commands) => {
            const next = await executeAgentCommands(session.getSnapshot().config, commands);
            session.edit(next, "agent");
            session.sealHistory();
            await save();
          }}
        />
      </aside>
    </div>
    </ProjectStatusSlot.Provider>

    {/* One strip along the window's foot on every view: the view's own facts
        on the leading side, the sequence and whether it is on disk trailing. */}
    <StatusBar
      aria-label={`${VIEW_LABELS[view]} status`}
      className="project-status"
      end={<>
        {!imageProject && <span className="project-status__format" {...tooltipProps("Sequence format: frame size, frame rate and length")}>{sequenceFormat}</span>}
        <span
          className={`project-status__save project-status__save--${saving ? "saving" : dirty ? "unsaved" : "saved"}`}
          {...tooltipProps(!saving && !dirty && savedAt !== null ? `Saved ${new Date(savedAt).toLocaleString()}` : undefined)}
        >{saving ? "Saving…" : dirty ? "Unsaved changes" : formatSavedAt(savedAt)}</span>
      </>}
    >
      <span ref={setStatusSlot} className="project-status__view" />
    </StatusBar>
  </div>;
}
