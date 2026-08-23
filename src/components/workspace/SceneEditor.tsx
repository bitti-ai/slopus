import { Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  actionReferenceIds,
  danglingReferenceTokens,
  isReferenceUsable,
  isVisualReference,
  normalizeSceneShots,
  referenceToken,
  sceneBriefText,
  sceneDurationSeconds,
  splitActionText,
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
export const STEP_SECONDS = 0.5;

const seconds = (value: number): string => `${value.toFixed(1)}s`;

/** Everything that COULD be cited: the same filter pair the compiler applies,
 *  over the whole project. See the lockstep note on `usableImageReferences`. */
export const citableReferences = (references: readonly ProjectReference[]): ProjectReference[] =>
  references.filter((reference) => isReferenceUsable(reference) && isVisualReference(reference));

/** The reference ids of a scene in the order it NUMBERS them, which is the
 *  order the compiler numbers them in: project order, filtered by what this
 *  scene binds — not the order the boxes were ticked. Anything a line still
 *  names but the prompt can no longer use is appended, so a broken token keeps
 *  a number and survives being typed around instead of vanishing on the next
 *  keystroke.
 *
 *  The board and the panel both read this, because "Reference 2" on a card and
 *  "Reference 2" in the field have to be the same reference. */
export function referenceOrder(job: GenerationJob, shots: readonly SceneShot[], references: readonly ProjectReference[]): string[] {
  const order = citableReferences(references).filter((reference) => job.referenceIds.includes(reference.id)).map((reference) => reference.id);
  for (const shot of shots) {
    for (const id of actionReferenceIds(shot.action)) if (!order.includes(id)) order.push(id);
  }
  return order;
}

/** The update that writes a new set of shots onto a scene. The shots are the
 *  truth; `prompt` and `creativeBrief` are rewritten from them as the mirror
 *  they now are, and the legacy per-job `shotTags` is cleared because its terms
 *  have just moved onto a shot — two copies of the same choice is how one of
 *  them goes stale.
 *
 *  One function, called by every control that changes a shot, because a second
 *  place that wrote `shots` without the mirror would leave a scene whose saved
 *  prompt no longer matched its own lines. */
export function writeShots(job: GenerationJob, next: readonly SceneShot[], extra: Partial<GenerationJob> = {}): Partial<GenerationJob> {
  const shots = normalizeSceneShots(next);
  const text = sceneBriefText(shots);
  return {
    shots,
    shotTags: null,
    prompt: text,
    creativeBrief: text,
    durationSeconds: sceneDurationSeconds(job),
    ...extra,
  };
}

/* --- One shot, opened on the right ---------------------------------------- */

/** Everything about ONE shot: when it starts, the line the user wrote for it,
 *  the references that line cites, and the settings hung off it. This is what
 *  clicking a card on the board opens. */
export function ShotInspector({ job, shots, shot, index, endsAt, duration, references, disabled, removable, onChange, onRemove }: {
  job: GenerationJob;
  /** Every shot of the scene, so the panel can number the references the same
   *  way the compiler does and warn about the ones no line can still cite. */
  shots: SceneShot[];
  shot: SceneShot;
  index: number;
  endsAt: number;
  duration: number;
  /** Every reference in the project. Any of them can be dropped into a line;
   *  doing so binds it to the scene, which is what gives it a number. */
  references: ProjectReference[];
  /** True once the scene is with the engine: it already has the prompt, so an
   *  edit now would change nothing about that run while claiming otherwise. */
  disabled: boolean;
  removable: boolean;
  onChange: (updates: Partial<SceneShot>) => void;
  onRemove: () => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const citable = useMemo(() => citableReferences(references), [references]);
  const numbered = useMemo(() => citable.filter((reference) => job.referenceIds.includes(reference.id)), [citable, job.referenceIds]);
  const tokenOrder = useMemo(() => referenceOrder(job, shots, references), [job, shots, references]);
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  const dangling = useMemo(() => danglingReferenceTokens(shots, references), [shots, references]);
  const settings = shot.settings ?? {};
  const shotNumber = index + 1;

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
    // Both sides, not just the one in front of the caret. A drop at the START
    // of a line has nothing before it, so `lead` is empty and the token used to
    // fuse to the first word: "<Subject 1>walks towards the camera" — a
    // malformed citation, sent to the model exactly as written.
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^\s/.test(after) ? " " : "";
    // A reference this scene does not cite yet has no number, so the token is
    // written by id and the number appears once the scene binds it.
    const token = number > 0 ? `[Reference ${number}]` : referenceToken(referenceId);
    onChange({ action: store(`${before}${lead}${token}${trail}${after}`) });
  };

  return <section className="shot-inspector" aria-label={`Shot ${shotNumber}`}>
    <div className="shot-inspector__timing">
      <label className="shot-card__start">
        <span>Starts at</span>
        <input
          type="number"
          min={SCENE_MIN_SECONDS}
          max={duration}
          step={STEP_SECONDS}
          value={shot.startSeconds}
          disabled={disabled || index === 0}
          aria-label={`Shot ${shotNumber} starts at, in seconds`}
          title={index === 0 ? "The first shot always opens the scene." : undefined}
          onChange={(event) => onChange({ startSeconds: Math.min(duration, Math.max(0, Number(event.target.value) || 0)) })}
        />
        <em>to {seconds(endsAt)}</em>
      </label>
      {removable && <button
        type="button"
        className="shot-card__remove"
        disabled={disabled}
        aria-label={`Remove shot ${shotNumber}`}
        onClick={onRemove}
      ><Trash2 size={15} /> Remove</button>}
    </div>

    <label className="shot-card__action">
      <span className="shot-card__sublabel">Describe the shot</span>
      <textarea
        ref={fieldRef}
        value={display}
        disabled={disabled}
        aria-label={`Describe shot ${shotNumber}`}
        placeholder="Example: she walks towards the camera and stops under the awning."
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

    <ReferencePalette
      citable={citable}
      numbered={numbered}
      dangling={dangling}
      referenceById={referenceById}
      disabled={disabled}
      onInsert={insertAtCaret}
    />

    <ShotSettings
      settings={settings}
      disabled={disabled}
      shotNumber={shotNumber}
      onChange={(next) => onChange({ settings: normalizeShotTagSelection(next) })}
    />
  </section>;
}

/* --- The scene, opened from its own line ---------------------------------- */

/** What remains in scene settings: the look the description opens with (base
 *  guide §4.1), and the two sound fields the guide defines per prompt (§4.6,
 *  §4.7). Length lives in the scene header where it stays visible. */
export function SceneInspector({ job, shots, disabled, onChange, onShots }: {
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

  return <section className="scene-inspector" aria-label="This scene">
    <div className="scene-settings">
      <h3>Scene</h3>
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
      </label>
    </div>
  </section>;
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
        : "Drag one into the line, or click it to write it where the caret is."}
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
      left out of the compiled prompt, and the scene cannot be sent until each one is swapped for another reference or taken
      out of the line.
    </p>}
  </div>;
}
