import { BookImage, FolderOpen, Grid2X2, List, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyPlaceholder } from "./components/EmptyPlaceholder";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace, type ProjectView } from "./components/ProjectWorkspace";
import { PromptComposer } from "./components/PromptComposer";
import { Sidebar, type WorkspaceView } from "./components/Sidebar";
import { chooseAndOpenProject, createProject, listRecentProjects, saveProject } from "./lib/persistence";
import type { CreateProjectInput, ProjectRecord } from "./lib/project";

interface LibraryError {
  /** What failed, in the user's terms. */
  title: string;
  /** The underlying message, kept verbatim so it stays diagnosable. */
  detail: string;
}

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning.";
  if (hour < 18) return "Good afternoon.";
  return "Good evening.";
}

function App() {
  const [view, setView] = useState<WorkspaceView>("library");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeProjectInitialView, setActiveProjectInitialView] = useState<ProjectView>("timeline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [projectLayout, setProjectLayout] = useState<"grid" | "list">("grid");
  const [error, setError] = useState<LibraryError | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listRecentProjects()
      .then(setProjects)
      .catch((reason: unknown) => setError({ title: "Couldn’t load your projects", detail: describe(reason) }))
      .finally(() => setLoading(false));
  }, []);

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

  const navigate = (nextView: WorkspaceView) => {
    // Generating and references only exist inside a project. Rather than
    // dead-ending on a placeholder, open the most recent project on that tab.
    // With no projects yet, the placeholder is the honest answer.
    const projectTab = nextView === "generate" ? "generator" : nextView === "references" ? "references" : null;
    if (projectTab && projects.length > 0) {
      setActiveProjectInitialView(projectTab);
      setActiveProject(projects[0]);
      setView("library");
      return;
    }
    setActiveProject(null);
    setView(nextView);
  };

  if (activeProject) {
    return <ProjectWorkspace project={activeProject} initialView={activeProjectInitialView} onBack={() => setActiveProject(null)} onSave={async (project) => {
      const saved = await saveProject(project);
      setActiveProject(saved);
      setProjects((current) => [saved, ...current.filter((item) => item.config.id !== saved.config.id)]);
    }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onNavigate={navigate} />
      {view === "generate" && <EmptyPlaceholder title="Generation workspace" copy="Generating shots happens inside a project, so every clip, prompt, and setting stays with the footage it belongs to." icon={Sparkles} onBack={() => navigate("library")} />}
      {view === "references" && <EmptyPlaceholder title="Reference library" copy="References live inside a project, keeping characters, products, and style consistent across every shot in it." icon={BookImage} onBack={() => navigate("library")} />}
      {view === "library" && (
        <main className="library">
          <header className="library__topbar">
            <div className="search-field"><Search size={17} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" /><kbd>Ctrl K</kbd></div>
            <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={17} /> Open project folder</button>
          </header>
          <div className="library__content">
            <div className="library__intro">
              <div>
                <p className="eyebrow">Project library</p>
                <h1>{greeting()}</h1>
                <p>Describe the video you want below. Pol Studio sets up a project you can edit, and keeps every file in a folder you own.</p>
              </div>
              <span className="storage-pill"><i /> Saved on this computer</span>
            </div>
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
                  <p>Describe your video in the box above and press <strong>Create project</strong>. Pol Studio makes the folder, the settings, and a first scene for you.</p>
                  <p className="library-empty__aside">Already made one on this computer?</p>
                  <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={17} /> Open project folder</button>
                </div>
              )}
            </section>
            <footer className="library__footer">Every project is an ordinary folder on this computer — you can move, copy, or back it up like any other files.</footer>
          </div>
        </main>
      )}
      {error && <div className="toast" role="alert"><strong>{error.title}</strong><span>{error.detail}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    </div>
  );
}

export default App;
