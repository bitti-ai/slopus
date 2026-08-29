import { Clock3, Folder, MoreHorizontal, Ratio, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolutionLabel, visibleClipAt } from "../lib/export";
import type { ProjectRecord } from "../lib/project";
import { MediaThumbnail } from "./workspace/MediaThumbnail";

interface ProjectCardProps {
  project: ProjectRecord;
  index: number;
  onOpen: (project: ProjectRecord) => void;
  onDelete?: (project: ProjectRecord) => void;
}

const artwork = ["aurora", "paper", "chrome", "ember"];

/* How long ago, said honestly. This floored everything at an hour, so a project
   saved two seconds ago was labelled "Edited 1h ago" — the card's only claim
   about the project's life, and it was false for the whole first hour. Rounding
   is out for the same reason: 1h59m is not two hours yet. Everything below is
   how much time has definitely passed. A clock that has moved backwards since
   the save (a machine resyncing, a file from another timezone) leaves a
   negative age, which is no age at all and reads as just now. */
export function relativeDate(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}

function durationLabel(seconds: number) {
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
}

export function ProjectCard({ project, index, onOpen, onDelete }: ProjectCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLDivElement>(null);
  const { config } = project;
  const style = config.thumbnail ? { backgroundImage: `url(${JSON.stringify(config.thumbnail).slice(1, -1)})` } : undefined;
  const firstVisualMs = config.timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .reduce<number | null>((first, clip) => first === null ? clip.startMs : Math.min(first, clip.startMs), null);
  const firstClip = firstVisualMs === null ? null : visibleClipAt(config.timeline.tracks, firstVisualMs);
  const firstAsset = firstClip ? config.assets.find((asset) => asset.id === firstClip.assetId) : undefined;

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
        <div className={`project-card__art project-card__art--${artwork[index % artwork.length]}${firstAsset ? " project-card__art--media" : ""}`} style={style}>
          {firstAsset && <MediaThumbnail
            key={`${firstAsset.id}-${firstClip!.sourceStartMs}`}
            folderPath={project.folderPath}
            asset={firstAsset}
            posterTimeSeconds={firstClip!.sourceStartMs / 1000}
            jpegQuality={0.9}
          />}
          <span className="project-card__format"><Ratio size={13} /> {config.settings.aspectRatio}</span>
          <span className="project-card__quality">{resolutionLabel(config.settings.resolution, config.settings.aspectRatio)}</span>
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
              {onDelete && <button className="project-card__menu-delete" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(project); }}><Trash2 size={16} /> Delete Project</button>}
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
