import { Delete16, Film32, FolderOpen16, Image32, More16, OpenExternal16 } from "./ui/icons";
import { forwardRef, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { resolutionLabel, visibleClipAt } from "../lib/export";
import type { ProjectRecord } from "../lib/project";
import { MediaThumbnail } from "./workspace/MediaThumbnail";
import { useContextMenu, type MenuEntry } from "./ui";

interface ProjectCardProps {
  project: ProjectRecord;
  /** Kept for callers; tiles no longer vary by position. */
  index?: number;
  onOpen: (project: ProjectRecord) => void;
  onDelete?: (project: ProjectRecord) => void;
  onReveal?: (project: ProjectRecord) => void;
  selected?: boolean;
  onSelect?: (project: ProjectRecord) => void;
  /** Roving tab stop: only the selected (or first) tile is in the Tab order. */
  tabIndex?: number;
  layout?: "grid" | "list";
  id?: string;
}

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

/* A project in the library, as a GridView item: a plain tile with the real
   first frame (or a neutral glyph on --panel-3), the name and one caption
   line. Hover and selection are the shared .ui-selectable--card rule. A click
   selects it; a double-click or Enter opens it. The prompt it was made from is its tooltip.
   Right-click, Shift+F10 or the ⋯ button opens the same context menu.

   The tile is an option in the library's listbox (App.tsx owns the list, the
   selection and the arrow keys); it is not a link. */
export const ProjectCard = forwardRef(function ProjectCard(
  { project, onOpen, onDelete, onReveal, selected = false, onSelect, tabIndex = 0, layout = "grid", id }: ProjectCardProps,
  ref: Ref<HTMLDivElement>,
) {
  const menu = useContextMenu();
  const { config } = project;
  const style = config.thumbnail ? { backgroundImage: `url(${JSON.stringify(config.thumbnail).slice(1, -1)})` } : undefined;
  const assetsById = new Map(config.assets.map((asset) => [asset.id, asset]));
  const firstVisualMs = config.timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip) => {
      const asset = assetsById.get(clip.assetId);
      return asset?.kind !== "audio" && asset?.kind !== "caption";
    })
    .reduce<number | null>((first, clip) => first === null ? clip.startMs : Math.min(first, clip.startMs), null);
  const firstClip = firstVisualMs === null ? null : visibleClipAt(config.timeline.tracks, firstVisualMs, assetsById);
  const firstAsset = firstClip ? config.assets.find((asset) => asset.id === firstClip.assetId) : config.assets.find((asset) => asset.id === config.imageScene?.outputAssetId);
  const posterTimeMs = firstClip?.sourceStartMs ?? 0;
  const image = !firstClip && Boolean(config.imageScene);
  const Glyph = image ? Image32 : Film32;
  const meta = `Edited ${relativeDate(config.updatedAt)} · ${image ? "Image" : durationLabel(config.brief.targetDurationSeconds)}`;
  const prompt = config.brief.prompt.trim();

  const items: MenuEntry[] = [
    { id: "open", label: "Open", icon: <OpenExternal16 />, onSelect: () => onOpen(project) },
    ...(onReveal ? [{ id: "reveal", label: "Show in File Explorer", icon: <FolderOpen16 />, onSelect: () => onReveal(project) }] : []),
    ...(onDelete ? [{ separator: true } as const, { id: "delete", label: "Delete project…", icon: <Delete16 />, onSelect: () => onDelete(project) }] : []),
  ];
  const openMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    onSelect?.(project);
    menu.open(event, items);
  };

  return (<>
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={config.name}
      tabIndex={tabIndex}
      className={`project-card project-card--${layout} ui-selectable ui-selectable--card`}
      data-tooltip={prompt || undefined}
      onClick={() => onSelect?.(project)}
      onDoubleClick={() => onOpen(project)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") { event.preventDefault(); onOpen(project); }
        else if (event.key === " ") { event.preventDefault(); onSelect?.(project); }
        else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) { event.preventDefault(); openMenu(event); }
      }}
      onContextMenu={openMenu}
    >
      <div className={`project-card__thumb${firstAsset ? " project-card__thumb--media" : ""}`} style={style}>
        <Glyph className="project-card__glyph" aria-hidden="true" />
        {firstAsset && <MediaThumbnail
          key={`${firstAsset.id}-${posterTimeMs}`}
          folderPath={project.folderPath}
          asset={firstAsset}
          posterTimeSeconds={posterTimeMs / 1000}
          jpegQuality={0.9}
        />}
        <span className="project-card__chip" data-tooltip={resolutionLabel(config.settings.resolution, config.settings.aspectRatio)}>{config.settings.aspectRatio}</span>
      </div>
      <div className="project-card__text">
        <span className="project-card__name">{config.name}</span>
        {layout === "list" && <span className="project-card__path">{project.folderPath}</span>}
        <span className="project-card__meta">{meta}</span>
      </div>
      <button
        type="button"
        className="icon-button project-card__more"
        tabIndex={-1}
        aria-label={`More options for ${config.name}`}
        aria-haspopup="menu"
        data-tooltip="More options"
        onClick={(event) => { event.stopPropagation(); onSelect?.(project); menu.open(event.currentTarget, items, { placement: "bottom" }); }}
        onDoubleClick={(event) => event.stopPropagation()}
      ><More16 /></button>
    </div>
    {/* Outside the tile: the menu is portalled, but React events still bubble
        through the component tree, and a right-click in the menu must not
        reach the tile's own onContextMenu. */}
    {menu.element}
  </>);
});
