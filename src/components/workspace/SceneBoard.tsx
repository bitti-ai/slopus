import { GripVertical, Plus, SlidersHorizontal, Trash2, WandSparkles } from "lucide-react";
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
import { referenceOrder, STEP_SECONDS } from "./SceneEditor";
import { statusIcon, STATUS_BADGE } from "./sceneStatus";
import { ShotThumbnail } from "./ShotThumbnail";

export interface GeneratorSelection {
  jobId: string;
  shotId: string | null;
}

export const SCENE_DRAG_TYPE = "application/x-polstudio-scene";
export const SHOT_DRAG_TYPE = "application/x-polstudio-shot";

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

/** The Generator board. Scene headers own scene-wide actions and timing; shot
 * cards remain the entry point to a shot's editor and double as drop targets. */
export function SceneBoard({
  jobs,
  folderPath,
  references,
  selection,
  onSelect,
  onAddShot,
  onDuration,
  onRemoveScene,
  onGenerate,
  generationBlocker,
  changedJobIds,
  onMoveScene,
  onMoveShot,
}: {
  jobs: GenerationJob[];
  folderPath: string;
  references: ProjectReference[];
  selection: GeneratorSelection;
  onSelect: (selection: GeneratorSelection) => void;
  onAddShot: (job: GenerationJob) => void;
  onDuration: (job: GenerationJob, value: number) => void;
  onRemoveScene: (job: GenerationJob) => void;
  onGenerate: (job: GenerationJob) => void;
  generationBlocker: (job: GenerationJob) => string | null;
  changedJobIds: ReadonlySet<string>;
  onMoveScene: (jobId: string, beforeJobId: string | null) => void;
  onMoveShot: (sourceJobId: string, shotId: string, targetJobId: string, beforeShotId: string | null) => void;
}) {
  return <div className="scene-board">
    {jobs.map((job, jobIndex) => {
      const shots = sceneShots(job);
      const duration = sceneDurationSeconds(job);
      const order = referenceOrder(job, shots, references);
      const named = new Map(references.map((reference) => [reference.id, reference.name]));
      const sceneOpen = selection.jobId === job.id && selection.shotId === null;
      const locked = job.status === "queued" || job.status === "generating";
      const blocker = generationBlocker(job);
      const indicator = changedJobIds.has(job.id) ? "changed" : job.status;

      const dropScene = (event: React.DragEvent<HTMLElement>) => {
        if (!hasDragType(event.dataTransfer.types, SCENE_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        const draggedId = event.dataTransfer.getData(SCENE_DRAG_TYPE);
        if (!draggedId) return;
        const box = event.currentTarget.getBoundingClientRect();
        const after = box.height > 0 && event.clientY > box.top + box.height / 2;
        onMoveScene(draggedId, after ? jobs[jobIndex + 1]?.id ?? null : job.id);
      };

      return <section
        key={job.id}
        className={`scene-section ${selection.jobId === job.id ? "scene-section--current" : ""}`}
        aria-label={job.title}
        onDragOver={(event) => {
          if (hasDragType(event.dataTransfer.types, SCENE_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={dropScene}
      >
        <header className="scene-rule">
          <span
            className="scene-rule__drag"
            role="button"
            tabIndex={0}
            draggable
            aria-label={`Drag ${job.title} to reorder scenes`}
            title="Drag to reorder this scene"
            onDragStart={(event) => {
              event.dataTransfer.setData(SCENE_DRAG_TYPE, job.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && jobIndex > 0) {
                event.preventDefault();
                onMoveScene(job.id, jobs[jobIndex - 1].id);
              } else if (event.key === "ArrowDown" && jobIndex < jobs.length - 1) {
                event.preventDefault();
                onMoveScene(job.id, jobs[jobIndex + 2]?.id ?? null);
              }
            }}
          ><GripVertical size={17} aria-hidden="true" /></span>

          <div className="scene-rule__summary">
            {job.status !== "draft" && <span className={`scene-rule__status scene-rule__status--${indicator}`}>{statusIcon(indicator, 15)}</span>}
            <span className="scene-rule__text">
              <b>{job.title}</b>
            </span>
            {job.status !== "draft" && <span className="scene-rule__badge">{STATUS_BADGE[indicator]}</span>}
          </div>

          <label className="scene-rule__length">
            <span>Length</span>
            <input
              type="range"
              min={SCENE_MIN_SECONDS}
              max={SCENE_MAX_SECONDS}
              step={STEP_SECONDS}
              value={duration}
              disabled={locked}
              aria-label={`${job.title} length in seconds`}
              onChange={(event) => onDuration(job, Number(event.target.value))}
            />
            <b>{seconds(duration)}</b>
          </label>

          <button
            type="button"
            className="secondary-button scene-rule__settings-button"
            aria-pressed={sceneOpen}
            aria-label={`Settings for ${job.title}`}
            onClick={() => onSelect({ jobId: job.id, shotId: null })}
          ><SlidersHorizontal size={15} aria-hidden="true" /> Settings</button>

          <button
            type="button"
            className="scene-rule__remove"
            aria-label={`Remove scene ${job.title}`}
            title={`Remove ${job.title}`}
            onClick={() => onRemoveScene(job)}
          ><Trash2 size={16} aria-hidden="true" /></button>

          <button
            type="button"
            className="primary-button scene-rule__generate"
            disabled={Boolean(blocker)}
            title={blocker ?? `Generate ${job.title}`}
            onClick={() => onGenerate(job)}
          ><WandSparkles size={15} aria-hidden="true" /> Generate</button>
        </header>

        <ol className="shot-grid">
          {shots.map((shot, index) => <li
            key={shot.id}
            onDragOver={(event) => {
              if (hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onDrop={(event) => {
              if (!hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              const dragged = readShotDrag(event.dataTransfer.getData(SHOT_DRAG_TYPE));
              if (dragged) onMoveShot(dragged.jobId, dragged.shotId, job.id, shot.id);
            }}
          >
            <ShotCard
              job={job}
              shot={shot}
              index={index}
              endsAt={index + 1 < shots.length ? shots[index + 1].startSeconds : duration}
              folderPath={folderPath}
              order={order}
              named={named}
              open={selection.jobId === job.id && selection.shotId === shot.id}
              draggable={!locked}
              onOpen={() => onSelect({ jobId: job.id, shotId: shot.id })}
              onDragStart={(event) => {
                event.dataTransfer.setData(SHOT_DRAG_TYPE, JSON.stringify({ jobId: job.id, shotId: shot.id }));
                event.dataTransfer.effectAllowed = "move";
              }}
            />
          </li>)}
          <li
            onDragOver={(event) => {
              if (hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            onDrop={(event) => {
              if (!hasDragType(event.dataTransfer.types, SHOT_DRAG_TYPE)) return;
              event.preventDefault();
              event.stopPropagation();
              const dragged = readShotDrag(event.dataTransfer.getData(SHOT_DRAG_TYPE));
              if (dragged) onMoveShot(dragged.jobId, dragged.shotId, job.id, null);
            }}
          >
            <button
              type="button"
              className="shot-card shot-card--add"
              aria-label={`Add a shot to ${job.title}`}
              disabled={locked}
              onClick={() => onAddShot(job)}
            >
              <Plus size={18} aria-hidden="true" />
              <span>Add a shot</span>
            </button>
          </li>
        </ol>
      </section>;
    })}
  </div>;
}

function ShotCard({ job, shot, index, endsAt, folderPath, order, named, open, draggable, onOpen, onDragStart }: {
  job: GenerationJob;
  shot: SceneShot;
  index: number;
  endsAt: number;
  folderPath: string;
  order: string[];
  named: Map<string, string>;
  open: boolean;
  draggable: boolean;
  onOpen: () => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
}) {
  const parts = splitActionText(shot.action);
  const written = shot.action.trim().length > 0;
  const chosen = selectedShotTagOptions(shot.settings ?? {});

  return <button
    type="button"
    className={`shot-card ${open ? "shot-card--open" : ""}`}
    aria-pressed={open}
    aria-label={`${shot.name ?? `Shot ${index + 1}`} of ${job.title}`}
    title={draggable ? "Drag to reorder this shot or move it to another scene" : "This shot cannot be moved while its scene is rendering"}
    draggable={draggable}
    onDragStart={onDragStart}
    onClick={onOpen}
  >
    <ShotThumbnail folderPath={folderPath} job={job} seconds={shot.startSeconds} shotNumber={index + 1} />
    <span className="shot-card__head">
      <b>{shot.name ?? `Shot ${index + 1}`}</b>
      <em>{seconds(shot.startSeconds)} – {seconds(endsAt)}</em>
    </span>
    <span className={`shot-card__line ${written ? "" : "shot-card__line--empty"}`}>
      {written
        ? parts.map((part, at) => part.kind === "text"
          ? <span key={at}>{part.value}</span>
          : <em key={at} className="shot-card__ref">{named.get(part.value) ?? `Reference ${order.indexOf(part.value) + 1}`}</em>)
        : "No words yet — choose this shot and write what happens."}
    </span>
    <span className="shot-card__tags">
      {chosen.map(({ group, option }) => <em key={`${group.id}-${option.id}`} className="shot-card__tag">{option.label}</em>)}
      {chosen.length === 0 && <em className="shot-card__tag shot-card__tag--none">No settings</em>}
    </span>
  </button>;
}
