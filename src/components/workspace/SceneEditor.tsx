import { Dismiss12, ImageAdd16 } from "../ui/icons";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ComboBox, InfoBar, PropRow, PropSection } from "../ui";
import {
  actionReferenceIds,
  danglingReferenceTokens,
  isReferenceUsable,
  isVisualReference,
  isVideoTransition,
  referenceImages,
  usableVideoReferences,
  normalizeSceneShots,
  referenceToken,
  sceneBriefText,
  sceneDurationSeconds,
  sceneGenerationSeed,
  sceneGenerationSteps,
  sceneGenerationReferences,
  splitActionText,
  DEFAULT_SPEECH_LANGUAGE,
  MAX_GENERATION_STEPS,
  SCENE_MIN_SECONDS,
  SPEECH_LANGUAGES,
  type GenerationJob,
  type ProjectReference,
  type SceneShot,
  type SceneType,
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
import { CommittedNumberInput } from "./CommittedNumberInput";

/** What a reference chip carries when it is dragged into a shot's line. A
 *  private type, so a file dragged in from the desktop is never mistaken for
 *  one — the drop handler checks for it before it touches the text. */
export const REFERENCE_DRAG_TYPE = "application/x-slopus-reference";

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
  const boundIds = job.sceneType === "pose" ? sceneGenerationReferences(job, [...references]).map((reference) => reference.id) : job.referenceIds;
  const order = citableReferences(references).filter((reference) => boundIds.includes(reference.id)).map((reference) => reference.id);
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
export function ShotInspector({ job, shots, shot, index, endsAt, duration, references, disabled, onChange, promptOnly = false }: {
  promptOnly?: boolean;
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
  /** Optional read-only presentation. Generation deliberately does not set
   *  this: the current run keeps its captured snapshot while edits prepare the
   *  next one. */
  disabled: boolean;
  onChange: (updates: Partial<SceneShot>) => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const citable = useMemo(() => citableReferences(references), [references]);
  const tokenOrder = useMemo(() => referenceOrder(job, shots, references), [job, shots, references]);
  const numbered = useMemo(() => citable.filter((reference) => tokenOrder.includes(reference.id)), [citable, tokenOrder]);
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  const dangling = useMemo(() => danglingReferenceTokens(shots, references), [shots, references]);
  const settings = shot.settings ?? {};
  const shotNumber = index + 1;
  const speechLanguage = shot.speechLanguage ?? DEFAULT_SPEECH_LANGUAGE;
  const speechLanguages: readonly string[] = SPEECH_LANGUAGES.some((language) => language === speechLanguage)
    ? SPEECH_LANGUAGES
    : [...SPEECH_LANGUAGES, speechLanguage];

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

  /* Open on its own, a shot is three sections: the shot itself, the
     references its line can cite, and its settings. Inside the Pose scene's
     section (promptOnly) it is just the fields, with no headers of its own. */
  const group = (title: string, key: string, summary: ReactNode, children: ReactNode) => promptOnly
    ? children
    : <PropSection title={title} persistKey={`generator.shot.${key}`} summary={summary}>{children}</PropSection>;
  const chosenSettings = selectedShotTagOptions(settings).length;

  return <section className={`shot-inspector${promptOnly ? " shot-inspector--flat" : ""}`} aria-label={`Shot ${shotNumber}`}>
    {group("Shot", "shot", `${seconds(shot.startSeconds)} – ${seconds(endsAt)}`, <>
    {!promptOnly && <PropRow label="Starts at" htmlFor={`shot-start-${shot.id}`}>
      <input
        id={`shot-start-${shot.id}`}
        className="text-field"
        type="number"
        min={SCENE_MIN_SECONDS}
        max={duration}
        step={STEP_SECONDS}
        value={shot.startSeconds}
        disabled={disabled || index === 0}
        aria-label={`Shot ${shotNumber} starts at, in seconds`}
        data-tooltip={index === 0 ? "The first shot always opens the scene." : undefined}
        onChange={(event) => onChange({ startSeconds: Math.min(duration, Math.max(0, Number(event.target.value) || 0)) })}
      />
      <span className="prop-unit">to {seconds(endsAt)}</span>
    </PropRow>}

    {job.sceneType === "character-replace" ? <CharacterReplaceInputs shot={shot} references={references} disabled={disabled} onChange={onChange} /> : <>
    <div className="shot-card__action">
      <label className="shot-card__sublabel" htmlFor={`shot-action-${shot.id}`}>{job.sceneType === "pose" ? "Where the pose is used" : "Description"}</label>
      <div className="shot-action-editor">
        <textarea
          id={`shot-action-${shot.id}`}
          ref={fieldRef}
          value={display}
          disabled={disabled}
          aria-label={`Describe shot ${shotNumber}`}
          placeholder={job.sceneType === "pose" ? "Example: a dancer in a red coat performs this movement on a rainy city street." : "Example: she walks towards the camera and stops under the awning."}
          onChange={(event) => onChange({ action: store(event.target.value) })}
          onDragOver={(event) => { if (event.dataTransfer.types.includes(REFERENCE_DRAG_TYPE)) event.preventDefault(); }}
          onDrop={(event) => {
            const referenceId = event.dataTransfer.getData(REFERENCE_DRAG_TYPE);
            if (!referenceId) return;
            event.preventDefault();
            insertAtCaret(referenceId);
          }}
        />
        <ReferenceSmartChips
          action={shot.action}
          tokenOrder={tokenOrder}
          referenceById={referenceById}
          citable={citable}
          numbered={numbered}
          disabled={disabled}
          onChange={(partIndex, to) => {
            const action = splitActionText(shot.action).map((part, currentIndex) => {
              if (part.kind === "text") return part.value;
              if (currentIndex === partIndex) return to ? referenceToken(to) : "";
              return referenceToken(part.value);
            }).join("");
            onChange({ action });
          }}
        />
      </div>
    </div>

    {!promptOnly && <div className="shot-speech">
      <label className="shot-card__sublabel" htmlFor={`shot-speech-${shot.id}`}>Speech</label>
      <textarea
        id={`shot-speech-${shot.id}`}
        className="text-field"
        value={shot.speech ?? ""}
        disabled={disabled}
        aria-label={`Speech for shot ${shotNumber}`}
        placeholder="Words spoken in this shot"
        data-tooltip="Added to the prompt as MiniMax dialogue"
        onChange={(event) => onChange({ speech: event.target.value || null })}
      />
      <PropRow label="Language" htmlFor={`shot-language-${shot.id}`}>
        <ComboBox
          id={`shot-language-${shot.id}`}
          value={speechLanguage}
          disabled={disabled}
          aria-label={`Speech language for shot ${shotNumber}`}
          options={speechLanguages.map((language) => ({ value: language, label: language }))}
          onChange={(language) => onChange({ speechLanguage: language })}
        />
      </PropRow>
    </div>}
    </>}
    </>)}

    {job.sceneType !== "character-replace" && group("References", "references", citable.length || undefined, <ReferencePalette
      labelled={promptOnly}
      citable={citable}
      numbered={numbered}
      dangling={dangling}
      referenceById={referenceById}
      disabled={disabled}
      onInsert={insertAtCaret}
    />)}

    {job.sceneType !== "character-replace" && !promptOnly && group("Settings", "settings", chosenSettings || undefined, <ShotSettings
      settings={settings}
      disabled={disabled}
      shotNumber={shotNumber}
      onChange={(next) => onChange({ settings: normalizeShotTagSelection(next) })}
    />)}
  </section>;
}

/** A reference picker's options: an "unavailable" entry for an id the list no
 *  longer has, so the control can still show what is stored. */
const referenceOptions = (list: readonly ProjectReference[], current: string | null | undefined, empty: string, unavailable: string) => [
  { value: "", label: empty },
  ...(current && !list.some((reference) => reference.id === current) ? [{ value: current, label: unavailable }] : []),
  ...list.map((reference) => ({ value: reference.id, label: reference.name })),
];

function CharacterReplaceInputs({ shot, references, disabled, onChange }: {
  shot: SceneShot; references: ProjectReference[]; disabled: boolean;
  onChange: (updates: Partial<SceneShot>) => void;
}) {
  const videos = usableVideoReferences(references);
  const characters = references.filter((reference) => reference.kind !== "video" && isVisualReference(reference)
    && isReferenceUsable(reference) && referenceImages(reference).length > 0);
  return <div className="scene-settings">
    <PropRow label="Video" htmlFor={`replace-video-${shot.id}`}>
      <ComboBox id={`replace-video-${shot.id}`} aria-label="Video reference for this shot" value={shot.videoReferenceId ?? ""} disabled={disabled}
        options={referenceOptions(videos, shot.videoReferenceId, "None", "Unavailable video reference")}
        onChange={(value) => onChange({ videoReferenceId: value || null })} />
    </PropRow>
    <p className="prop-caption">Uses the clip range and soundtrack setting saved under References.</p>
    <PropRow label="New character" htmlFor={`replace-character-${shot.id}`}>
      <ComboBox id={`replace-character-${shot.id}`} aria-label="New character reference for this shot" value={shot.characterReferenceId ?? ""} disabled={disabled}
        options={referenceOptions(characters, shot.characterReferenceId, "None", "Unavailable character reference")}
        onChange={(value) => onChange({ characterReferenceId: value || null })} />
    </PropRow>
    <PropRow label="Replace" htmlFor={`replace-target-${shot.id}`}>
      <input id={`replace-target-${shot.id}`} className="text-field" aria-label="Character to replace in this shot" value={shot.characterTarget ?? ""} disabled={disabled}
        placeholder="The main character" onChange={(event) => onChange({ characterTarget: event.target.value || null })} />
    </PropRow>
    <p className="prop-caption">With several characters, name one, for example “the person in the red jacket”. Camera, background, lighting and other characters are kept.</p>
  </div>;
}

/* --- The scene, opened from its own header -------------------------------- */

const SCENE_TYPES: { value: SceneType; label: string }[] = [
  { value: "first-last-frame", label: "First & last frame" },
  { value: "animate", label: "Animate" },
  { value: "pose", label: "Pose" },
  { value: "character-replace", label: "Character replace" },
  { value: "extend", label: "Extend" },
  { value: "bridge", label: "Bridge" },
];

/** Scene-wide render controls, the look the description opens with (base guide
 *  §4.1), and the two sound fields defined per prompt (§4.6, §4.7). Length
 *  lives in the scene header where it stays visible. Simple label + control
 *  pairs are inspector rows; the free-text fields stay full width. */
export function SceneInspector({ job, shots, references, previousScene, defaultSteps, defaultLook, disabled, importAvailable, importError, onAddStartFrame, onAddEndFrame, onChange, onShots, sceneType = job.sceneType ?? "first-last-frame" }: {
  sceneType?: SceneType;
  defaultLook?: string | null;
  job: GenerationJob;
  shots: SceneShot[];
  references: ProjectReference[];
  previousScene?: GenerationJob;
  defaultSteps: number;
  disabled: boolean;
  importAvailable: boolean;
  importError: string | null;
  onAddStartFrame: () => void;
  onAddEndFrame: () => void;
  onChange: (updates: Partial<GenerationJob>) => void;
  onShots: (next: SceneShot[]) => void;
}) {
  const animate = sceneType === "animate";
  const pose = sceneType === "pose";
  const characterReplace = sceneType === "character-replace";
  const transition = isVideoTransition({ sceneType });
  const look = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!;
  const id = useId();
  // The style is read off the first shot that carries one, so that is where it
  // is written. One place, never a second field that could disagree with it.
  const chosen = shots.map((shot) => shot.settings?.[look.id]?.[0]).find(Boolean) ?? "";
  const imageReferences = useMemo(
    () => references.filter((reference) => referenceImages(reference).length > 0 && isReferenceUsable(reference)),
    [references],
  );
  const videos = usableVideoReferences(references);
  const addImageButton = (label: string, onClick: () => void) => <button
    type="button"
    className="icon-button prop-row__button"
    aria-label={label}
    disabled={disabled || !importAvailable}
    data-tooltip={importAvailable ? label : "Image import is available in the desktop app"}
    onClick={onClick}
  ><ImageAdd16 aria-hidden="true" /></button>;

  return <section className="scene-inspector" aria-label="This scene">
    <div role="region" aria-label="Scene" className="scene-settings">
      <PropSection title="Scene" persistKey="generator.scene" summary={SCENE_TYPES.find((type) => type.value === sceneType)?.label}>
        <PropRow label="Scene type" htmlFor={`${id}-type`}>
          <ComboBox id={`${id}-type`} aria-label="Scene type" value={sceneType} disabled={disabled} options={SCENE_TYPES}
            onChange={(value) => onChange({ sceneType: value as SceneType, usePreviousSceneLastFrame: undefined,
              ...(value === "animate" ? { endFrameReferenceId: undefined } : {}) })} />
        </PropRow>
        {pose && <>
          <PropRow label="Pose video" htmlFor={`${id}-pose`}>
            <ComboBox id={`${id}-pose`} aria-label="Pose video reference for this scene" value={job.poseVideoReferenceId ?? ""} disabled={disabled}
              options={referenceOptions(videos, job.poseVideoReferenceId, "None", "Unavailable video reference")}
              onChange={(value) => onChange({ poseVideoReferenceId: value || null })} />
          </PropRow>
          <p className="prop-caption">Uses the saved clip range for pose and motion. Describe the subject and setting below.</p>
          {shots.map((shot, index) => <ShotInspector key={shot.id} job={job} shots={shots} shot={shot} index={index}
            endsAt={shots[index + 1]?.startSeconds ?? sceneDurationSeconds(job)} duration={sceneDurationSeconds(job)}
            references={references} disabled={disabled} promptOnly
            onChange={(updates) => onShots(shots.map((item) => item.id === shot.id ? { ...item, ...updates } : item))} />)}
        </>}
        {characterReplace && <p className="prop-caption">Open a shot to choose its source video and new character.</p>}
        {transition && <>
          <PropRow label={sceneType === "bridge" ? "Start video" : "Video"} htmlFor={`${id}-start-video`}>
            <ComboBox id={`${id}-start-video`} aria-label="Start video reference for this scene" value={job.startVideoReferenceId ?? ""} disabled={disabled}
              options={referenceOptions(videos, job.startVideoReferenceId, "None", "Unavailable video reference")}
              onChange={(value) => onChange({ startVideoReferenceId: value || null })} />
          </PropRow>
          {sceneType === "bridge" && <PropRow label="End video" htmlFor={`${id}-end-video`}>
            <ComboBox id={`${id}-end-video`} aria-label="End video reference for this scene" value={job.endVideoReferenceId ?? ""} disabled={disabled}
              options={referenceOptions(videos, job.endVideoReferenceId, "None", "Unavailable video reference")}
              onChange={(value) => onChange({ endVideoReferenceId: value || null })} />
          </PropRow>}
          <p className="prop-caption">{sceneType === "bridge" ? "Connects the end of the start video to the beginning of the end video." : "Continues from the end of the selected video."} Open a shot to describe the new action; the scene length sets only the new segment.</p>
        </>}
        {!characterReplace && <>
          {animate && <>
            <PropRow label="Video" htmlFor={`${id}-animate-video`}>
              <ComboBox id={`${id}-animate-video`} aria-label="Reference video for this scene" disabled={disabled}
                value={videos.find((reference) => job.referenceIds.includes(reference.id))?.id ?? ""}
                options={referenceOptions(videos, null, "None", "")}
                onChange={(value) => onChange({ referenceIds: [
                  ...job.referenceIds.filter((referenceId) => !references.some((reference) => reference.id === referenceId && reference.kind === "video")),
                  ...(value ? [value] : []),
                ] })} />
            </PropRow>
            <p className="prop-caption">One driving video and one repainted frame of its scene. Turn on the video’s soundtrack under References to keep it.</p>
          </>}
          {!animate && <PropRow label="Look" htmlFor={`${id}-look`}>
            <ComboBox
              id={`${id}-look`}
              value={chosen}
              disabled={disabled}
              aria-label="The look of this scene"
              options={[{ value: "", label: "None" }, ...look.options.map((option) => ({ value: option.id, label: option.label }))]}
              onChange={(value) => {
                onShots(shots.map((shot, index) => {
                  const settings = { ...(shot.settings ?? {}) };
                  if (index === 0 && value) settings[look.id] = [value];
                  else delete settings[look.id];
                  return { ...shot, settings: normalizeShotTagSelection(settings) };
                }));
              }}
            />
          </PropRow>}
          {!animate && !chosen && defaultLook && <p className="prop-caption">Using project Look: {look.options.find((option) => option.id === defaultLook)?.label ?? defaultLook}.</p>}
          {!transition && !pose && <>
            <PropRow label={animate ? "Repainted frame" : "Start frame"} htmlFor={`${id}-start`}>
              <ComboBox
                id={`${id}-start`}
                value={animate
                  ? job.startFrameReferenceId ?? imageReferences.find((reference) => job.referenceIds.includes(reference.id))?.id ?? ""
                  : job.usePreviousSceneLastFrame ? "previous-scene" : job.startFrameReferenceId ?? ""}
                disabled={disabled}
                aria-label="Start frame for this scene"
                options={[
                  { value: "", label: "None" },
                  ...(!animate ? [{ value: "previous-scene", label: "Previous scene", disabled: !previousScene }] : []),
                  ...imageReferences.map((reference) => ({ value: reference.id, label: reference.name })),
                ]}
                onChange={(value) => onChange({
                  usePreviousSceneLastFrame: value === "previous-scene" || undefined,
                  startFrameReferenceId: value === "previous-scene" ? undefined : value || undefined,
                  ...(animate ? {
                    endFrameReferenceId: undefined,
                    referenceIds: job.referenceIds.filter((referenceId) => !imageReferences.some((reference) => reference.id === referenceId)),
                  } : {}),
                })}
              />
              {addImageButton(animate ? "Add repainted frame" : "Add start frame", onAddStartFrame)}
            </PropRow>
            <p className="prop-caption">{animate ? "A frame of the driving video with the character repainted. Keep its pose, framing, background and lighting." : job.usePreviousSceneLastFrame
              ? previousScene ? `Continues “${previousScene.title}” from its saved latents with 22 overlapping frames. Generate that scene first, or use Generate all.` : "Move this scene after another scene to continue it."
              : "Anchors the opening frame."}</p>
          </>}
          {!animate && !transition && !pose && <PropRow label="Last frame" htmlFor={`${id}-end`}>
            <ComboBox id={`${id}-end`} value={job.endFrameReferenceId ?? ""} disabled={disabled} aria-label="Last frame for this scene"
              options={[{ value: "", label: "None" }, ...imageReferences.map((reference) => ({ value: reference.id, label: reference.name }))]}
              onChange={(value) => onChange({ endFrameReferenceId: value || undefined })} />
            {addImageButton("Add last frame", onAddEndFrame)}
          </PropRow>}
          {importError && <InfoBar severity="error" title="Couldn’t add image" message={importError} />}
          {!animate && <>
            <label className="scene-settings__field">
              <span>Sound</span>
              <textarea
                className="text-field"
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
                className="text-field"
                value={job.music ?? ""}
                disabled={disabled}
                aria-label="The music of this scene"
                placeholder="Instrumentation, tempo and dynamics — not a mood."
                onChange={(event) => onChange({ music: event.target.value })}
              />
            </label>
          </>}
        </>}
      </PropSection>
    </div>
    <div role="region" aria-label="Generation" className="scene-settings">
      <PropSection title="Generation" persistKey="generator.generation" summary={`${sceneGenerationSteps(job, defaultSteps)} steps`}>
        {animate && <p className="prop-caption">Animate output is limited to 14.375 seconds; longer scenes are shortened to fit.</p>}
        <PropRow label="Steps" htmlFor={`${id}-steps`}>
          <CommittedNumberInput
            id={`${id}-steps`}
            className="text-field"
            minimum={2}
            maximum={MAX_GENERATION_STEPS}
            step={1}
            value={sceneGenerationSteps(job, defaultSteps)}
            integer
            disabled={disabled}
            aria-label="Generation step count"
            onCommit={(value) => onChange({ steps: value })}
          />
        </PropRow>
        <PropRow label="Seed" htmlFor={`${id}-seed`}>
          <CommittedNumberInput
            id={`${id}-seed`}
            className="text-field"
            minimum={-1}
            maximum={Number.MAX_SAFE_INTEGER}
            step={1}
            value={sceneGenerationSeed(job)}
            integer
            disabled={disabled}
            aria-label="Generation seed"
            data-tooltip="-1 picks a random seed"
            onCommit={(value) => onChange({ seed: value })}
          />
        </PropRow>
      </PropSection>
    </div>
  </section>;
}

/** Selectable smart chips live inside the description editor. Each one owns a
 *  single token occurrence, so changing it leaves identical citations later
 *  in the same sentence alone. */
function ReferenceSmartChips({ action, tokenOrder, referenceById, citable, numbered, disabled, onChange }: {
  action: string;
  tokenOrder: string[];
  referenceById: Map<string, ProjectReference>;
  citable: ProjectReference[];
  numbered: ProjectReference[];
  disabled: boolean;
  onChange: (partIndex: number, to: string | null) => void;
}) {
  const parts = splitActionText(action);
  if (!parts.some((part) => part.kind === "reference")) return null;
  const label = (id: string): string => {
    const number = tokenOrder.indexOf(id) + 1;
    const name = referenceById.get(id)?.name;
    return `Reference ${number > 0 ? number : "?"}${name ? ` · ${name}` : ""}`;
  };
  return <div className="shot-action-editor__chips">
    {parts.map((part, index) => part.kind === "reference" && <ComboBox
        key={index}
        className={`reference-smart-chip ${citable.some((reference) => reference.id === part.value) ? "" : "reference-smart-chip--broken"}`}
        value={part.value}
        disabled={disabled}
        aria-label={`${label(part.value)} — choose another reference`}
        options={[
          // A reference that can no longer be cited still has to be listed,
          // or the control could not show what the line currently says.
          ...(!citable.some((reference) => reference.id === part.value) ? [{ value: part.value, label: `${label(part.value)} — can’t be used` }] : []),
          ...citable.map((reference) => {
            const number = numbered.findIndex((item) => item.id === reference.id) + 1;
            return { value: reference.id, label: number > 0 ? `Reference ${number} · ${reference.name}` : `${reference.name} — not in this scene yet` };
          }),
          { value: "", label: "Remove from the line" },
        ]}
        onChange={(value) => {
          if (value === "") onChange(index, null);
          else if (value !== part.value) onChange(index, value);
        }}
      />)}
  </div>;
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
        <span className="setting-tag" data-tooltip={`Adds “${option.term}” to the prompt`}>
          <em>{owner.label}</em>
          <b>{option.label}</b>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove ${owner.label}: ${option.label} from shot ${shotNumber}`}
            onClick={() => onChange(toggleShotTag(settings, owner.id, option.id))}
          ><Dismiss12 aria-hidden="true" /></button>
        </span>
      </li>)}
      {chosen.length === 0 && <li className="shot-settings__none">None</li>}
    </ul>
    <div className="shot-settings__add">
      <ComboBox
        value={pending}
        disabled={disabled}
        placeholder="Add a setting…"
        aria-label={`Add a setting to shot ${shotNumber}`}
        options={groups.map((option) => {
          // Speed and amplitude qualify a movement. With none chosen the
          // compiler leaves them out, so offering them would promise something
          // the prompt does not do.
          const blocked = Boolean(option.requiresMovement) && !movement;
          return { value: option.id, label: option.label, disabled: blocked, description: blocked ? "Needs a camera movement first" : undefined };
        })}
        onChange={(value) => setPending(value || null)}
      />
      {group && <ComboBox
        value={null}
        disabled={disabled}
        placeholder="Choose a value…"
        aria-label={`Value for ${group.label} on shot ${shotNumber}`}
        options={group.options.map((option) => ({ value: option.id, label: option.label }))}
        onChange={(value) => {
          if (!value) return;
          onChange(toggleShotTag(settings, group.id, value));
          setPending(null);
        }}
      />}
      {group && <span className="shot-settings__help">{group.help}</span>}
    </div>
  </div>;
}

/* --- The references this scene can use ------------------------------------ */

function ReferencePalette({ labelled, citable, numbered, dangling, referenceById, disabled, onInsert }: {
  /** Name the palette itself, where no section header does it. */
  labelled: boolean;
  citable: ProjectReference[];
  numbered: ProjectReference[];
  dangling: string[];
  referenceById: Map<string, ProjectReference>;
  disabled: boolean;
  onInsert: (referenceId: string) => void;
}) {
  return <div className="reference-palette">
    {labelled && <span className="shot-card__sublabel">References</span>}
    {citable.length === 0 && <span className="reference-palette__lead">None yet — add one under References.</span>}
    <ul>
      {citable.map((reference) => {
        const number = numbered.findIndex((item) => item.id === reference.id) + 1;
        return <li key={reference.id}>
          <button
            type="button"
            className="reference-chip"
            draggable={!disabled}
            disabled={disabled}
            data-tooltip={number > 0
              ? `Writes “Reference ${number}” into the line, and <Subject ${number}> into the prompt. Drag it, or click to insert at the caret.`
              : "Dropping it into a line adds it to this scene with the next Reference number"}
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
    {dangling.length > 0 && <InfoBar
      severity="error"
      title={dangling.length === 1 ? "A reference can’t be used" : `${dangling.length} references can’t be used`}
      message={`${dangling.map((id) => referenceById.get(id)?.name ?? "A deleted reference").join(", ")} ${dangling.length === 1 ? "is" : "are"} left out of the prompt. Swap ${dangling.length === 1 ? "it" : "each one"} for another reference or remove ${dangling.length === 1 ? "it" : "them"} from the line before generating.`}
    />}
  </div>;
}
