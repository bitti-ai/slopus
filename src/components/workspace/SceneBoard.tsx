import { Add16, ArrowDown16, ArrowUp16, ChevronDown12, ChevronRight12, Delete16, Grip16, MoveTo16, OpenExternal16, Rename16, Stop14, Stop16, Wand16 } from "../ui/icons";
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import {
  SCENE_MAX_SECONDS,
  SCENE_MIN_SECONDS,
  sceneDurationSeconds,
  sceneShots,
  splitActionText,
  type GenerationJob,
  type ProjectReference,
  type SceneShot,
} from "../../lib/project";
import { selectedShotTagOptions } from "../../lib/shot-tags";
import { useContextMenu, type MenuEntry } from "../ui";
import { referenceOrder, STEP_SECONDS } from "./SceneEditor";
import { statusIcon, STATUS_BADGE } from "./sceneStatus";
import { ShotThumbnail } from "./ShotThumbnail";

export interface GeneratorSelection {
  jobId: string;
  shotId: string | null;
}

/** "tiles" shows each shot's frame; "list" is one dense row per shot. */
export type BoardDensity = "tiles" | "list";

export const SCENE_DRAG_TYPE = "application/x-slopus-scene";
export const SHOT_DRAG_TYPE = "application/x-slopus-shot";

const seconds = (value: number): string => `${value.toFixed(1)}s`;
const hasDragType = (types: readonly string[], type: string): boolean => Array.from(types).includes(type);

interface ShotDragData {
  jobId: string;
  shotId: string;
}

const readShotDrag = (value: string): ShotDragData | null => {
  try {
    const parsed = JSON.parse(value) as Partial<ShotDragData>;
    return typeof parsed.jobId === "string" && typeof parsed.shotId === "string"
      ? { jobId: parsed.jobId, shotId: parsed.shotId }
      : null;
  } catch {
    return null;
  }
};

type Dragging = { kind: "scene"; jobId: string } | { kind: "shot"; jobId: string; shotId: string };
/** Where a drop would land: a scene goes before `beforeJobId` (null = the end);
 *  a shot goes into `jobId` before `beforeShotId` (null = after the last). */
type DropTarget = { kind: "scene"; beforeJobId: string | null } | { kind: "shot"; jobId: string; beforeShotId: string | null };

/** Shift+F10 and the Menu key open the same menu a right-click does. Handled
 *  on keydown (and prevented) so WebView2 does not also raise contextmenu. */
export const isMenuKey = (event: KeyboardEvent): boolean =>
  event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

/** The Generator board: every scene as a 28px section header with its shots in
 *  a tile grid underneath. Headers own the scene-wide actions and timing; a
 *  tile opens its shot in the inspector. Both are drag sources and drop
 *  targets, and both carry a right-click menu. */
export function SceneBoard({
  jobs,
  folderPath,
  generationCompletionTimes,
  references,
  selection,
  density = "tiles",
  onSelect,
  onAddShot,
  onDuration,
  onGenerate,
  generationBlocker,
  changedJobIds,
  cancellingJobIds,
  onMoveScene,
  onMoveShot,
  onRename,
  onRemoveScene,
  onRemoveShot,
}: {
  jobs: GenerationJob[];
  folderPath: string;
  generationCompletionTimes?: Readonly<Record<string, number>>;
  references: ProjectReference[];
  selection: GeneratorSelection;
  density?: BoardDensity;
  onSelect: (selection: GeneratorSelection) => void;
  onAddShot: (job: GenerationJob) => void;
  onDuration: (job: GenerationJob, value: number) => void;
  onGenerate: (job: GenerationJob) => void;
  generationBlocker: (job: GenerationJob) => string | null;
  changedJobIds: ReadonlySet<string>;
  cancellingJobIds: ReadonlySet<string>;
  onMoveScene: (jobId: string, beforeJobId: string | null) => void;
  onMoveShot: (sourceJobId: string, shotId: string, targetJobId: string, beforeShotId: string | null) => void;
  /** Select this scene or shot and put the caret in its name. */
  onRename?: (selection: GeneratorSelection) => void;
  onRemoveScene?: (job: GenerationJob) => void;
  onRemoveShot?: (job: GenerationJob, shotId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const menu = useContextMenu();
  const named = new Map(references.map((reference) => [reference.id, reference.name]));

  const endDrag = () => { setDragging(null); setDropTarget(null); };
  const toggle = (jobId: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
    return next;
  });

  /** A scene dropped straight back where it came from changes nothing, so the
   *  cursor says so instead of promising a move. */
  const sceneDropUseful = (draggedId: string, beforeJobId: string | null) => {
    const from = jobs.findIndex((job) => job.id === draggedId);
    const to = beforeJobId === null ? jobs.length : jobs.findIndex((job) => job.id === beforeJobId);
    return from >= 0 && to >= 0 && to !== from && to !== from + 1;
  };

  /** A shot can move anywhere except out of a scene it is the only shot of. */
  const shotDropAllowed = (targetJobId: string): boolean => {
    if (dragging?.kind !== "shot" || dragging.jobId === targetJobId) return true;
    const source = jobs.find((job) => job.id === dragging.jobId);
    return !source || sceneShots(source).length > 1;
  };

  const sceneMenu = (job: GenerationJob, jobIndex: number): MenuEntry[] => {
    const cancellable = job.status === "queued" || job.status === "generating";
    const blocker = generationBlocker(job);
    return [
      cancellable
        ? { id: "cancel", label: "Cancel generation", icon: <Stop16 />, onSelect: () => onGenerate(job) }
        : { id: "generate", label: "Generate", icon: <Wand16 />, disabled: Boolean(blocker), onSelect: () => onGenerate(job) },
      { id: "rename", label: "Rename", icon: <Rename16 />, shortcut: "F2", disabled: !onRename, onSelect: () => onRename?.({ jobId: job.id, shotId: null }) },
      { id: "add-shot", label: "Add shot", icon: <Add16 />, onSelect: () => onAddShot(job) },
      { separator: true },
      { id: "up", label: "Move up", icon: <ArrowUp16 />, disabled: jobIndex === 0, onSelect: () => onMoveScene(job.id, jobs[jobIndex - 1]?.id ?? null) },
      { id: "down", label: "Move down", icon: <ArrowDown16 />, disabled: jobIndex === jobs.length - 1, onSelect: () => onMoveScene(job.id, jobs[jobIndex + 2]?.id ?? null) },
      { separator: true },
      { id: "delete", label: "Delete", icon: <Delete16 />, shortcut: "Delete", danger: true, disabled: !onRemoveScene, onSelect: () => onRemoveScene?.(job) },
    ];
  };

  const shotMenu = (job: GenerationJob, shot: SceneShot): MenuEntry[] => {
    const alone = sceneShots(job).length <= 1;
    const others = jobs.filter((candidate) => candidate.id !== job.id);
    return [
      { id: "open", label: "Open", icon: <OpenExternal16 />, onSelect: () => onSelect({ jobId: job.id, shotId: shot.id }) },
      { id: "rename", label: "Rename", icon: <Rename16 />, shortcut: "F2", disabled: !onRename, onSelect: () => onRename?.({ jobId: job.id, shotId: shot.id }) },
      ...(others.length ? [{ separator: true } as const, {
        id: "move-to",
        label: "Move to",
        icon: <MoveTo16 />,
        disabled: alone,
        items: others.map((target): MenuEntry => ({
          id: `move-${target.id}`,
          label: target.title,
          onSelect: () => onMoveShot(job.id, shot.id, target.id, null),
        })),
      }] : []),
      { separator: true },
      { id: "delete", label: "Delete", icon: <Delete16 />, shortcut: "Delete", danger: true, disabled: alone || !onRemoveShot, onSelect: () => onRemoveShot?.(job, shot.id) },
    ];
  };

  /* Arrow keys move between the tiles of one scene (one Tab stop per grid,
     the roving tabindex a Windows grid view uses). Up and Down pick the tile
     in the next row whose centre is nearest, so it follows the wrap. */
  const gridKeys = (event: KeyboardEvent<HTMLOListElement>, job: GenerationJob) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || event.altKey || event.ctrlKey) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".shot-card__open-control")];
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    let next = at;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (event.key === "ArrowRight") next = Math.min(buttons.length - 1, at + 1);
    else {
      const rect = (element: Element) => element.closest(".shot-card")!.getBoundingClientRect();
      const here = rect(buttons[at]);
      const down = event.key === "ArrowDown";
      const row = buttons
        .map((button, index) => ({ index, box: rect(button) }))
        .filter(({ box }) => (down ? box.top > here.top + 1 : box.top < here.top - 1));
      if (row.length) {
        const edge = down ? Math.min(...row.map(({ box }) => box.top)) : Math.max(...row.map(({ box }) => box.top));
        const centre = here.left + here.width / 2;
        next = row.filter(({ box }) => box.top === edge)
          .reduce((best, candidate) => Math.abs(candidate.box.left + candidate.box.width / 2 - centre) < Math.abs(best.box.left + best.box.width / 2 - centre) ? candidate : best).index;
      } else {
        // No layout (a single row, or no geometry at all): behave like a list.
        next = down ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1);
      }
    }
    event.preventDefault();
    if (next === at) return;
    buttons[next].focus();
    const shot = sceneShots(job)[next];
    if (shot) onSelect({ jobId: job.id, shotId: shot.id });
  };

  return <div className={`scene-board scene-board--${density}`}>
    {jobs.map((job, jobIndex) => {
      const shots = sceneShots(job);
      const duration = sceneDurationSeconds(job);
      const order = referenceOrder(job, shots, references);
      const sceneOpen = selection.jobId === job.id && selection.shotId === null;
      const cancellable = job.status === "queued" || job.status === "generating";
      const blocker = generationBlocker(job);
      const indicator = changedJobIds.has(job.id) ? "changed" : job.status;
      const isCollapsed = collapsed.has(job.id);
      const rovingShot = shots.find((shot) => selection.jobId === job.id && shot.id === selection.shotId)?.id ?? shots[0]?.id;
      const sceneDrop = dropTarget?.kind === "scene" ? dropTarget.beforeJobId : undefined;
      const shotDrop = dropTarget?.kind === "shot" && dropTarget.jobId === job.id ? dropTarget : null;

      const sceneBeforeFromEvent = (event: DragEvent<HTMLElement>): string | null => {
        const box = event.currentTarget.getBoundingClientRect();
        const after = box.height > 0 && event.clientY > box.top + box.height / 2;
        return after ? jobs[jobIndex + 1]?.id ?? null : job.id;
      };

      const dropScene = (event: DragEvent<HTMLElement>) => {
        if (!hasDragType(event.dataTransfer.types, SCENE_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        const draggedId = event.dataTransfer.getData(SCENE_DRAG_TYPE) || (dragging?.kind === "scene" ? dragging.jobId : "");
        endDrag();
        if (!draggedId) return;
        onMoveScene(draggedId, sceneBeforeFromEvent(event));
      };

      const dropShot = (event: DragEvent<HTMLElement>, beforeShotId: string | null) => {
        if (!hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        const dragged = readShotDrag(event.dataTransfer.getData(SHOT_DRAG_TYPE))
          ?? (dragging?.kind === "shot" ? { jobId: dragging.jobId, shotId: dragging.shotId } : null);
        endDrag();
        if (dragged) onMoveShot(dragged.jobId, dragged.shotId, job.id, beforeShotId);
      };

      const overShots = (event: DragEvent<HTMLElement>, beforeShotId: string | null) => {
        if (!hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) return;
        event.stopPropagation();
        if (!shotDropAllowed(job.id)) {
          event.dataTransfer.dropEffect = "none";
          setDropTarget(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (shotDrop?.beforeShotId !== beforeShotId || !shotDrop) setDropTarget({ kind: "shot", jobId: job.id, beforeShotId });
      };

      const openSceneMenu = (source: Parameters<typeof menu.open>[0]) => {
        onSelect({ jobId: job.id, shotId: null });
        menu.open(source, sceneMenu(job, jobIndex), { "aria-label": `${job.title} actions` });
      };

      return <section
        key={job.id}
        className={[
          "scene-section",
          selection.jobId === job.id ? "scene-section--current" : "",
          isCollapsed ? "scene-section--collapsed" : "",
          dragging?.kind === "scene" && dragging.jobId === job.id ? "scene-section--dragging" : "",
          sceneDrop === job.id ? "scene-section--drop-before" : "",
          sceneDrop === null && jobIndex === jobs.length - 1 ? "scene-section--drop-after" : "",
        ].filter(Boolean).join(" ")}
        aria-label={job.title}
        onDragOver={(event) => {
          if (!hasDragType(event.dataTransfer.types, SCENE_DRAG_TYPE)) return;
          const before = sceneBeforeFromEvent(event);
          const draggedId = dragging?.kind === "scene" ? dragging.jobId : null;
          if (draggedId && !sceneDropUseful(draggedId, before)) {
            event.dataTransfer.dropEffect = "none";
            setDropTarget(null);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (sceneDrop !== before) setDropTarget({ kind: "scene", beforeJobId: before });
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
            if (dropTarget?.kind === "scene" || shotDrop) setDropTarget(null);
          }
        }}
        onDrop={dropScene}
      >
        <header
          className="scene-rule"
          onClick={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("button, input, label, [role='button']")) return;
            onSelect({ jobId: job.id, shotId: null });
          }}
          onContextMenu={(event) => {
            if ((event.target as HTMLElement).closest("input")) return;
            openSceneMenu(event);
          }}
        >
          <button
            type="button"
            className="scene-rule__toggle"
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${job.title}`}
            onClick={() => toggle(job.id)}
          >{isCollapsed ? <ChevronRight12 aria-hidden="true" /> : <ChevronDown12 aria-hidden="true" />}</button>

          <span
            className="scene-rule__drag"
            role="button"
            tabIndex={0}
            draggable
            aria-label={`Drag ${job.title} to reorder scenes`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            data-tooltip="Drag to reorder"
            data-tooltip-shortcut="Up, Down"
            onDragStart={(event) => {
              event.dataTransfer.setData(SCENE_DRAG_TYPE, job.id);
              event.dataTransfer.effectAllowed = "move";
              const header = event.currentTarget.closest(".scene-rule");
              if (header && typeof event.dataTransfer.setDragImage === "function") event.dataTransfer.setDragImage(header, 16, 16);
              setDragging({ kind: "scene", jobId: job.id });
            }}
            onDragEnd={endDrag}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && jobIndex > 0) {
                event.preventDefault();
                onMoveScene(job.id, jobs[jobIndex - 1].id);
              } else if (event.key === "ArrowDown" && jobIndex < jobs.length - 1) {
                event.preventDefault();
                onMoveScene(job.id, jobs[jobIndex + 2]?.id ?? null);
              } else if (isMenuKey(event)) {
                event.preventDefault();
                openSceneMenu(event);
              }
            }}
          ><Grip16 aria-hidden="true" /></span>

          <button
            type="button"
            className="scene-rule__summary"
            aria-label={`Select scene ${job.title}`}
            aria-pressed={sceneOpen}
            onClick={() => onSelect({ jobId: job.id, shotId: null })}
            onKeyDown={(event) => {
              if (!isMenuKey(event)) return;
              event.preventDefault();
              openSceneMenu(event);
            }}
          >
            {job.status !== "draft" && <span className={`scene-rule__status scene-rule__status--${indicator}`}>{statusIcon(indicator)}</span>}
            <b className="scene-rule__title" data-tooltip={job.title}>{job.title}</b>
            {job.status !== "draft" && indicator !== "generating" && <span className="scene-rule__badge">{STATUS_BADGE[indicator]}</span>}
            {/* The section's summary, at the trailing edge like any section
                header's count. */}
            <span className="scene-rule__caption">{shots.length === 1 ? "1 shot" : `${shots.length} shots`} · {seconds(duration)}</span>
          </button>

          <label className="scene-rule__length" data-tooltip="Scene length">
            <input
              type="range"
              min={SCENE_MIN_SECONDS}
              max={SCENE_MAX_SECONDS}
              step={STEP_SECONDS}
              value={duration}
              aria-label={`${job.title} length in seconds`}
              onChange={(event) => onDuration(job, Number(event.target.value))}
            />
          </label>

          <HeaderButton label={`Add a shot to ${job.title}`} tooltip="Add shot" onClick={() => onAddShot(job)}><Add16 /></HeaderButton>
          <HeaderButton
            label={cancellable ? "Cancel" : "Generate"}
            tooltip={cancellable ? `Cancel ${job.title}` : blocker ?? `Generate ${job.title}`}
            className={cancellable ? "scene-rule__cancel" : undefined}
            disabled={!cancellable && Boolean(blocker)}
            onClick={() => onGenerate(job)}
          >{cancellable ? <Stop14 /> : <Wand16 />}</HeaderButton>
        </header>

        {!isCollapsed && <ol
          className={`shot-grid${shotDrop?.beforeShotId === null ? " shot-grid--drop-end" : ""}`}
          aria-label={`Shots in ${job.title}`}
          onKeyDown={(event) => gridKeys(event, job)}
          onDragOver={(event) => overShots(event, null)}
          onDrop={(event) => dropShot(event, null)}
        >
          {shots.map((shot, index) => {
            const isSource = dragging?.kind === "shot" && dragging.shotId === shot.id;
            return <li
              key={shot.id}
              className={[
                "shot-slot",
                shotDrop?.beforeShotId === shot.id ? "shot-slot--drop-before" : "",
                shotDrop?.beforeShotId === null && index === shots.length - 1 ? "shot-slot--drop-after" : "",
              ].filter(Boolean).join(" ")}
              onDragOver={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const after = density === "list"
                  ? box.height > 0 && event.clientY > box.top + box.height / 2
                  : box.width > 0 && event.clientX > box.left + box.width / 2;
                overShots(event, after ? shots[index + 1]?.id ?? null : shot.id);
              }}
              onDrop={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const after = density === "list"
                  ? box.height > 0 && event.clientY > box.top + box.height / 2
                  : box.width > 0 && event.clientX > box.left + box.width / 2;
                dropShot(event, after ? shots[index + 1]?.id ?? null : shot.id);
              }}
            >
              <ShotCard
                job={job}
                shot={shot}
                index={index}
                endsAt={index + 1 < shots.length ? shots[index + 1].startSeconds : duration}
                folderPath={folderPath}
                estimatedCompletionAt={generationCompletionTimes?.[job.id] ?? null}
                order={order}
                named={named}
                density={density}
                cancelling={cancellingJobIds.has(job.id) && cancellable}
                open={selection.jobId === job.id && selection.shotId === shot.id}
                dragSource={isSource}
                tabbable={shot.id === rovingShot}
                onOpen={() => onSelect({ jobId: job.id, shotId: shot.id })}
                onMenu={(source) => {
                  onSelect({ jobId: job.id, shotId: shot.id });
                  menu.open(source, shotMenu(job, shot), { "aria-label": `${shot.name ?? `Shot ${index + 1}`} actions` });
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(SHOT_DRAG_TYPE, JSON.stringify({ jobId: job.id, shotId: shot.id }));
                  event.dataTransfer.effectAllowed = "move";
                  // The frame, not the whole tile, follows the pointer.
                  const thumb = event.currentTarget.querySelector<HTMLElement>(".shot-thumb");
                  if (thumb && typeof event.dataTransfer.setDragImage === "function") {
                    event.dataTransfer.setDragImage(thumb, thumb.offsetWidth / 2, thumb.offsetHeight / 2);
                  }
                  setDragging({ kind: "shot", jobId: job.id, shotId: shot.id });
                }}
                onDragEnd={endDrag}
              />
            </li>;
          })}
        </ol>}
      </section>;
    })}
    {menu.element}
  </div>;
}

function HeaderButton({ label, tooltip, className = "", disabled, onClick, children }: {
  label: string;
  tooltip: string;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return <button
    type="button"
    className={`scene-rule__action ${className}`.trim()}
    aria-label={label}
    data-tooltip={tooltip}
    disabled={disabled}
    onClick={onClick}
  ><span aria-hidden="true">{children}</span></button>;
}

function ShotCard({ job, shot, index, endsAt, folderPath, estimatedCompletionAt, order, named, density, cancelling, open, dragSource, tabbable, onOpen, onMenu, onDragStart, onDragEnd }: {
  job: GenerationJob;
  shot: SceneShot;
  index: number;
  endsAt: number;
  folderPath: string;
  estimatedCompletionAt: number | null;
  order: string[];
  named: Map<string, string>;
  density: BoardDensity;
  cancelling: boolean;
  open: boolean;
  dragSource: boolean;
  tabbable: boolean;
  onOpen: () => void;
  onMenu: (source: React.MouseEvent | React.KeyboardEvent) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const parts = splitActionText(shot.action);
  const characterReplace = job.sceneType === "character-replace";
  const written = characterReplace ? Boolean(shot.videoReferenceId && shot.characterReferenceId) : shot.action.trim().length > 0;
  const chosen = characterReplace ? [] : selectedShotTagOptions(shot.settings ?? {});
  const name = shot.name ?? `Shot ${index + 1}`;
  const plainLine = characterReplace
    ? written ? `${named.get(shot.videoReferenceId!) ?? "Unavailable video"} → ${named.get(shot.characterReferenceId!) ?? "Unavailable character"}` : "No video or character"
    : written
      ? parts.map((part) => part.kind === "text" ? part.value : named.get(part.value) ?? `Reference ${order.indexOf(part.value) + 1}`).join("")
      : "No description";

  return <div
    className={`shot-card ui-selectable ui-selectable--card${open ? " is-selected" : ""}${dragSource ? " shot-card--dragging" : ""}`}
    aria-label={`${name} of ${job.title}`}
    draggable
    onDragStart={onDragStart}
    onDragEnd={onDragEnd}
    onContextMenu={onMenu}
  >
    {density === "tiles" && <ShotThumbnail folderPath={folderPath} job={job} seconds={shot.startSeconds} endSeconds={endsAt} shotNumber={index + 1} estimatedCompletionAt={estimatedCompletionAt} cancelling={cancelling} onPlay={onOpen} />}
    <button
      type="button"
      className="shot-card__open-control"
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={open}
      aria-label={`${name} of ${job.title}`}
      aria-keyshortcuts="Shift+F10"
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!isMenuKey(event)) return;
        event.preventDefault();
        onMenu(event);
      }}
    >
      <span className="shot-card__head">
        <b>{name}</b>
        <em>{seconds(shot.startSeconds)} – {seconds(endsAt)}</em>
      </span>
      {/* One line, ellipsised; the whole line is in the tooltip and one click
          away in the inspector. */}
      <span className={`shot-card__line ${written ? "" : "shot-card__line--empty"}`} data-tooltip={written ? plainLine : undefined}>
        {characterReplace || !written
          ? plainLine
          : parts.map((part, at) => part.kind === "text"
            ? <span key={at}>{part.value}</span>
            : <em key={at} className="shot-card__ref">{named.get(part.value) ?? `Reference ${order.indexOf(part.value) + 1}`}</em>)}
      </span>
      {density === "tiles" && chosen.length > 0 && <span className="shot-card__tags">
        {chosen.map(({ group, option }) => <em key={`${group.id}-${option.id}`} className="shot-card__tag">{option.label}</em>)}
      </span>}
    </button>
  </div>;
}
