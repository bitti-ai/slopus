import { WorkQueue, isWorkActive, projectQueueKey } from "./lib/workQueue";
import { WorkQueuePanel } from "./components/WorkQueuePanel";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FolderOpen, Grid2X2, List, ListTodo, Plus, Search, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Brand } from "./components/Brand";
import { DeleteProjectDialog } from "./components/DeleteProjectDialog";
import { ExitGuardDialog, type OngoingGeneration } from "./components/ExitGuardDialog";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace, type ProjectView } from "./components/ProjectWorkspace";
import { PromptComposer } from "./components/PromptComposer";
import { SettingsView } from "./components/SettingsView";
import { describeDiagnosticError, errorContext, writeDiagnostic } from "./lib/diagnostics";
import { chooseAndOpenProject, createProject, deleteProject, isTauri, listRecentProjects, saveProject } from "./lib/persistence";
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

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [workQueue] = useState(() => new WorkQueue(async (record) => {
    const saved = await saveProject(record);
    setProjects((current) => [saved, ...current.filter((item) => projectQueueKey(item) !== projectQueueKey(saved))]);
    return saved;
  }));
  const workItems = useSyncExternalStore(workQueue.subscribe, workQueue.getSnapshot);
  const [workQueueOpen, setWorkQueueOpen] = useState(false);
  useEffect(() => workQueue.start(), [workQueue]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeProjectInitialView, setActiveProjectInitialView] = useState<ProjectView>("timeline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [projectLayout, setProjectLayout] = useState<"grid" | "list">("grid");
  const [error, setError] = useState<LibraryError | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<ProjectRecord | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  /* Settings is an overlay rather than a view of its own so opening it from
     inside a project cannot unmount the editor and throw away unsaved edits.
     Closing it bumps `settingsRevision`, which is what tells an open project to
     look for the video engine again — the whole point of the screen is fixing
     the engine paths, and the Generator would otherwise go on reporting the
     missing weights the user just pointed it at until they reopened it. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const closeSettings = () => { setSettingsOpen(false); setSettingsRevision((value) => value + 1); };
  /* What is installed on this computer. Probed ONCE here rather than every
     time a project opens: it launches two agent CLIs and loads the engine DLL,
     which is seconds of work, and the answer is the same for every project.
     Null means the probe has not landed yet — never "nothing is installed". */
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  /* ── Exit guard: the window's close button ───────────────────────────────
     The video engine runs inside this process, so closing the window ends a
     generation outright, and nothing partial is written on the way. The app
     queue reports work across all projects; Rust holds the close request back
     only while that list is non-empty, and this is where the question is put
     and answered. See the fenced block in src-tauri/src/lib.rs. */
  const ongoingGenerations: OngoingGeneration[] = workItems.filter(isWorkActive).map((item) => ({ id: item.id, title: `${item.title} · ${item.projectName}`, running: item.status !== "queued" }));
  const [closeRequested, setCloseRequested] = useState(false);

  const answerClose = useCallback((confirmed: boolean) => {
    setCloseRequested(false);
    if (isTauri()) void invoke("answer_app_close", { confirmed }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void invoke("set_generation_active", { active: ongoingGenerations.length > 0 }).catch(() => undefined);
  }, [ongoingGenerations.length]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscription = listen("app-close-requested", () => { if (!disposed) setCloseRequested(true); });
    return () => { disposed = true; void subscription.then((stop) => stop()).catch(() => undefined); };
  }, []);

  /* The last shot can finish between the click on the close button and this
     question reaching the screen. There is then nothing to warn about, and a
     dialog listing no shots would be the app refusing to close for no reason. */
  useEffect(() => {
    if (closeRequested && ongoingGenerations.length === 0) answerClose(true);
  }, [closeRequested, ongoingGenerations.length, answerClose]);

  const exitGuard = closeRequested && ongoingGenerations.length > 0
    ? <ExitGuardDialog jobs={ongoingGenerations} onConfirm={() => answerClose(true)} onCancel={() => answerClose(false)} />
    : null;

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
    // Re-probed when the settings overlay closes, because that is where the
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

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return projects;
    return projects.filter(({ config, folderPath }) =>
      `${config.name} ${config.brief.prompt} ${folderPath}`.toLowerCase().includes(normalized),
    );
  }, [projects, query]);

  const openFromFolder = async () => {
    setError(null);
    try {
      const project = await chooseAndOpenProject();
      if (!project) return;
      setProjects((current) => [project, ...current.filter((item) => item.config.id !== project.config.id)]);
      setActiveProjectInitialView("timeline");
      setActiveProject(project);
    } catch (reason) {
      logFailure("project.open_failed", reason);
      setError({ title: "Couldn’t open that folder", detail: describe(reason) });
    }
  };

  const createFromPrompt = async (input: CreateProjectInput) => {
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(input);
      if (!project) return;
      setProjects((current) => [project, ...current]);
      setNewProjectOpen(false);
      // Creative direction now begins in the Agent page; project creation only
      // establishes the empty workspace and its format.
      setActiveProjectInitialView("agent");
      setActiveProject(project);
    } catch (reason) {
      logFailure("project.create_failed", reason);
      setError({ title: "Couldn’t create that project", detail: describe(reason) });
    } finally {
      setBusy(false);
    }
  };

  const confirmProjectDeletion = async () => {
    if (!projectToDelete || deletingProject) return;
    const target = projectToDelete;
    setDeletingProject(true);
    setError(null);
    try {
      if (workQueue.hasActiveProject(target)) throw new Error("Cancel or finish this project’s work before deleting it.");
      await deleteProject(target);
      workQueue.forgetProject(target);
      setProjects((current) => current.filter((project) => project.config.id !== target.config.id || project.folderPath !== target.folderPath));
      setProjectToDelete(null);
    } catch (reason) {
      logFailure("project.delete_failed", reason, { projectId: target.config.id });
      setError({ title: "Couldn’t delete that project", detail: describe(reason) });
    } finally {
      setDeletingProject(false);
    }
  };

  /* Anchored bottom-left in every view, project editor included: the engine
     paths it holds are what makes generation work at all, and finding out they
     are wrong happens inside a project, not in the library. */
  const settingsLauncher = (
    <button className="settings-launcher" type="button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
      <Settings size={22} aria-hidden="true" />
    </button>
  );

  const queueLauncher = <button className="settings-launcher work-queue-launcher" type="button" onClick={() => setWorkQueueOpen(true)} title="Work Queue" aria-label="Work Queue" aria-haspopup="dialog" aria-expanded={workQueueOpen}>
    <ListTodo size={22} aria-hidden="true" />{ongoingGenerations.length > 0 && <b>{ongoingGenerations.length}</b>}
  </button>;
  const queuePanel = workQueueOpen ? <WorkQueuePanel queue={workQueue} items={workItems} onClose={() => setWorkQueueOpen(false)} /> : null;

  if (activeProject) {
    return <>
      <ProjectWorkspace key={projectQueueKey(activeProject)} project={activeProject} initialView={activeProjectInitialView} runtime={runtime} workQueue={workQueue} onGeneratorRuntimeChange={(slopfab) => setRuntime((current) => ({ providers: current?.providers ?? CHECKING_PROVIDERS, slopfab }))} onBack={() => setActiveProject(null)} onSave={async () => { await workQueue.project(activeProject).save(); }} />
      {settingsLauncher}
      {queueLauncher}
      {queuePanel}
      {settingsOpen && <SettingsView onClose={closeSettings} />}
      {exitGuard}
    </>;
  }

  return (
    <div className="app-shell">
      <main className="library">
        <header className="library__topbar">
          <Brand />
          <div className="search-field"><Search size={17} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" /><kbd>Ctrl K</kbd></div>
          <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={17} /> Open project</button>
          <button className="primary-button" onClick={() => setNewProjectOpen(true)}><Plus size={17} /> New project</button>
        </header>
        <div className="library__content">
          <section className="recent-projects" aria-labelledby="recent-heading">
            <div className="section-heading">
              <div>
                <h2 id="recent-heading">Your projects</h2>
                <span>{filteredProjects.length} {filteredProjects.length === 1 ? "project" : "projects"}</span>
              </div>
              <div className="view-controls" aria-label="Project layout">
                <button className={`icon-button ${projectLayout === "grid" ? "icon-button--active" : ""}`} aria-label="Grid view" aria-pressed={projectLayout === "grid"} onClick={() => setProjectLayout("grid")}><Grid2X2 size={17} /></button>
                <button className={`icon-button ${projectLayout === "list" ? "icon-button--active" : ""}`} aria-label="List view" aria-pressed={projectLayout === "list"} onClick={() => setProjectLayout("list")}><List size={17} /></button>
              </div>
            </div>
            {loading ? (
              <div className="project-grid">{[0, 1, 2].map((item) => <div className="project-skeleton" key={item}><i /><span /><small /></div>)}</div>
            ) : filteredProjects.length ? (
              <div className={`project-grid project-grid--${projectLayout}`}>{filteredProjects.map((project, index) => <ProjectCard key={`${project.config.id}-${project.folderPath}`} project={project} index={index} onOpen={(selected) => { setActiveProjectInitialView("timeline"); setActiveProject(selected); }} onDelete={setProjectToDelete} />)}</div>
            ) : query ? (
              <div className="library-empty">
                <FolderOpen size={28} />
                <h3>Nothing matches “{query}”</h3>
                <p>Search looks at project names, descriptions, and folder paths. Try a shorter word, or clear the search to see everything.</p>
                <button className="secondary-button" onClick={() => setQuery("")}>Clear search</button>
              </div>
            ) : (
              <div className="library-empty">
                <FolderOpen size={28} />
                <h3>No projects yet</h3>
                <p>Create a project, then tell the Agent what you want to make.</p>
                <p className="library-empty__aside">Already made one on this computer?</p>
                <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={17} /> Open project</button>
              </div>
            )}
          </section>
        </div>
      </main>
      {settingsLauncher}
      {queueLauncher}
      {queuePanel}
      {newProjectOpen && <PromptComposer busy={busy} onCreate={createFromPrompt} onClose={() => setNewProjectOpen(false)} />}
      {settingsOpen && <SettingsView onClose={closeSettings} />}
      {projectToDelete && <DeleteProjectDialog project={projectToDelete} deleting={deletingProject} onConfirm={() => void confirmProjectDeletion()} onCancel={() => setProjectToDelete(null)} />}
      {exitGuard}
      {error && <div className="toast" role="alert"><strong>{error.title}</strong><span>{error.detail}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    </div>
  );
}

export default App;
