import { Clock3, Folder, MoreHorizontal, Play, Ratio, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProjectRecord } from "../lib/project";

interface ProjectCardProps {
  project: ProjectRecord;
  index: number;
  onOpen: (project: ProjectRecord) => void;
}

const artwork = ["aurora", "paper", "chrome", "ember"];

function relativeDate(iso: string) {
  const hours = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

function durationLabel(seconds: number) {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
}

export function ProjectCard({ project, index, onOpen }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const { config } = project;
  const style = config.thumbnail ? { backgroundImage: `url(${JSON.stringify(config.thumbnail).slice(1, -1)})` } : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutside = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && menuAnchor.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  // The card itself is not a tab stop: the art button below already opens the
  // project from the keyboard, so a focusable card only added a duplicate stop.
  return (
    <article className="project-card" onDoubleClick={() => onOpen(project)}>
      <button className="project-card__art-button" onClick={() => onOpen(project)} aria-label={`Open ${config.name}`}>
        <div className={`project-card__art project-card__art--${artwork[index % artwork.length]}`} style={style}>
          <span className="project-card__format"><Ratio size={13} /> {config.settings.aspectRatio}</span>
          <span className="project-card__quality">{config.settings.resolution.toUpperCase()}</span>
          <span className="project-card__play"><Play size={18} fill="currentColor" /></span>
          <div className="project-card__art-copy"><Sparkles size={15} /><span>{config.brief.prompt}</span></div>
        </div>
      </button>
      <div className="project-card__body">
        <div className="project-card__title-row" ref={menuAnchor}>
          <h3 title={config.name}>{config.name}</h3>
          <button
            className="icon-button"
            aria-label={`More options for ${config.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          ><MoreHorizontal size={18} /></button>
          {menuOpen && (
            <div className="project-card__menu" role="menu">
              <button role="menuitem" onClick={() => onOpen(project)}><Folder size={16} /> Open project</button>
            </div>
          )}
        </div>
        <p className="project-card__path" title={project.folderPath}><Folder size={13} /><span>{project.folderPath}</span></p>
        <div className="project-card__meta">
          <span><Clock3 size={14} /> Edited {relativeDate(config.updatedAt)}</span>
          <span>{durationLabel(config.brief.targetDurationSeconds)}</span>
        </div>
      </div>
    </article>
  );
}
