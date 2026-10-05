import { Audio16, Dismiss12, Image16, ImageAdd16, Text16, Video16 } from "../ui/icons";
import { useId, useMemo, useState, type ReactNode } from "react";
import { ComboBox, InfoBar, PropRow, PropSection, ToggleSwitch } from "../ui";
import {
  shotReferenceIds,
  danglingReferenceTokens,
  isAudioReference,
  isReferenceUsable,
  isVisualReference,
  isVideoReference,
  isVideoTransition,
  referenceImages,
  referenceTypeLabel,
  usableVideoReferences,
  normalizeSceneShots,
  referenceToken,
  sceneBriefText,
  sceneDurationSeconds,
  sceneGenerationSeed,
  sceneGenerationSteps,
  MAX_AUDIO_GENERATION_STEPS,
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
import { DEFAULT_CONTINUATION_OVERLAP, MAX_CONTINUATION_OVERLAP } from "../../lib/project";
import { PromptTextField } from "./PromptTextField";
import { ReferenceIcon } from "./ReferenceIcon";
import { ReferenceSelector } from "./ReferenceSelector";
import { referenceMediaTypes, selectReferences } from "../../lib/referenceSelection";

/** The step the length slider and the cut handles move in. Half a second is the
 *  finest cut the timestamp format prints exactly (`formatSceneSeconds`), so
 *  nothing here can set a time the prompt then rounds behind the user's back. */
export const STEP_SECONDS = 0.5;

const seconds = (value: number): string => `${value.toFixed(1)}s`;

/** Everything that COULD be cited: the same filter pair the compiler applies,
 *  over the whole project. See the lockstep note on `usableImageReferences`. */
export const citableReferences = (references: readonly ProjectReference[]): ProjectReference[] =>
  references.filter((reference) => isReferenceUsable(reference) && (isVisualReference(reference) || isAudioReference(reference)));

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
  const boundIds = sceneGenerationReferences({ ...job, shots: [...shots] }, [...references]).map((reference) => reference.id);
  const order = citableReferences(references).filter((reference) => boundIds.includes(reference.id)).map((reference) => reference.id);
  for (const shot of shots) {
    for (const id of shotReferenceIds(shot)) if (!order.includes(id)) order.push(id);
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
export function ShotInspector({ job, shots, shot, index, endsAt, duration, references, folderPath = "", disabled, onChange, promptOnly = false }: {
  promptOnly?: boolean;
  /** The project folder, for each reference's art in the picker. */
  folderPath?: string;
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
  const citable = useMemo(() => citableReferences(references), [references]);
  const tokenOrder = useMemo(() => referenceOrder(job, shots, references), [job, shots, references]);
  const numbered = useMemo(() => citable.filter((reference) => tokenOrder.includes(reference.id)), [citable, tokenOrder]);
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  /* The picker names each reference by the number the line gives it, which
     is the <Subject N> it becomes; one the scene does not cite yet is bound
     to it, and numbered, by being written into a line. */
  const pickable = useMemo(() => citable.map((reference) => {
    const number = numbered.findIndex((item) => item.id === reference.id) + 1;
    return {
      id: reference.id, name: reference.name, mediaTypes: referenceMediaTypes(reference), detail: `${number > 0 ? `Reference ${number}` : "Not in this scene yet"} · ${referenceTypeLabel(reference)}`,
      icon: <ReferenceIcon reference={reference} folderPath={folderPath} fallback={isVideoReference(reference) ? <Video16 /> : reference.kind === "audio" ? <Audio16 /> : referenceImages(reference).length ? <Image16 /> : <Text16 />} />,
    };
  }), [citable, numbered, folderPath]);
  const dangling = useMemo(() => danglingReferenceTokens(shots, references), [shots, references]);
  const settings = shot.settings ?? {};
  const shotNumber = index + 1;
  const speechLanguage = shot.speechLanguage ?? DEFAULT_SPEECH_LANGUAGE;
  const speechLanguages: readonly string[] = SPEECH_LANGUAGES.some((language) => language === speechLanguage)
    ? SPEECH_LANGUAGES
    : [...SPEECH_LANGUAGES, speechLanguage];

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
      <span className="shot-card__sublabel" aria-hidden="true">{job.sceneType === "pose" ? "Where the pose is used" : "Description"}</span>
      <PromptTextField
        id={`shot-action-${shot.id}`}
        aria-label={`Describe shot ${shotNumber}`}
        rows={6}
        value={shot.action}
        references={pickable}
        missingLabel={(referenceId) => referenceById.get(referenceId)?.name ?? "Deleted reference"}
        disabled={disabled}
        placeholder={job.sceneType === "pose" ? "Example: a dancer in a red coat performs this movement on a rainy city street." : "Example: she walks towards the camera and stops under the awning."}
        onChange={(action) => onChange({ action })}
      />
      <DanglingReferences dangling={dangling} referenceById={referenceById} />
    </div>

    {!promptOnly && <div className="shot-speech">
      <label className="shot-card__sublabel" htmlFor={`shot-speech-${shot.id}`}>Speech</label>
      <PromptTextField
        id={`shot-speech-${shot.id}`}
        value={shot.speech ?? ""}
        references={pickable.filter((reference) => referenceById.get(reference.id)?.kind === "audio")}
        referenceButtonLabel="Voice reference"
        missingLabel={(referenceId) => referenceById.get(referenceId)?.name ?? "Deleted reference"}
        missingTooltip="Speech references must be sound clips — click to replace or remove"
        disabled={disabled}
        aria-label={`Speech for shot ${shotNumber}`}
        placeholder="Words spoken in this shot"
        onChange={(speech) => onChange({ speech: speech || null })}
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
  const characters = references.filter((reference) => !isVideoReference(reference) && isVisualReference(reference)
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
  { value: "continue", label: "Continue" },
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
export function SceneInspector({ job, shots, references, folderPath = "", scenes = [], defaultSteps, defaultLook, disabled, importAvailable, importError, onAddStartFrame, onAddEndFrame, onChange, onShots, sceneType = job.sceneType ?? "first-last-frame" }: {
  sceneType?: SceneType;
  defaultLook?: string | null;
  job: GenerationJob;
  shots: SceneShot[];
  references: ProjectReference[];
  folderPath?: string;
  scenes?: GenerationJob[];
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
  const continuing = sceneType === "continue";
  const pose = sceneType === "pose";
  const characterReplace = sceneType === "character-replace";
  const transition = isVideoTransition({ sceneType });
  const look = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!;
  const id = useId();
  // The style is read off the first shot that carries one, so that is where it
  // is written. One place, never a second field that could disagree with it.
  const chosen = shots.map((shot) => shot.settings?.[look.id]?.[0]).find(Boolean) ?? "";
  const imageReferences = useMemo(
    () => selectReferences(references, ["image"]),
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
        {continuing && <>
          <PropRow label="Source scene" htmlFor={`${id}-source-scene`}>
            <ComboBox id={`${id}-source-scene`} aria-label="Source scene for continuation" disabled={disabled}
              value={job.continuationSceneId ?? ""}
              options={[{ value: "", label: "None" },
                ...(job.continuationSceneId && !scenes.some((scene) => scene.id === job.continuationSceneId)
                  ? [{ value: job.continuationSceneId, label: "Unavailable scene", disabled: true }] : []),
                ...scenes.filter((scene) => scene.id !== job.id).map((scene) => ({ value: scene.id, label: scene.title }))]}
              onChange={(value) => onChange({ continuationSceneId: value || null })} />
          </PropRow>
          <PropRow label="Take latents from" htmlFor={`${id}-continuation-from`}>
            <ComboBox id={`${id}-continuation-from`} aria-label="Take continuation latents from" disabled={disabled}
              value={job.continuationFrom ?? "end"} options={[{ value: "end", label: "End" }, { value: "start", label: "Beginning" }]}
              onChange={(value) => onChange({ continuationFrom: value as "start" | "end" })} />
          </PropRow>
          <PropRow label="Overlap frames" htmlFor={`${id}-overlap`}>
            <ComboBox id={`${id}-overlap`} aria-label="Continuation overlap frames" disabled={disabled}
              value={String(job.continuationOverlapFrames ?? DEFAULT_CONTINUATION_OVERLAP)}
              options={Array.from({ length: (MAX_CONTINUATION_OVERLAP - DEFAULT_CONTINUATION_OVERLAP) / 17 + 1 }, (_, index) => {
                const frames = DEFAULT_CONTINUATION_OVERLAP + index * 17;
                return { value: String(frames), label: String(frames) };
              })}
              onChange={(value) => onChange({ continuationOverlapFrames: Number(value) })} />
          </PropRow>
          <PropRow label="Lock Overlap" htmlFor={`${id}-lock-overlap`}>
            <ToggleSwitch id={`${id}-lock-overlap`} aria-label="Lock Overlap" checked={job.continuationLockOverlap ?? false} disabled={disabled}
              onChange={(checked) => onChange({ continuationLockOverlap: checked })} />
          </PropRow>
          <p className="prop-caption">Uses the selected scene’s saved latents. Generate it first, or use Generate all. Overlap uses 22, 39, 56, … frames at 24 fps. Lock Overlap constrains the overlapping video and audio to the source.</p>
        </>}
        {pose && <>
          <PropRow label="Pose video" htmlFor={`${id}-pose`}>
            <ComboBox id={`${id}-pose`} aria-label="Pose video reference for this scene" value={job.poseVideoReferenceId ?? ""} disabled={disabled}
              options={referenceOptions(videos, job.poseVideoReferenceId, "None", "Unavailable video reference")}
              onChange={(value) => onChange({ poseVideoReferenceId: value || null })} />
          </PropRow>
          <p className="prop-caption">Uses the saved clip range for pose and motion. Describe the subject and setting below.</p>
          {shots.map((shot, index) => <ShotInspector key={shot.id} job={job} shots={shots} shot={shot} index={index}
            endsAt={shots[index + 1]?.startSeconds ?? sceneDurationSeconds(job)} duration={sceneDurationSeconds(job)}
            references={references} folderPath={folderPath} disabled={disabled} promptOnly
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
                  ...job.referenceIds.filter((referenceId) => !references.some((reference) => reference.id === referenceId && isVideoReference(reference))),
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
          {!transition && !pose && !continuing && <>
            <PropRow label={animate ? "Repainted frame" : "Start frame"} htmlFor={`${id}-start`}>
              <ReferenceSelector
                id={`${id}-start`}
                references={references} accept={["image"]} folderPath={folderPath}
                value={animate
                  ? job.startFrameReferenceId ?? imageReferences.find((reference) => job.referenceIds.includes(reference.id))?.id ?? ""
                  : job.startFrameReferenceId ?? ""}
                disabled={disabled}
                aria-label="Start frame for this scene"
                onChange={(value) => onChange({
                  usePreviousSceneLastFrame: undefined,
                  startFrameReferenceId: value || undefined,
                  ...(animate ? {
                    endFrameReferenceId: undefined,
                    referenceIds: job.referenceIds.filter((referenceId) => !imageReferences.some((reference) => reference.id === referenceId)),
                  } : {}),
                })}
              />
              {addImageButton(animate ? "Add repainted frame" : "Add start frame", onAddStartFrame)}
            </PropRow>
            {animate && <p className="prop-caption">A frame of the driving video with the character repainted. Keep its pose, framing, background and lighting.</p>}
          </>}
          {!animate && !transition && !pose && !continuing && <PropRow label="Last frame" htmlFor={`${id}-end`}>
            <ReferenceSelector id={`${id}-end`} value={job.endFrameReferenceId ?? ""} disabled={disabled} aria-label="Last frame for this scene"
              references={references} accept={["image"]} folderPath={folderPath}
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
        <PropRow label="Separate audio steps" htmlFor={`${id}-separate-audio-steps`}>
          <ToggleSwitch id={`${id}-separate-audio-steps`} aria-label="Separate audio steps" checked={job.audioSteps != null} disabled={disabled}
            onChange={(checked) => onChange({ audioSteps: checked ? Math.min(sceneGenerationSteps(job, defaultSteps), MAX_AUDIO_GENERATION_STEPS) : undefined })} />
        </PropRow>
        {job.audioSteps != null ? <PropRow label="Audio steps" htmlFor={`${id}-audio-steps`}>
          <CommittedNumberInput id={`${id}-audio-steps`} className="text-field" minimum={2} maximum={MAX_AUDIO_GENERATION_STEPS} step={1}
            value={job.audioSteps} integer disabled={disabled} aria-label="Audio step count" onCommit={(value) => onChange({ audioSteps: value })} />
        </PropRow> : <p className="prop-caption">Audio uses the video generation step count.</p>}
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

/** A line can still name a reference the prompt can no longer use — one
 *  deleted, or switched to sound only. Its chip shows it; this says what
 *  happens to it. */
function DanglingReferences({ dangling, referenceById }: { dangling: string[]; referenceById: Map<string, ProjectReference> }) {
  if (!dangling.length) return null;
  return <InfoBar
    severity="error"
    title={dangling.length === 1 ? "A reference can’t be used" : `${dangling.length} references can’t be used`}
    message={`${dangling.map((id) => referenceById.get(id)?.name ?? "A deleted reference").join(", ")} ${dangling.length === 1 ? "is" : "are"} left out of the prompt. Swap ${dangling.length === 1 ? "it" : "each one"} for another reference or remove ${dangling.length === 1 ? "it" : "them"} from the line before generating.`}
  />;
}
