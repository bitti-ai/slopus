import { BookImage, FolderOpen, Grid2X2, List, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyPlaceholder } from "./components/EmptyPlaceholder";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { PromptComposer } from "./components/PromptComposer";
import { Sidebar, type WorkspaceView } from "./components/Sidebar";
import { chooseAndOpenProject, createProject, listRecentProjects, saveProject } from "./lib/persistence";
import type { CreateProjectInput, ProjectRecord } from "./lib/project";

function App() {
  const [view, setView] = useState<WorkspaceView>("library");
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [projectLayout, setProjectLayout] = useState<"grid" | "list">("grid");
  const [error, setError] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listRecentProjects()
      .then(setProjects)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
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
      setActiveProject(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const createFromPrompt = async (input: CreateProjectInput) => {
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(input);
      if (!project) return;
      setProjects((current) => [project, ...current]);
      setActiveProject(project);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const navigate = (nextView: WorkspaceView) => {
    setActiveProject(null);
    setView(nextView);
  };

  if (activeProject) {
    return <ProjectWorkspace project={activeProject} onBack={() => setActiveProject(null)} onSave={async (project) => {
      const saved = await saveProject(project);
      setActiveProject(saved);
      setProjects((current) => [saved, ...current.filter((item) => item.config.id !== saved.config.id)]);
    }} />;
  }

  return (
    <div className="app-shell">
      <Sidebar view={view} onNavigate={navigate} />
      {view === "generate" && <EmptyPlaceholder title="Generation workspace" copy="Model controls, generation jobs, and variation review are coming into focus. Start from a project brief today." icon={Sparkles} onBack={() => navigate("library")} />}
      {view === "references" && <EmptyPlaceholder title="Reference library" copy="Keep visual references, characters, products, and style guides consistent across every shot." icon={BookImage} onBack={() => navigate("library")} />}
      {view === "library" && (
        <main className="library">
          <header className="library__topbar">
            <div className="search-field"><Search size={16} /><input ref={searchInput} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" /><kbd>Ctrl K</kbd></div>
            <button className="secondary-button" onClick={() => void openFromFolder()}><FolderOpen size={15} /> Open project folder</button>
          </header>
          <div className="library__content">
            <div className="library__intro">
              <div><p className="eyebrow">Project library</p><h1>Good {new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}.</h1><p>Turn an idea into a polished edit, with every asset kept in your own project folder.</p></div>
              <span className="storage-pill"><i /> Local-first</span>
            </div>
            <PromptComposer busy={busy} onCreate={createFromPrompt} />

            <section className="recent-projects" aria-labelledby="recent-heading">
              <div className="section-heading"><div><h2 id="recent-heading">Recent projects</h2><span>{filteredProjects.length} {filteredProjects.length === 1 ? "project" : "projects"}</span></div><div className="view-controls" aria-label="Project layout"><button className={`icon-button ${projectLayout === "grid" ? "icon-button--active" : ""}`} aria-label="Grid view" aria-pressed={projectLayout === "grid"} onClick={() => setProjectLayout("grid")}><Grid2X2 size={15} /></button><button className={`icon-button ${projectLayout === "list" ? "icon-button--active" : ""}`} aria-label="List view" aria-pressed={projectLayout === "list"} onClick={() => setProjectLayout("list")}><List size={16} /></button></div></div>
              {loading ? (
                <div className="project-grid">{[0, 1, 2].map((item) => <div className="project-skeleton" key={item}><i /><span /><small /></div>)}</div>
              ) : filteredProjects.length ? (
                <div className={`project-grid project-grid--${projectLayout}`}>{filteredProjects.map((project, index) => <ProjectCard key={`${project.config.id}-${project.folderPath}`} project={project} index={index} onOpen={setActiveProject} />)}</div>
              ) : (
                <div className="library-empty"><FolderOpen size={24} /><h3>{query ? "No projects match your search" : "Your library is ready"}</h3><p>{query ? "Try a project name, prompt, or folder." : "Describe a video above or open an existing Pol Studio project folder."}</p>{!query && <button className="secondary-button" onClick={() => void openFromFolder()}>Open project folder</button>}</div>
              )}
            </section>
            <footer className="library__footer"><span>Projects are folders you control</span><i /> <span>Config: polstudio.project.json</span><i /><span>Autosave ready</span></footer>
          </div>
        </main>
      )}
      {error && <div className="toast" role="alert"><strong>Couldn’t complete that action</strong><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div>}
    </div>
  );
}

export default App;
