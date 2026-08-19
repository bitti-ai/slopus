import { Plus, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  actionReferenceIds,
  danglingReferenceTokens,
  isReferenceUsable,
  isVisualReference,
  normalizeSceneShots,
  referenceToken,
  sceneBriefText,
  sceneDurationSeconds,
  sceneShots,
  splitActionText,
  SCENE_MAX_SECONDS,
  SCENE_MIN_SECONDS,
  type GenerationJob,
  type ProjectReference,
  type SceneShot,
} from "../../lib/project";
import {
  hasCameraMovement,
  normalizeShotTagSelection,
  selectedShotTagOptions,
  shotTagGroup,
  toggleShotTag,
  SHOT_TAG_GROUPS,
  type ShotTagSelection,
} from "../../lib/shot-tags";

/** What a reference chip carries when it is dragged into a shot's line. A
 *  private type, so a file dragged in from the desktop is never mistaken for
 *  one — the drop handler checks for it before it touches the text. */
export const REFERENCE_DRAG_TYPE = "application/x-polstudio-reference";

/** The step the length slider and the cut handles move in. Half a second is the
 *  finest cut the timestamp format prints exactly (`formatSceneSeconds`), so
 *  nothing here can set a time the prompt then rounds behind the user's back. */
const STEP_SECONDS = 0.5;

const seconds = (value: number): string => `${value.toFixed(1)}s`;

interface SceneEditorProps {
  job: GenerationJob;
  /** Every reference in the project. Any of them can be dropped into a line;
   *  doing so binds it to the scene, which is what gives it a number. */
  references: ProjectReference[];
  /** True once the scene is with the engine: it already has the prompt, so an
   *  edit now would change nothing about that run while claiming otherwise. */
  disabled: boolean;
  onChange: (updates: Partial<GenerationJob>) => void;
}

export function SceneEditor({ job, references, disabled, onChange }: SceneEditorProps) {
  const shots = useMemo(() => sceneShots(job), [job]);
  const duration = sceneDurationSeconds(job);
  /* Everything that COULD be cited: the same filter pair the compiler applies,
     over the whole project. See the lockstep note on `usableImageReferences`. */
  const citable = useMemo(
    () => references.filter((reference) => isReferenceUsable(reference) && isVisualReference(reference)),
    [references],
  );
  /* And everything this scene actually cites, in the order the compiler numbers
     it: `boundRefs` in GeneratorView is `config.references` filtered by this
     scene's ids, so PROJECT order — not the order boxes were ticked — decides
     which reference is <Subject 1>. "Reference N" on screen is that number and
     nothing else, which is the whole point of numbering it here. */
  const numbered = useMemo(
    () => citable.filter((reference) => job.referenceIds.includes(reference.id)),
    [citable, job.referenceIds],
  );
  /* Numbering for the text. The cited references come first; anything a line
     still names but the prompt can no longer use is appended, so a broken token
     keeps a number and survives being typed around instead of vanishing on the
     next keystroke. */
  const tokenOrder = useMemo(() => {
    const order = numbered.map((reference) => reference.id);
    for (const shot of shots) {
      for (const id of actionReferenceIds(shot.action)) if (!order.includes(id)) order.push(id);
    }
    return order;
  }, [numbered, shots]);
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  const dangling = useMemo(() => danglingReferenceTokens(shots, references), [shots, references]);
  const [activeShotId, setActiveShotId] = useState<string | null>(null);
  const active = shots.some((shot) => shot.id === activeShotId) ? activeShotId : shots[0]?.id ?? null;

  /* Every edit lands here. The shots are the truth; `prompt` and `creativeBrief`
     are rewritten from them as the mirror they now are, and the legacy per-job
     `shotTags` is cleared because its terms have just moved onto a shot — two
     copies of the same choice is how one of them goes stale. */
  const write = useCallback((next: SceneShot[], extra: Partial<GenerationJob> = {}) => {
    const nextShots = normalizeSceneShots(next);
    const text = sceneBriefText(nextShots);
    onChange({
      shots: nextShots,
      shotTags: null,
      prompt: text,
      creativeBrief: text,
      durationSeconds: duration,
      ...extra,
    });
  }, [duration, onChange]);

  const patchShot = (id: string, updates: Partial<SceneShot>) =>
    write(shots.map((shot) => shot.id === id ? { ...shot, ...updates } : shot));

  const setDuration = (value: number) => {
    const next = Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, Math.round(value / STEP_SECONDS) * STEP_SECONDS));
    // A shot cannot start after the scene ends, so shortening the scene pulls
    // the later cuts back with it rather than leaving them past the end.
    write(shots.map((shot) => ({ ...shot, startSeconds: Math.min(shot.startSeconds, next) })), { durationSeconds: next });
  };

  const addShot = () => {
    const last = shots[shots.length - 1];
    const halfway = Math.round(((last.startSeconds + duration) / 2) / STEP_SECONDS) * STEP_SECONDS;
    const start = Math.min(duration, Math.max(last.startSeconds + STEP_SECONDS, halfway));
    const shot: SceneShot = { id: `shot-${crypto.randomUUID()}`, startSeconds: start, action: "" };
    write([...shots, shot]);
    setActiveShotId(shot.id);
  };

  const removeShot = (id: string) => {
    // A scene is at least one shot: with none there is nowhere to write, and
    // the compiler would have nothing to make a [Shot 1] out of.
    if (shots.length <= 1) return;
    write(shots.filter((shot) => shot.id !== id));
  };

  return <section className="scene-editor" aria-label="This scene">
    <SceneLengthBar
      shots={shots}
      duration={duration}
      disabled={disabled}
      onDuration={setDuration}
      onStart={(id, startSeconds) => patchShot(id, { startSeconds })}
      onSelect={setActiveShotId}
      activeShotId={active}
    />

    <ol className="shot-list">
      {shots.map((shot, index) => <li key={shot.id}>
        <ShotCard
          shot={shot}
          index={index}
          endsAt={index + 1 < shots.length ? shots[index + 1].startSeconds : duration}
          duration={duration}
          disabled={disabled}
          removable={shots.length > 1}
          focused={shot.id === active}
          tokenOrder={tokenOrder}
          referenceById={referenceById}
          citable={citable}
          numbered={numbered}
          onFocus={() => setActiveShotId(shot.id)}
          onChange={(updates) => patchShot(shot.id, updates)}
          onRemove={() => removeShot(shot.id)}
        />
      </li>)}
    </ol>

    <button type="button" className="secondary-button scene-editor__add" disabled={disabled} onClick={addShot}>
      <Plus size={16} /> Add a shot
    </button>

    <ReferencePalette
      citable={citable}
      numbered={numbered}
      dangling={dangling}
      referenceById={referenceById}
      disabled={disabled || !active}
      onInsert={(referenceId) => {
        const shot = shots.find((item) => item.id === active);
        if (!shot) return;
        const spacer = shot.action && !/\s$/.test(shot.action) ? " " : "";
        patchShot(shot.id, { action: `${shot.action}${spacer}${referenceToken(referenceId)}` });
      }}
    />

    <SceneSettings job={job} shots={shots} disabled={disabled} onChange={onChange} onShots={write} />
  </section>;
}

/* --- The length, and where each shot starts ------------------------------- */

/** The bar the scene is split on. Each shot is a segment; the line between two
 *  of them is the cut, and it can be dragged or nudged with the arrow keys.
 *  Every shot also carries a plain number field below, because a bar cannot be
 *  read by a screen reader and cannot be typed into. */
function SceneLengthBar({ shots, duration, disabled, onDuration, onStart, onSelect, activeShotId }: {
  shots: SceneShot[];
  duration: number;
  disabled: boolean;
  onDuration: (value: number) => void;
  onStart: (id: string, value: number) => void;
  onSelect: (id: string) => void;
  activeShotId: string | null;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  /** Where a cut may sit: after the shot in front of it, before the one behind,
   *  and never past the end of the scene. */
  const limits = (index: number): [number, number] => [
    shots[index - 1].startSeconds + STEP_SECONDS,
    Math.min(duration, index + 1 < shots.length ? shots[index + 1].startSeconds - STEP_SECONDS : duration),
  ];

  const clamp = (index: number, value: number): number => {
    const [low, high] = limits(index);
    const stepped = Math.round(value / STEP_SECONDS) * STEP_SECONDS;
    return Math.min(Math.max(stepped, low), Math.max(low, high));
  };

  const dragTo = (index: number, clientX: number) => {
    const track = trackRef.current?.getBoundingClientRect();
    // jsdom, and any layout that has not happened yet, report a zero-width box.
    // Guessing a position from that would throw every cut to the head of the
    // scene the moment a handle was touched.
    if (!track || track.width <= 0 || index <= 0) return;
    onStart(shots[index].id, clamp(index, ((clientX - track.left) / track.width) * duration));
  };

  const width = (index: number): number => {
    if (duration <= 0) return 100 / shots.length;
    const end = index + 1 < shots.length ? shots[index + 1].startSeconds : duration;
    return Math.max(0, (end - shots[index].startSeconds) / duration) * 100;
  };

  return <div className="scene-bar">
    <div className="scene-bar__head">
      <label className="scene-bar__length">
        <span>Scene length</span>
        <input
          type="range"
          min={SCENE_MIN_SECONDS}
          max={SCENE_MAX_SECONDS}
          step={STEP_SECONDS}
          value={duration}
          disabled={disabled}
          aria-label="Scene length in seconds"
          onChange={(event) => onDuration(Number(event.target.value))}
        />
        <b>{seconds(duration)}</b>
      </label>
      <span className="scene-bar__range">A scene runs from 0 to {SCENE_MAX_SECONDS} seconds, and holds as many shots as you split it into.</span>
    </div>

    <div
      className="scene-bar__track"
      ref={trackRef}
      onPointerMove={(event) => { if (dragging !== null) dragTo(shots.findIndex((shot) => shot.id === dragging), event.clientX); }}
      onPointerUp={() => setDragging(null)}
      onPointerLeave={() => setDragging(null)}
    >
      {shots.map((shot, index) => <div
        key={shot.id}
        className={`scene-bar__shot ${shot.id === activeShotId ? "scene-bar__shot--active" : ""}`}
        style={{ width: `${width(index)}%` }}
      >
        {index > 0 && <button
          type="button"
          className="scene-bar__handle"
          role="slider"
          aria-label={`Cut to shot ${index + 1}`}
          aria-valuemin={limits(index)[0]}
          aria-valuemax={limits(index)[1]}
          aria-valuenow={shot.startSeconds}
          aria-valuetext={seconds(shot.startSeconds)}
          disabled={disabled}
          onPointerDown={() => setDragging(shot.id)}
          onKeyDown={(event) => {
            const delta = event.key === "ArrowLeft" ? -STEP_SECONDS : event.key === "ArrowRight" ? STEP_SECONDS : 0;
            if (delta === 0) return;
            event.preventDefault();
            onStart(shot.id, clamp(index, shot.startSeconds + delta));
          }}
        />}
        <button type="button" className="scene-bar__label" onClick={() => onSelect(shot.id)}>
          <b>Shot {index + 1}</b>
          <em>{seconds(shot.startSeconds)}</em>
        </button>
      </div>)}
    </div>
  </div>;
}

/* --- One shot ------------------------------------------------------------- */

function ShotCard({ shot, index, endsAt, duration, disabled, removable, focused, tokenOrder, referenceById, citable, numbered, onFocus, onChange, onRemove }: {
  shot: SceneShot;
  index: number;
  endsAt: number;
  duration: number;
  disabled: boolean;
  removable: boolean;
  focused: boolean;
  tokenOrder: string[];
  referenceById: Map<string, ProjectReference>;
  citable: ProjectReference[];
  numbered: ProjectReference[];
  onFocus: () => void;
  onChange: (updates: Partial<SceneShot>) => void;
  onRemove: () => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const settings = shot.settings ?? {};

  /* The line, written the way the user reads and types it. What is STORED is
     `@[ref:<id>]`, which survives a rename and a reorder; what is SHOWN is
     "[Reference N]", which is what they were promised and what they may type by
     hand. The two are one mapping, applied in both directions here and nowhere
     else, so the field can never show a citation the storage does not hold. */
  const display = useMemo(() => splitActionText(shot.action).map((part) => {
    if (part.kind === "text") return part.value;
    const number = tokenOrder.indexOf(part.value) + 1;
    return number > 0 ? `[Reference ${number}]` : part.value;
  }).join(""), [shot.action, tokenOrder]);

  const store = (typed: string): string => typed.replace(/\[Reference (\d+)\]/g, (whole, digits: string) => {
    const id = tokenOrder[Number(digits) - 1];
    // A number nobody has a reference for stays exactly as typed. It is the
    // user's own text, and turning it into a citation would invent a subject.
    return id ? referenceToken(id) : whole;
  });

  const insertAtCaret = (referenceId: string) => {
    const number = tokenOrder.indexOf(referenceId) + 1;
    const field = fieldRef.current;
    const at = field ? field.selectionStart : display.length;
    const before = display.slice(0, at);
    const after = display.slice(at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    // A reference this scene does not cite yet has no number, so the token is
    // written by id and the number appears once the scene binds it.
    const token = number > 0 ? `[Reference ${number}]` : referenceToken(referenceId);
    onChange({ action: store(`${before}${lead}${token}${after}`) });
  };

  return <article className={`shot-card ${focused ? "shot-card--focused" : ""}`}>
    <header className="shot-card__head">
      <b>Shot {index + 1}</b>
      <label className="shot-card__start">
        <span>Starts at</span>
        <input
          type="number"
          min={SCENE_MIN_SECONDS}
          max={duration}
          step={STEP_SECONDS}
          value={shot.startSeconds}
          disabled={disabled || index === 0}
          aria-label={`Shot ${index + 1} starts at, in seconds`}
          title={index === 0 ? "The first shot always opens the scene." : undefined}
          onChange={(event) => onChange({ startSeconds: Math.min(duration, Math.max(0, Number(event.target.value) || 0)) })}
        />
        <em>to {seconds(endsAt)}</em>
      </label>
      {removable && <button
        type="button"
        className="shot-card__remove"
        disabled={disabled}
        aria-label={`Remove shot ${index + 1}`}
        onClick={onRemove}
      ><Trash2 size={15} /></button>}
    </header>

    {/* The line is the point of this screen, so it is the biggest thing on it. */}
    <label className="shot-card__action">
      <span className="shot-card__sublabel">What happens, in your own words</span>
      <textarea
        ref={fieldRef}
        value={display}
        disabled={disabled}
        aria-label={`What happens in shot ${index + 1}`}
        placeholder="Example: she walks towards the camera and stops under the awning."
        onFocus={onFocus}
        onChange={(event) => onChange({ action: store(event.target.value) })}
        onDragOver={(event) => { if (event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) event.preventDefault(); }}
        onDrop={(event) => {
          const referenceId = event.dataTransfer.getData(REFERENCE_DRAG_TYPE);
          if (!referenceId) return;
          event.preventDefault();
          insertAtCaret(referenceId);
        }}
      />
    </label>

    <ActionReadback
      action={shot.action}
      tokenOrder={tokenOrder}
      referenceById={referenceById}
      citable={citable}
      numbered={numbered}
      disabled={disabled}
      onRepoint={(from, to) => onChange({ action: shot.action.split(referenceToken(from)).join(referenceToken(to)) })}
      onDrop={(from) => onChange({ action: shot.action.split(referenceToken(from)).join("") })}
    />

    <ShotSettings
      settings={settings}
      disabled={disabled}
      shotNumber={index + 1}
      onChange={(next) => onChange({ settings: normalizeShotTagSelection(next) })}
    />
  </article>;
}

/** The same line, read back with each reference as a control. This is where
 *  "click Reference 1 and choose another one" lives: the select IS the token,
 *  so re-pointing it changes which reference the sentence names without
 *  touching a single character the user typed around it. */
function ActionReadback({ action, tokenOrder, referenceById, citable, numbered, disabled, onRepoint, onDrop }: {
  action: string;
  tokenOrder: string[];
  referenceById: Map<string, ProjectReference>;
  citable: ProjectReference[];
  numbered: ProjectReference[];
  disabled: boolean;
  onRepoint: (from: string, to: string) => void;
  onDrop: (from: string) => void;
}) {
  const parts = splitActionText(action);
  if (!parts.some((part) => part.kind === "reference")) return null;
  const label = (id: string): string => {
    const number = tokenOrder.indexOf(id) + 1;
    const name = referenceById.get(id)?.name;
    return `Reference ${number > 0 ? number : "?"}${name ? ` · ${name}` : ""}`;
  };
  return <p className="shot-readback">
    <span className="shot-readback__lead">Every reference in the line can be swapped for another:</span>
    {parts.map((part, index) => part.kind === "text"
      ? <span key={index} className="shot-readback__text">{part.value}</span>
      : <select
        key={index}
        className={`shot-readback__token ${citable.some((reference) => reference.id === part.value) ? "" : "shot-readback__token--broken"}`}
        value={part.value}
        disabled={disabled}
        aria-label={`${label(part.value)} — choose another reference`}
        onChange={(event) => {
          if (event.target.value === "") onDrop(part.value);
          else if (event.target.value !== part.value) onRepoint(part.value, event.target.value);
        }}
      >
        {/* A reference that can no longer be cited still has to be selectable,
            or the control could not show what the line currently says. */}
        {!citable.some((reference) => reference.id === part.value) && <option value={part.value}>{label(part.value)} — can’t be used</option>}
        {citable.map((reference) => {
          const number = numbered.findIndex((item) => item.id === reference.id) + 1;
          return <option key={reference.id} value={reference.id}>
            {number > 0 ? `Reference ${number} · ${reference.name}` : `${reference.name} — not in this scene yet`}
          </option>;
        })}
        <option value="">Take it out of the line</option>
      </select>)}
  </p>;
}

/* --- Settings ------------------------------------------------------------- */

/** Settings are ADDED one at a time and given a value, rather than laid out as
 *  a wall of every term the vocabulary holds. A shot with none is finished as
 *  it is; nothing here is required. */
function ShotSettings({ settings, disabled, shotNumber, onChange }: {
  settings: ShotTagSelection;
  disabled: boolean;
  shotNumber: number;
  onChange: (next: ShotTagSelection) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const chosen = selectedShotTagOptions(settings);
  const movement = hasCameraMovement(settings);
  // The look is set once for the whole scene, so it is not offered here — the
  // description opens with ONE style, and a second one on shot 3 has nowhere in
  // the prompt to go.
  const groups = SHOT_TAG_GROUPS.filter((group) => !group.sceneWide);
  const group = pending ? shotTagGroup(pending) : undefined;

  return <div className="shot-settings">
    <ul className="shot-settings__chips">
      {chosen.map(({ group: owner, option }) => <li key={`${owner.id}-${option.id}`}>
        <span className="setting-tag">
          <em>{owner.label}</em>
          <b>{option.label}</b>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${owner.label}: ${option.label} from shot ${shotNumber}`}
            title={`Puts “${option.term}” in the prompt`}
            onClick={() => onChange(toggleShotTag(settings, owner.id, option.id))}
          ><X size={13} /></button>
        </span>
      </li>)}
      {chosen.length === 0 && <li className="shot-settings__none">No settings on this shot, which is a finished shot.</li>}
    </ul>
    <div className="shot-settings__add">
      <select
        value={pending ?? ""}
        disabled={disabled}
        aria-label={`Add a setting to shot ${shotNumber}`}
        onChange={(event) => setPending(event.target.value || null)}
      >
        <option value="">Add a setting…</option>
        {groups.map((option) => {
          // Speed and amplitude qualify a movement. With none chosen the
          // compiler leaves them out, so offering them would promise something
          // the prompt does not do.
          const blocked = Boolean(option.requiresMovement) && !movement;
          return <option key={option.id} value={option.id} disabled={blocked}>
            {option.label}{blocked ? " — needs a camera movement first" : ""}
          </option>;
        })}
      </select>
      {group && <select
        value=""
        disabled={disabled}
        aria-label={`Value for ${group.label} on shot ${shotNumber}`}
        onChange={(event) => {
          if (!event.target.value) return;
          onChange(toggleShotTag(settings, group.id, event.target.value));
          setPending(null);
        }}
      >
        <option value="">Choose a value…</option>
        {group.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>}
      {group && <span className="shot-settings__help">{group.help}</span>}
    </div>
  </div>;
}

/** What belongs to the whole scene rather than to one shot: the look the
 *  description opens with (base guide §4.1), and the two sound fields the guide
 *  defines per prompt (§4.6, §4.7). */
function SceneSettings({ job, shots, disabled, onChange, onShots }: {
  job: GenerationJob;
  shots: SceneShot[];
  disabled: boolean;
  onChange: (updates: Partial<GenerationJob>) => void;
  onShots: (next: SceneShot[]) => void;
}) {
  const look = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!;
  // The style is read off the first shot that carries one, so that is where it
  // is written. One place, never a second field that could disagree with it.
  const chosen = shots.map((shot) => shot.settings?.[look.id]?.[0]).find(Boolean) ?? "";

  return <div className="scene-settings">
    <h3>The whole scene</h3>
    <label className="scene-settings__field">
      <span>Look</span>
      <select
        value={chosen}
        disabled={disabled}
        aria-label="The look of this scene"
        onChange={(event) => {
          const value = event.target.value;
          onShots(shots.map((shot, index) => {
            const settings = { ...(shot.settings ?? {}) };
            if (index === 0 && value) settings[look.id] = [value];
            else delete settings[look.id];
            return { ...shot, settings: normalizeShotTagSelection(settings) };
          }));
        }}
      >
        <option value="">Guessed from your words</option>
        {look.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <small>{look.help}</small>
    </label>
    <label className="scene-settings__field">
      <span>Sound</span>
      <textarea
        value={job.soundscape ?? ""}
        disabled={disabled}
        aria-label="The sound of this scene"
        placeholder="Ambience, and the sounds the action itself makes."
        onChange={(event) => onChange({ soundscape: event.target.value })}
      />
      <small>Goes into <code>overall_soundscape</code>. Left blank, PolStudio writes a line that adds nothing your description has not already established.</small>
    </label>
    <label className="scene-settings__field">
      <span>Music</span>
      <textarea
        value={job.music ?? ""}
        disabled={disabled}
        aria-label="The music of this scene"
        placeholder="Instrumentation, tempo and dynamics — not a mood."
        onChange={(event) => onChange({ music: event.target.value })}
      />
      <small>Goes into <code>non_diegetic_music</code>. Left blank, it is sent as N/A, because a score nobody asked for is one PolStudio would have invented.</small>
    </label>
  </div>;
}

/* --- The references this scene can use ------------------------------------ */

function ReferencePalette({ citable, numbered, dangling, referenceById, disabled, onInsert }: {
  citable: ProjectReference[];
  numbered: ProjectReference[];
  dangling: string[];
  referenceById: Map<string, ProjectReference>;
  disabled: boolean;
  onInsert: (referenceId: string) => void;
}) {
  return <div className="reference-palette">
    <span className="reference-palette__lead">
      {citable.length === 0
        ? "This project has no references the prompt can use yet. Add one under References and it can be dropped into a line."
        : "Drag one into a line, or add it to the end of the shot you were last writing in."}
    </span>
    <ul>
      {citable.map((reference) => {
        const number = numbered.findIndex((item) => item.id === reference.id) + 1;
        return <li key={reference.id}>
          <button
            type="button"
            className="reference-chip"
            draggable={!disabled}
            disabled={disabled}
            title={number > 0
              ? `Writes “Reference ${number}” into the line, and <Subject ${number}> into the prompt`
              : "Dropping it into a line adds it to this scene, and it takes the next Reference number"}
            onDragStart={(event) => {
              event.dataTransfer.setData(REFERENCE_DRAG_TYPE, reference.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onInsert(reference.id)}
          >
            <em>{number > 0 ? `Reference ${number}` : "Not in this scene yet"}</em>
            <b>{reference.name}</b>
          </button>
        </li>;
      })}
    </ul>
    {dangling.length > 0 && <p className="reference-palette__broken">
      {dangling.length === 1 ? "One reference named in this scene" : `${dangling.length} references named in this scene`} can no
      longer be used — {dangling.map((id) => referenceById.get(id)?.name ?? "one that was deleted").join(", ")}. Those names are
      left out of the compiled prompt below, and the scene cannot be sent until each one is swapped for another reference or taken
      out of the line.
    </p>}
  </div>;
}
