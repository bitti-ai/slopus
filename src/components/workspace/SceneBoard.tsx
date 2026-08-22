import { Plus, SlidersHorizontal } from "lucide-react";
import { sceneDurationSeconds, sceneShots, splitActionText, type GenerationJob, type ProjectReference, type SceneShot } from "../../lib/project";
import { selectedShotTagOptions } from "../../lib/shot-tags";
import { referenceOrder } from "./SceneEditor";
import { sceneLine, statusIcon, STATUS_BADGE } from "./sceneStatus";
import { ShotThumbnail } from "./ShotThumbnail";

/** What the right-hand panel is looking at. A scene is always named; `shotId`
 *  is the shot inside it, or null when the SCENE itself is what is open —
 *  which is what the line above each row of cards selects. */
export interface GeneratorSelection {
  jobId: string;
  shotId: string | null;
}

const seconds = (value: number): string => `${value.toFixed(1)}s`;

/* The board: every scene in the project, one row of shot cards each, separated
 * by the line that carries the scene's own name and settings.
 *
 * Shots read left to right in the order they play, and the cards are the
 * SUMMARY of a shot — its picture, its words and the settings hung off it.
 * Nothing is edited here; clicking one opens it in the panel to the right. */
export function SceneBoard({ jobs, folderPath, references, selection, onSelect, onAddShot }: {
  jobs: GenerationJob[];
  folderPath: string;
  references: ProjectReference[];
  selection: GeneratorSelection;
  onSelect: (selection: GeneratorSelection) => void;
  onAddShot: (job: GenerationJob) => void;
}) {
  return <div className="scene-board">
    {jobs.map((job) => {
      const shots = sceneShots(job);
      const duration = sceneDurationSeconds(job);
      const order = referenceOrder(job, shots, references);
      const named = new Map(references.map((reference) => [reference.id, reference.name]));
      const sceneOpen = selection.jobId === job.id && selection.shotId === null;
      return <section key={job.id} className={`scene-section ${selection.jobId === job.id ? "scene-section--current" : ""}`} aria-label={job.title}>
        {/* The scene line: the rule that separates one scene's shots from the
            next one's, and the control that opens the scene's own settings. */}
        <header className="scene-rule">
          <button
            type="button"
            className={`scene-rule__open ${sceneOpen ? "scene-rule__open--open" : ""}`}
            aria-pressed={sceneOpen}
            aria-label={`Scene settings for ${job.title}`}
            onClick={() => onSelect({ jobId: job.id, shotId: null })}
          >
            <span className={`scene-rule__status scene-rule__status--${job.status}`}>{statusIcon(job.status, 15)}</span>
            <span className="scene-rule__text">
              <b>{job.title}</b>
              <small>{sceneLine(job)}</small>
            </span>
            <span className="scene-rule__badge">{STATUS_BADGE[job.status]}</span>
            <span className="scene-rule__settings"><SlidersHorizontal size={15} aria-hidden="true" /> Scene settings</span>
          </button>
          <span className="scene-rule__line" aria-hidden="true" />
        </header>

        <ol className="shot-grid">
          {shots.map((shot, index) => <li key={shot.id}>
            <ShotCard
              job={job}
              shot={shot}
              index={index}
              endsAt={index + 1 < shots.length ? shots[index + 1].startSeconds : duration}
              folderPath={folderPath}
              order={order}
              named={named}
              open={selection.jobId === job.id && selection.shotId === shot.id}
              onOpen={() => onSelect({ jobId: job.id, shotId: shot.id })}
            />
          </li>)}
          <li>
            <button
              type="button"
              className="shot-card shot-card--add"
              aria-label={`Add a shot to ${job.title}`}
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

/** One shot, as it reads on the board. Everything on it is a summary of what
 *  the panel to the right edits — no control of its own, because a card that
 *  both opens a shot and changes it is a card you cannot click. */
function ShotCard({ job, shot, index, endsAt, folderPath, order, named, open, onOpen }: {
  job: GenerationJob;
  shot: SceneShot;
  index: number;
  endsAt: number;
  folderPath: string;
  /** Reference ids in the order this scene numbers them. */
  order: string[];
  named: Map<string, string>;
  open: boolean;
  onOpen: () => void;
}) {
  const parts = splitActionText(shot.action);
  const written = shot.action.trim().length > 0;
  const chosen = selectedShotTagOptions(shot.settings ?? {});

  return <button
    type="button"
    className={`shot-card ${open ? "shot-card--open" : ""}`}
    aria-pressed={open}
    aria-label={`Shot ${index + 1} of ${job.title}`}
    onClick={onOpen}
  >
    <ShotThumbnail folderPath={folderPath} job={job} seconds={shot.startSeconds} shotNumber={index + 1} />

    <span className="shot-card__head">
      <b>Shot {index + 1}</b>
      <em>{seconds(shot.startSeconds)} – {seconds(endsAt)}</em>
    </span>

    {/* The line as it was written, with each citation shown as the reference it
        points at rather than as the token that stores it. */}
    <span className={`shot-card__line ${written ? "" : "shot-card__line--empty"}`}>
      {written
        ? parts.map((part, at) => part.kind === "text"
          ? <span key={at}>{part.value}</span>
          : <em key={at} className="shot-card__ref">{named.get(part.value) ?? `Reference ${order.indexOf(part.value) + 1}`}</em>)
        : "No words yet — choose this shot and write what happens."}
    </span>

    <span className="shot-card__tags">
      {chosen.map(({ group, option }) => <em key={`${group.id}-${option.id}`} className="shot-card__tag">
        {option.label}
      </em>)}
      {chosen.length === 0 && <em className="shot-card__tag shot-card__tag--none">No settings</em>}
    </span>
  </button>;
}
