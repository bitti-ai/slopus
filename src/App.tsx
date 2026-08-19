import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FolderOpen, Grid2X2, List, Search, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Brand } from "./components/Brand";
import { ExitGuardDialog, type OngoingGeneration } from "./components/ExitGuardDialog";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace, type ProjectView } from "./components/ProjectWorkspace";
import { PromptComposer } from "./components/PromptComposer";
import { SettingsView } from "./components/SettingsView";
import { chooseAndOpenProject, createProject, isTauri, listRecentProjects, saveProject } from "./lib/persistence";
import type { CreateProjectInput, ProjectRecord } from "./lib/project";
import { getRuntimeStatus, type RuntimeStatus } from "./lib/runtime";

interface LibraryError {
  /** What failed, in the user’s terms. */
  title: string;
  /** The underlying message, kept verbatim so it stays diagnosable. */
  detail: string;
}

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeProjectInitialView, setActiveProjectInitialView] = useState<ProjectView>("timeline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [projectLayout, setProjectLayout] = useState<"grid" | "list">("grid");
  const [error, setError] = useState<LibraryError | null>(null);
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
     generation outright, and nothing partial is written on the way. The open
     project reports what it has running; Rust holds the close request back
     only while that list is non-empty, and this is where the question is put
     and answered. See the fenced block in src-tauri/src/lib.rs. */
  const [ongoingGenerations, setOngoingGenerations] = useState<OngoingGeneration[]>([]);
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
    ? <ExitGuardDialog jobs={ongoingGenerations} destination="quit" onConfirm={() => answerClose(true)} onCancel={() => answerClose(false)} />
    : null;

  useEffect(() => {
    void listRecentProjects()
      .then(({ projects: loaded, unreadable }) => {
        // Keep everything that loaded: one unreadable project must not hide the
        // rest. But it must not disappear in silence either — it used to be
        // dropped from this list with no message at all.
        setProjects(loaded);
        if (unreadable.length === 0) return;
        setError({
          title: unreadable.length === 1 ? "This project file couldn’t be read" : `${unreadable.length} project files couldn’t be read`,
          detail: unreadable.map((item) => `${item.folderPath} — ${item.detail}`).join(" · "),
        });
      })
      .catch((reason: unknown) => setError({ title: "Couldn’t load your projects", detail: describe(reason) }))
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
      setActiveProjectInitialView("generator");
      setActiveProject(project);
    } catch (reason) {
      setError({ title: "Couldn’t create that project", detail: describe(reason) });
    } finally {
      setBusy(false);
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

  if (activeProject) {
    return <>
      <ProjectWorkspace project={activeProject} initialView={activeProjectInitialView} runtime={runtime} onOngoingGenerationsChange={setOngoingGenerations} onBack={() => setActiveProject(null)} onSave={async (project) => {
        const saved = await saveProject(project);
        setActiveProject(saved);
        setProjects((current) => [saved, ...current.filter((item) => item.config.id !== saved.config.id)]);
      }} />
      {settingsLauncher}
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
        </header>
        <div className="library__content">
          <PromptComposer busy={busy} onCreate={createFromPrompt} />

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
              <div className={`project-grid project-grid--${projectLayout}`}>{filteredProjects.map((project, index) => <ProjectCard key={`${project.config.id}-${project.folderPath}`} project={project} index={index} onOpen={(selected) => { setActiveProjectInitialView("timeline"); setActiveProject(selected); }} />)}</div>
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
                <p>Describe your video in the box above and press <strong>Create project</strong>. PolStudio makes the folder, the settings, and a first scene for you.</p>
                <p className="library-empty__aside">Already made one on this computer?</p>
                <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={17} /> Open project</button>
              </div>
            )}
          </section>
        </div>
      </main>
      {settingsLauncher}
      {settingsOpen && <SettingsView onClose={closeSettings} />}
      {exitGuard}
      {error && <div className="toast" role="alert"><strong>{error.title}</strong><span>{error.detail}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    </div>
  );
}

export default App;
