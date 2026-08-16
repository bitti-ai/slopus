import { Clock3, Folder, MoreHorizontal, Play, Ratio, Sparkles } from "lucide-react";
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

export function ProjectCard({ project, index, onOpen }: ProjectCardProps) {
  const { config } = project;
  const style = config.thumbnail ? { backgroundImage: `url(${JSON.stringify(config.thumbnail).slice(1, -1)})` } : undefined;
  return (
    <article className="project-card" tabIndex={0} onDoubleClick={() => onOpen(project)} onKeyDown={(event) => {
      if (event.key === "Enter") onOpen(project);
    }}>
      <button className="project-card__art-button" onClick={() => onOpen(project)} aria-label={`Open ${config.name}`}>
        <div className={`project-card__art project-card__art--${artwork[index % artwork.length]}`} style={style}>
          <span className="project-card__format"><Ratio size={12} /> {config.settings.aspectRatio}</span>
          <span className="project-card__quality">{config.settings.resolution.toUpperCase()}</span>
          <span className="project-card__play"><Play size={17} fill="currentColor" /></span>
          <div className="project-card__art-copy"><Sparkles size={14} /><span>{config.brief.prompt}</span></div>
        </div>
      </button>
      <div className="project-card__body">
        <div className="project-card__title-row">
          <h3 title={config.name}>{config.name}</h3>
          <button className="icon-button" aria-label={`More options for ${config.name}`}><MoreHorizontal size={17} /></button>
        </div>
        <p className="project-card__path" title={project.folderPath}><Folder size={12} /> {project.folderPath}</p>
        <div className="project-card__meta">
          <span><Clock3 size={12} /> Edited {relativeDate(config.updatedAt)}</span>
          <span>{config.brief.targetDurationSeconds}s</span>
        </div>
      </div>
    </article>
  );
}

