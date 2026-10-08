import { WorkQueue, isWorkActive, projectQueueKey } from "./lib/workQueue";
import { WorkQueuePanel, type WorkQueueTarget } from "./components/WorkQueuePanel";
import { ReferenceIconGenerationDialog } from "./components/ReferenceIconGenerationDialog";
import { CudaSetupDialog } from "./components/CudaSetupDialog";
import { ReleaseNotesDialog } from "./components/ReleaseNotesDialog";
import { hasSeenReleaseNotes } from "./lib/releaseNotes";
import { missingCudaDownload } from "./lib/cudaSupport";
import { getQueuedWeightDownloads, getWeightDownloadState, subscribeWeightDownloads } from "./lib/weightDownloads";
import { startWorkerDiscovery } from "./lib/workers";
import { Add16, FolderOpen16, FolderOpen48, GridView16, GridView16Filled, ListView16, ListView16Filled, Search16, Search32, Settings16, WorkQueue16 } from "./components/ui/icons";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { DeleteProjectDialog, canConfirmNatively, confirmProjectDeletionNatively } from "./components/DeleteProjectDialog";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace, type ProjectView, type WorkspaceNavigation } from "./components/ProjectWorkspace";
import { PromptComposer } from "./components/PromptComposer";
import { SettingsView, type SettingsNavigation } from "./components/SettingsView";
import { TitleBar } from "./components/TitleBar";
import { UpdateInfoBar, UpdatePanel, updateNeedsAttention } from "./components/UpdatePanel";
import { CommandBar, CommandBarButton, EmptyState, InfoBadge, InfoBar, TextField } from "./components/ui";
import { AppUpdater } from "./lib/updater";
import { useShortcut } from "./lib/commands";
import { APP_CHANNEL, APP_VERSION } from "./lib/version";
import { isExportActive, useExportActivity } from "./lib/exportJob";
import { reportGenerationJobs, revealInExplorer, type GuardJob } from "./lib/nativeShell";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "./lib/diagnostics";
import { chooseAndOpenProject, chooseNewProjectFolder, inspectNewProjectFolder, createProject, deleteProject, isTauri, listRecentProjects, saveProject, type NewProjectFolder } from "./lib/persistence";
import type { CreateProjectInput, ProjectRecord } from "./lib/project";
import { CHECKING_PROVIDERS, getRuntimeStatus, type RuntimeStatus } from "./lib/runtime";

interface LibraryError {
  /** What failed, in the user’s terms. */
  title: string;
  /** The underlying message, kept verbatim so it stays diagnosable. */
  detail: string;
}

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const logFailure = (event: string, reason: unknown, context: Record<string, unknown> = {}) => {
  writeDiagnostic("error", "app", event, describeDiagnosticError(reason), { ...context, ...errorContext(reason) });
};

/* ── The app frame ────────────────────────────────────────────────────────
   The window is frameless, so every top-level screen — the library, an open
   project, Settings — carries a <TitleBar> as its first row: it is what drags,
   maximizes and closes the window. App-wide commands live at the trailing end
   of it, just before the caption buttons: Settings (with a dot when an update
   is waiting) and the Work queue (with an InfoBadge counting what is
   running). Nothing floats in a corner of the window any more (i-frame-5). */

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [workQueue] = useState(() => new WorkQueue(async (record) => {
    const saved = await saveProject(record);
    setProjects((current) => [saved, ...current.filter((item) => projectQueueKey(item) !== projectQueueKey(saved))]);
    return saved;
  }));
  const workItems = useSyncExternalStore(workQueue.subscribe, workQueue.getSnapshot);
  const weightDownloadActive = useSyncExternalStore(subscribeWeightDownloads, () => getWeightDownloadState()?.active ?? false);
  const queuedDownloads = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  const iconConfirmationCount = useSyncExternalStore(workQueue.subscribe, workQueue.getIconConfirmationCount);
  const [workQueueOpen, setWorkQueueOpen] = useState(false);
  useEffect(() => workQueue.start(), [workQueue]);
  useEffect(() => startWorkerDiscovery(), []);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeProjectInitialView, setActiveProjectInitialView] = useState<ProjectView>("timeline");
  const [workspaceNavigation, setWorkspaceNavigation] = useState<WorkspaceNavigation>();
  const [settingsNavigation, setSettingsNavigation] = useState<SettingsNavigation>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [projectLayout, setProjectLayout] = useState<"grid" | "list">("grid");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [error, setError] = useState<LibraryError | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectFolder, setNewProjectFolder] = useState<NewProjectFolder | null>(null);
  const [newProjectError, setNewProjectError] = useState<string | null>(null);
  const [checkingProjectFolder, setCheckingProjectFolder] = useState(false);
  useEffect(() => {
    if (!newProjectOpen || !newProjectFolder) return;
    let live = true;
    const folderPath = newProjectFolder.folderPath;
    const check = async () => {
      setCheckingProjectFolder(true);
      try {
        const folder = await inspectNewProjectFolder(folderPath);
        if (live) setNewProjectFolder(folder);
      } catch (reason) {
        if (live) setNewProjectFolder({ folderPath, error: describe(reason) });
      } finally { if (live) setCheckingProjectFolder(false); }
    };
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
  }, [newProjectOpen, newProjectFolder?.folderPath]);
  const [projectToDelete, setProjectToDelete] = useState<ProjectRecord | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  /* Settings hides the workspace without unmounting the editor, preserving edits.
     Closing it bumps `settingsRevision`, which is what tells an open project to
     look for the video engine again — the whole point of the screen is fixing
     the engine paths, and the Generator would otherwise go on reporting the
     missing weights the user just pointed it at until they reopened it. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(() => !hasSeenReleaseNotes());
  const [settingsInitialTab, setSettingsInitialTab] = useState<"engine" | "updates">("engine");
  const [updater] = useState(() => new AppUpdater());
  const updateState = useSyncExternalStore(updater.subscribe, updater.getSnapshot);
  const [updateInfoDismissed, setUpdateInfoDismissed] = useState(false);
  useEffect(() => { void updater.start(); }, [updater]);
  const updateGuard = useRef<() => string | null>(() => null);
  updateGuard.current = () => activeProject
    ? "Close your project before installing an update."
    : loading || busy || deletingProject || newProjectOpen || projectToDelete
      ? "Finish the current project action before installing an update."
      : workQueue.updateBlockReason();
  const updateBlockReason = useCallback(() => updateGuard.current(), []);
  const updatePanel = <UpdatePanel updater={updater} blockReason={updateBlockReason} onOpenReleaseNotes={() => setReleaseNotesOpen(true)} />;
  const [settingsRevision, setSettingsRevision] = useState(0);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const queueButton = useRef<HTMLButtonElement>(null);
  const settingsQueueButton = useRef<HTMLButtonElement>(null);
  const openSettings = (tab: "engine" | "updates" = "engine") => {
    setSettingsNavigation(undefined);
    setWorkQueueOpen(false);
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    setSettingsRevision((value) => value + 1);
    requestAnimationFrame(() => settingsButton.current?.focus());
  };
  /* What is installed on this computer. Probed ONCE here rather than every
     time a project opens: it launches two agent CLIs and loads the engine DLL,
     which is seconds of work, and the answer is the same for every project.
     Null means the probe has not landed yet — never "nothing is installed". */
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [cudaNoticeDismissed, setCudaNoticeDismissed] = useState(false);
  const cudaDownload = !cudaNoticeDismissed && isTauri() ? missingCudaDownload(runtime?.slopfab) : null;
  const searchInput = useRef<HTMLInputElement>(null);

  /* ── Exit guard ─────────────────────────────────────────────────────────
     The video engine runs inside this process, so closing the window ends a
     generation outright, and nothing partial is written on the way. Rust asks
     the question itself, as a native message box, when the close button is
     pressed (src-tauri/src/window.rs); all the page does is keep it told
     which jobs would be lost. Icons are not on the list: they can be
     interrupted safely. */
  const guardJobs: GuardJob[] = workItems
    .filter((item) => item.kind !== "reference-icons" && isWorkActive(item))
    .map((item) => ({ title: `${item.title} · ${item.projectName}`, running: item.status !== "queued" }));
  /* An export keeps running when its tab (or its project) is left, and
     closing the window ends it just the same, so it is on the list too. */
  const exports = useExportActivity();
  for (const job of exports.filter(isExportActive)) guardJobs.push({ title: `Export ${job.projectName ?? ""}`, running: job.status === "running" });
  const guardKey = JSON.stringify(guardJobs);
  useEffect(() => {
    void reportGenerationJobs(JSON.parse(guardKey) as GuardJob[]).catch(() => undefined);
  }, [guardKey]);
  const queueCount = guardJobs.length + Number(weightDownloadActive) + queuedDownloads.length;
  /* Something is being worked on right now, not merely waiting its turn:
     a generation or icon past the queue, an export, a weight download. */
  const queueBusy = weightDownloadActive || exports.some((job) => job.status === "running")
    || workItems.some((item) => isWorkActive(item) && item.status !== "queued");

  useEffect(() => {
    void listRecentProjects()
      .then(({ projects: loaded, unreadable }) => {
        // Keep everything that loaded: one unreadable project must not hide the
        // rest. But it must not disappear in silence either — it used to be
        // dropped from this list with no message at all.
        setProjects(loaded);
        if (unreadable.length === 0) return;
        writeDiagnostic("warn", "app", "projects.partially_loaded", "Some recent project files could not be read.", { unreadableCount: unreadable.length, loadedCount: loaded.length });
        setError({
          title: unreadable.length === 1 ? "This project file couldn’t be read" : `${unreadable.length} project files couldn’t be read`,
          detail: unreadable.map((item) => `${item.folderPath} — ${item.detail}`).join(" · "),
        });
      })
      .catch((reason: unknown) => {
        logFailure("projects.load_failed", reason);
        setError({ title: "Couldn’t load your projects", detail: describe(reason) });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Re-probed when the settings page closes, because that is where the
    // engine paths get fixed.
    let live = true;
    setRuntime(null);
    void getRuntimeStatus()
      .then((status) => { if (live) setRuntime(status); })
      .catch((reason: unknown) => {
        if (!live) return;
        logFailure("runtime.probe_failed", reason);
        setError({ title: "Couldn’t check what’s installed on this computer", detail: describe(reason) });
      });
    return () => { live = false; };
  }, [settingsRevision]);

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter(({ config, folderPath }) =>
      `${config.name} ${config.brief.prompt} ${folderPath}`.toLowerCase().includes(normalized),
    );
  }, [projects, query]);

  const showLibraryHeading = projects.length > 0;

  const openProject = (project: ProjectRecord, view: ProjectView = project.config.generationType === "image" ? "editor" : "timeline") => {
    setWorkspaceNavigation(undefined);
    setWorkQueueOpen(false);
    setSelectedKey(projectQueueKey(project));
    setActiveProjectInitialView(view);
    setActiveProject(project);
  };

  const navigateFromQueue = (target: WorkQueueTarget) => {
    if (target.kind === "download") {
      openSettings();
      setSettingsNavigation({ templateId: target.download.templateId, loraId: target.download.loraId });
      return;
    }
    const record = target.kind === "work" ? workQueue.projectRecord(target.item.projectKey)
      : [activeProject, ...projects].find((record) => record?.folderPath === target.folderPath);
    if (!record) return;
    let navigation: WorkspaceNavigation = { view: "export", ...(target.kind === "export" ? { exportKind: target.exportKind ?? "video" } : {}) };
    if (target.kind === "work") {
      const item = target.item;
      if (item.kind === "image") {
        const imageId = [item.imageDraftId, item.id, item.imageAssetId].find((id) => record.config.assets.some((asset) => asset.kind === "image" && asset.id === id));
        navigation = { view: "editor", imageId: imageId ?? undefined };
      } else if (item.kind === "refmod" || item.kind === "reference-icons") {
        navigation = { view: "references", referenceId: item.sceneId };
      } else navigation = { view: "generator", sceneId: item.sceneId };
    }
    if (settingsOpen) { setSettingsOpen(false); setSettingsRevision((value) => value + 1); }
    openProject(record, navigation.view);
    setWorkspaceNavigation(navigation);
  };

  const openFromFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const project = await chooseAndOpenProject();
      if (!project) return;
      setProjects((current) => [project, ...current.filter((item) => item.config.id !== project.config.id)]);
      openProject(project);
    } catch (reason) {
      logFailure("project.open_failed", reason);
      setError({ title: "Couldn’t open that folder", detail: describe(reason) });
    } finally {
      setBusy(false);
    }
  };

  const chooseCreationFolder = async () => {
    if (!isTauri()) { setNewProjectOpen(true); return; }
    setBusy(true); setError(null); setNewProjectError(null);
    try {
      const folder = await chooseNewProjectFolder();
      if (folder) { setNewProjectFolder(folder); setNewProjectOpen(true); }
    } catch (reason) {
      if (newProjectOpen) setNewProjectError(describe(reason));
      else setError({ title: "Couldn’t select a project folder", detail: describe(reason) });
    } finally { setBusy(false); setCheckingProjectFolder(false); }
  };

  const createFromPrompt = async (input: CreateProjectInput) => {
    setBusy(true);
    setNewProjectError(null);
    try {
      if (newProjectFolder) {
        const checked = await inspectNewProjectFolder(newProjectFolder.folderPath);
        setNewProjectFolder(checked);
        if (checked.error) return;
      }
      const project = await createProject({ ...input, ...(newProjectFolder ? { projectDirectory: newProjectFolder.folderPath } : {}) });
      if (!project) return;
      setProjects((current) => [project, ...current]);
      setNewProjectOpen(false);
      // Creative direction begins with the Agent; project creation only
      // establishes the empty workspace and its format, so the new project
      // opens with the agent pane showing.
      openProject(project, "agent");
    } catch (reason) {
      logFailure("project.create_failed", reason);
      setNewProjectError(describe(reason));
      if (newProjectFolder) {
        try { setNewProjectFolder(await inspectNewProjectFolder(newProjectFolder.folderPath)); } catch { /* Keep the creation error visible. */ }
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteNow = async (target: ProjectRecord) => {
    if (deletingProject) return;
    setDeletingProject(true);
    setError(null);
    try {
      if (workQueue.hasActiveProject(target) || exports.some((job) => job.folderPath === target.folderPath && isExportActive(job))) throw new Error("Cancel or finish this project’s work before deleting it.");
      await deleteProject(target);
      workQueue.forgetProject(target);
      setProjects((current) => current.filter((project) => project.config.id !== target.config.id || project.folderPath !== target.folderPath));
      setProjectToDelete(null);
    } catch (reason) {
      logFailure("project.delete_failed", reason, { projectId: target.config.id });
      setProjectToDelete(null);
      setError({ title: "Couldn’t delete that project", detail: describe(reason) });
    } finally {
      setDeletingProject(false);
    }
  };

  /* A yes/no question, so the desktop app asks it with the system's message
     box; the browser build falls back to the same question as a dialog. */
  const requestDelete = async (project: ProjectRecord) => {
    if (!canConfirmNatively()) { setProjectToDelete(project); return; }
    if (await confirmProjectDeletionNatively(project)) await deleteNow(project);
  };

  const revealProject = (project: ProjectRecord) => {
    void revealInExplorer(project.folderPath).catch((reason: unknown) => {
      setError({ title: "Couldn’t show the project folder", detail: describe(reason) });
    });
  };

  /* ── Accelerators (i-frame-4) ─────────────────────────────────────────── */
  const inLibrary = !activeProject && !settingsOpen;
  useShortcut("Ctrl+,", () => openSettings(), { enabled: !settingsOpen, allowInInput: true });
  useShortcut("Ctrl+N", () => { if (!busy) void chooseCreationFolder(); }, { enabled: inLibrary, allowInInput: true });
  useShortcut("Ctrl+O", () => { if (!busy) void openFromFolder(); }, { enabled: inLibrary, allowInInput: true });
  useShortcut("Ctrl+F", () => { searchInput.current?.focus(); searchInput.current?.select(); }, { enabled: inLibrary, allowInInput: true });
  useShortcut("Alt+ArrowLeft", closeSettings, { enabled: settingsOpen });

  const queueFlyout = <WorkQueuePanel queue={workQueue} items={workItems} open={workQueueOpen} anchor={settingsOpen ? settingsQueueButton : queueButton} onClose={() => setWorkQueueOpen(false)} onNavigate={navigateFromQueue} />;
  const releaseNotesDialog = releaseNotesOpen ? <ReleaseNotesDialog onClose={() => setReleaseNotesOpen(false)} /> : null;
  const cudaNotice = cudaDownload && !releaseNotesOpen && !settingsOpen && !workQueueOpen && !projectToDelete && !newProjectOpen
    ? <CudaSetupDialog download={cudaDownload} onContinue={() => setCudaNoticeDismissed(true)} /> : null;
  const iconConfirmation = iconConfirmationCount > 0 && !releaseNotesOpen && !cudaNotice && !settingsOpen && !workQueueOpen && !projectToDelete && !newProjectOpen
    ? <ReferenceIconGenerationDialog count={iconConfirmationCount} onAnswer={workQueue.answerIconConfirmation} /> : null;

  const queueTrigger = (ref: RefObject<HTMLButtonElement>) => (
    <button ref={ref} type="button" className={`icon-button titlebar-command${queueBusy ? " icon-button--busy" : ""}`} onClick={() => setWorkQueueOpen((open) => !open)}
      aria-label="Work queue" aria-haspopup="dialog" aria-expanded={workQueueOpen} aria-busy={queueBusy} data-tooltip={queueCount ? `Work queue · ${queueCount} running or queued` : queueBusy ? "Work queue · working" : "Work queue"}>
      <WorkQueue16 aria-hidden="true" />
      {queueCount > 0 && <InfoBadge className="titlebar-command__badge" value={queueCount} />}
    </button>
  );
  const shellActions = <>
    <button ref={settingsButton} type="button" className="icon-button titlebar-command" onClick={() => openSettings(updateNeedsAttention(updateState.stage) ? "updates" : "engine")}
      aria-label="Settings" data-tooltip={updateNeedsAttention(updateState.stage) ? "Settings · update available" : "Settings"} data-tooltip-shortcut="Ctrl+," aria-keyshortcuts="Control+,">
      <Settings16 aria-hidden="true" />
      {updateNeedsAttention(updateState.stage) && <InfoBadge className="titlebar-command__badge titlebar-command__badge--dot" />}
    </button>
    {queueTrigger(queueButton)}
  </>;

  /* Settings is a page of its own under its own title bar, not an overlay.
     The screen behind it stays mounted and hidden, so an open project keeps
     its unsaved edits, the agent its draft, and the library its search. */
  const settingsPage = settingsOpen ? (
    <div className="app-screen">
      <SettingsView providers={runtime?.providers ?? CHECKING_PROVIDERS} onClose={closeSettings} updates={updatePanel} initialTab={settingsInitialTab} navigation={settingsNavigation} titleBarActions={queueTrigger(settingsQueueButton)} />
    </div>
  ) : null;

  if (activeProject) {
    return <div className="app-shell">
      <div className="app-screen" hidden={settingsOpen}>
        <ProjectWorkspace
          key={projectQueueKey(activeProject)}
          project={activeProject}
          initialView={activeProjectInitialView}
          navigation={workspaceNavigation}
          onNavigated={() => setWorkspaceNavigation(undefined)}
          runtime={runtime}
          workQueue={workQueue}
          active={!settingsOpen}
          titleBarActions={shellActions}
          onGeneratorRuntimeChange={(slopfab) => setRuntime((current) => ({ providers: current?.providers ?? CHECKING_PROVIDERS, slopfab }))}
          onBack={() => setActiveProject(null)}
          onSave={async () => { await workQueue.project(activeProject).save(); }}
        />
      </div>
      {settingsPage}
      {queueFlyout}
      {iconConfirmation}
      {cudaNotice}
      {releaseNotesDialog}
    </div>;
  }

  /* Library keyboard: the tiles are one listbox with a roving tab stop.
     Arrows move (Up/Down by a row of the grid), Home/End jump, Enter opens,
     Delete asks to delete. */
  const selectedIndex = filteredProjects.findIndex((project) => projectQueueKey(project) === selectedKey);
  const focusTile = (index: number, grid: HTMLElement) => {
    const project = filteredProjects[index];
    if (!project) return;
    setSelectedKey(projectQueueKey(project));
    grid.querySelectorAll<HTMLElement>("[role=option]")[index]?.focus();
  };
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=option]")];
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const columns = projectLayout === "list" ? 1 : Math.max(1, tiles.filter((tile) => tile.offsetTop === tiles[0].offsetTop).length);
    let next: number | undefined;
    if (event.key === "ArrowRight") next = Math.min(tiles.length - 1, at + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (event.key === "ArrowDown") next = Math.min(tiles.length - 1, at + columns);
    else if (event.key === "ArrowUp") next = Math.max(0, at - columns);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tiles.length - 1;
    else if (event.key === "Delete" && filteredProjects[at]) { event.preventDefault(); void requestDelete(filteredProjects[at]); return; }
    if (next === undefined) return;
    event.preventDefault();
    focusTile(next, event.currentTarget);
  };

  const showUpdateInfo = ["downloading", "installing", "restart"].includes(updateState.stage) || (updateState.stage === "available" && !updateInfoDismissed);
  const newProjectButton = (
    <button type="button" className="primary-button" disabled={busy} onClick={() => void chooseCreationFolder()} data-tooltip="New project" data-tooltip-shortcut="Ctrl+N" aria-keyshortcuts="Control+N">
      <Add16 aria-hidden="true" /> New project
    </button>
  );

  return (
    <div className="app-shell">
      <div className="app-screen" hidden={settingsOpen}>
        <TitleBar title="Slopus" secondary={`v${APP_VERSION} - ${APP_CHANNEL}`} actions={shellActions}>
          {/* Search sits in the middle of the title bar, as in Windows Settings. */}
          <TextField
            className="titlebar-search"
            inputRef={searchInput}
            type="search"
            value={query}
            onChange={setQuery}
            placeholder="Search projects"
            aria-label="Search projects"
            aria-keyshortcuts="Control+F"
            icon={<Search16 />}
          />
        </TitleBar>
        <main className="library" aria-labelledby="library-title">
          <div className="library__head">
            {/* The title and the library's commands share one line. */}
            <div className="library__title-row">
              <h1 id="library-title" className="library__title">Projects</h1>
              <CommandBar aria-label="Library commands" className="library__commands">
                {newProjectButton}
                <CommandBarButton icon={<FolderOpen16 />} label="Open…" showLabel tooltip="Open project" shortcut="Ctrl+O" aria-label="Open project" disabled={busy} onClick={() => void openFromFolder()} />
              </CommandBar>
            </div>
            {(error || showUpdateInfo) && <div className="library__infobars">
              {showUpdateInfo && <UpdateInfoBar updater={updater} onOpen={() => openSettings("updates")} onDismiss={() => setUpdateInfoDismissed(true)} />}
              {error && <InfoBar severity="error" title={error.title} message={error.detail} onClose={() => setError(null)} />}
            </div>}
          </div>
          {/* The list's heading row is a chrome strip with the layout toggle at
              its end; the tiles scroll on the pane under it. An empty library
              says so in its empty state, so it has no strip: a heading counting
              "0 projects" would only repeat that. */}
          {showLibraryHeading && <div className="library__bar">
            <h2 id="all-projects-heading" className="library__subtitle">
              {query.trim() ? "Results" : "All projects"} <span className="library__count">{filteredProjects.length} {filteredProjects.length === 1 ? "project" : "projects"}</span>
            </h2>
            <div className="library__layout" role="group" aria-label="Project layout">
              <CommandBarButton icon={projectLayout === "grid" ? <GridView16Filled /> : <GridView16 />} label="Grid view" pressed={projectLayout === "grid"} onClick={() => setProjectLayout("grid")} />
              <CommandBarButton icon={projectLayout === "list" ? <ListView16Filled /> : <ListView16 />} label="List view" pressed={projectLayout === "list"} onClick={() => setProjectLayout("list")} />
            </div>
          </div>}

          <section className="library__section" {...(showLibraryHeading ? { "aria-labelledby": "all-projects-heading" } : { "aria-label": "All projects" })}>
            {loading ? (
              <div className={`project-grid project-grid--${projectLayout}`} aria-busy="true">{[0, 1, 2].map((item) => <div className="project-skeleton" key={item}><i /><span /><small /></div>)}</div>
            ) : filteredProjects.length ? (
              <div className={`project-grid project-grid--${projectLayout}`} role="listbox" aria-label="Projects" onKeyDown={onGridKeyDown}>
                {filteredProjects.map((project, index) => {
                  const key = projectQueueKey(project);
                  const selected = key === selectedKey;
                  return <ProjectCard
                    key={`${project.config.id}-${project.folderPath}`}
                    project={project}
                    layout={projectLayout}
                    selected={selected}
                    tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
                    onSelect={(chosen) => setSelectedKey(projectQueueKey(chosen))}
                    onOpen={(chosen) => openProject(chosen)}
                    onDelete={(chosen) => void requestDelete(chosen)}
                    onReveal={isTauri() ? revealProject : undefined}
                  />;
                })}
              </div>
            ) : query ? (
              /* The compact shared empty state: only the first-run hero below
                 is large. */
              <EmptyState
                icon={<Search32 />}
                title={`No results for “${query}”`}
                description="Search looks at project names, descriptions and folders."
                action={<button type="button" className="secondary-button" onClick={() => setQuery("")}>Clear search</button>}
              />
            ) : (
              <div className="library-empty">
                <FolderOpen48 aria-hidden="true" />
                <h3>No projects yet</h3>
                <p>Create a project or open an existing project folder.</p>
                <div className="library-empty__actions">
                  {newProjectButton}
                  <button type="button" className="secondary-button" disabled={busy} onClick={() => void openFromFolder()}><FolderOpen16 aria-hidden="true" /> Open project…</button>
                </div>
              </div>
            )}
          </section>
        </main>
        {newProjectOpen && <PromptComposer busy={busy} folderPath={newProjectFolder?.folderPath} folderError={newProjectFolder?.error} checkingFolder={checkingProjectFolder} onChooseFolder={chooseCreationFolder} error={newProjectError} onCreate={createFromPrompt} onClose={() => { setNewProjectOpen(false); setNewProjectFolder(null); setNewProjectError(null); }} />}
      </div>
      {settingsPage}
      {queueFlyout}
      {projectToDelete && <DeleteProjectDialog project={projectToDelete} deleting={deletingProject} onConfirm={() => void deleteNow(projectToDelete)} onCancel={() => setProjectToDelete(null)} />}
      {iconConfirmation}
      {cudaNotice}
      {releaseNotesDialog}
    </div>
  );
}

export default App;
