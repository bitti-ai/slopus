import type { GenerationSubmission } from "../../lib/workQueue";
import { loadLoras, subscribeLoras } from "../../lib/loras";
import { refreshDownloadedLoras } from "../../lib/weightDownloads";
import { usableVideoReferences } from "../../lib/project";
import { ChevronDown, Plus, Square, Trash2, WandSparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { actionReferenceIds, compileGenerationJobPrompt, compileGenerationJobSegments, createDraftGenerationJob, danglingReferenceTokens, GENERATION_FRAME_RATE, RANDOM_GENERATION_SEED, sceneDurationSeconds, sceneFrameInputs, sceneGenerationSeed, sceneGenerationSnapshot, sceneGenerationSteps, sceneShots, SCENE_MAX_SECONDS, SCENE_MIN_SECONDS, projectItemPath, usableReferenceImages, type GenerationJob, type ProjectConfig, type ProjectReference, type SceneShot } from "../../lib/project";
import { generationDimensions } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import { getEngineStatus, type SlopfabGenerationRequest, type SlopfabStatus } from "../../lib/runtime";
import { SceneBoard, type GeneratorSelection } from "./SceneBoard";
import { SceneInspector, ShotInspector, STEP_SECONDS, writeShots } from "./SceneEditor";
import { statusIcon } from "./sceneStatus";
import { forgetShotPosters } from "./ShotThumbnail";
import { purgeTimelineThumbnails } from "../../lib/timelineThumbnails";
import { defaultGeneratorTemplate, loadDebugOptionsEnabled, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, subscribeDebugOptions, subscribeGeneratorTemplates, templateNeedsDownload, type GeneratorTemplate } from "../../lib/settings";
import { refreshDownloadedWeights } from "../../lib/weightDownloads";
import { DebugPromptDialog } from "./DebugPromptDialog";

interface GeneratorViewProps {
  config: ProjectConfig;
  folderPath: string;
  runtime?: SlopfabStatus | null;
  generationCompletionTimes?: Readonly<Record<string, number>>;
  onChange: (next: ProjectConfig) => void;
  onGenerate?: (submissions: GenerationSubmission[]) => void;
  onCancelGeneration?: (sceneIds: string[]) => Promise<void>;
  cancellingJobIds?: ReadonlySet<string>;
  onOpenTimeline: () => void;
  selectedJobId?: string;
  onRuntimeChange?: (runtime: SlopfabStatus) => void;
}

type RemovalTarget =
  | { kind: "scene"; job: GenerationJob }
  | { kind: "shot"; job: GenerationJob; shotId: string; shotName: string };

/* The Generator is a BOARD and a PANEL.
 *
 * The board is every scene in the project, each one a row of shot cards reading
 * left to right in the order they play, separated by the line that carries the
 * scene's own name, state and settings. A card is the summary of a shot: its
 * picture once the scene has been rendered, the line written for it, and the
 * settings hung off it.
 *
 * The panel is whatever is open — one shot, or the scene itself. Nothing is
 * edited on the board, and nothing is duplicated in the panel: there is exactly
 * one place to change any given thing. */
export function GeneratorView({ config, folderPath, runtime = null, generationCompletionTimes = {}, onChange, selectedJobId, onRuntimeChange, onGenerate, onCancelGeneration, cancellingJobIds = new Set() }: GeneratorViewProps) {
  const jobs = config.generationJobs;
  const [templateSettings, setTemplateSettings] = useState(loadGeneratorTemplateSettings);
  const selectedTemplate = defaultGeneratorTemplate(templateSettings);
  const defaultGenerationSteps = selectedTemplate.defaultSteps;
  const [generatorRuntime, setGeneratorRuntime] = useState<SlopfabStatus | null>(runtime);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const runtimeProbe = useRef(0);
  const [loraLibrary, setLoraLibrary] = useState(loadLoras);
  useEffect(() => subscribeLoras(() => setLoraLibrary(loadLoras())), []);
  const templateKey = JSON.stringify([selectedTemplate.id, selectedTemplate.paths, selectedTemplate.attention, selectedTemplate.loras, loraLibrary]);
  const probedTemplate = useRef(templateKey);
  const configRef = useRef(config);
  configRef.current = config;
  /* A scene is always what is named; the shot inside it is what a card opens.
     Opening the Generator, or arriving from a clip in the timeline, opens the
     SCENE — the thing that has a state, a prompt and a Generate button. */
  const [selection, setSelection] = useState<GeneratorSelection>(() => ({ jobId: selectedJobId ?? jobs.find((job) => job.status === "generating")?.id ?? jobs[0]?.id ?? "", shotId: null }));
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const [showDebugPrompt, setShowDebugPrompt] = useState(false);
  const debugEnabled = useSyncExternalStore(subscribeDebugOptions, loadDebugOptionsEnabled);
  const [startFrameError, setStartFrameError] = useState<string | null>(null);

  useEffect(() => {
    if (!debugEnabled) setShowDebugPrompt(false);
  }, [debugEnabled]);

  useEffect(() => {
    setTemplateSettings(loadGeneratorTemplateSettings());
    setGeneratorRuntime(runtime);
    setRuntimeError(null);
  }, [runtime]);

  useEffect(() => () => { runtimeProbe.current += 1; }, []);
  useEffect(() => subscribeGeneratorTemplates(() => setTemplateSettings(loadGeneratorTemplateSettings())), []);
  useEffect(() => {
    const refresh = () => { void Promise.all([refreshDownloadedWeights(), refreshDownloadedLoras()]).catch((reason) => setRuntimeError(String(reason))); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);

  const chooseGeneratorTemplate = (templateId: string) => {
    const template = templateSettings.templates.find((candidate) => candidate.id === templateId);
    if (!template || templateNeedsDownload(template) || template.id === templateSettings.defaultTemplateId) return;
    const next = { ...templateSettings, defaultTemplateId: template.id };
    saveGeneratorTemplateSettings(next);
    setTemplateSettings(next);
  };

  useEffect(() => {
    if (probedTemplate.current === templateKey) return;
    probedTemplate.current = templateKey;
    setGeneratorRuntime(null);
    setRuntimeError(null);
    const probe = ++runtimeProbe.current;
    if (!selectedTemplate.id) return;
    void getEngineStatus(selectedTemplate.paths, selectedTemplate.attention, selectedTemplate.loras ?? []).then((status) => {
      if (probe !== runtimeProbe.current) return;
      setGeneratorRuntime(status);
      onRuntimeChange?.(status);
    }).catch((reason: unknown) => {
      if (probe !== runtimeProbe.current) return;
      setRuntimeError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [templateKey]);

  useEffect(() => { if (selectedJobId) setSelection({ jobId: selectedJobId, shotId: null }); }, [selectedJobId]);

  /* A scene can be deleted, and a shot can be removed, from under the panel.
     Falling back to the first scene beats a panel pointing at nothing. */
  const selected = jobs.find((job) => job.id === selection.jobId) ?? jobs[0];
  const selectedShots = useMemo(() => (selected ? sceneShots(selected) : []), [selected]);
  const shotIndex = selectedShots.findIndex((shot) => shot.id === selection.shotId);
  const openShot = shotIndex >= 0 ? selectedShots[shotIndex] : null;

  const active = jobs.filter((job) => job.status === "generating" || job.status === "ready");
  const queued = jobs.filter((job) => job.status === "queued");
  const cancellable = jobs.filter((job) => job.status === "queued" || job.status === "generating");
  const frameInputs = useMemo(() => selected ? sceneFrameInputs(selected, config) : null, [config, selected]);
  const boundRefs = frameInputs?.references ?? [];
  const runtimeReady = Boolean(selectedTemplate.id) && generatorRuntime?.state === "ready";

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    const current = configRef.current;
    onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  };

  /* An edit from the panel. Writing a reference into a line BINDS it to the
     scene, because binding is what gives it a <Subject N> and puts its picture
     in `reference_paths` — a citation the engine was never sent the reference
     for would point at nothing. Nothing is ever auto-unbound: taking a name out
     of one line is not a decision to stop steering the scene with it, and the
     reference library is where those references themselves are managed. */
  const mergeSceneUpdates = (job: GenerationJob, updates: Partial<GenerationJob>): GenerationJob => {
    const next: Partial<GenerationJob> = { ...updates, updatedAt: new Date().toISOString() };
    if (updates.shots) {
      const referenceIds = [...job.referenceIds];
      for (const shot of updates.shots) {
        for (const id of actionReferenceIds(shot.action)) {
          if (!referenceIds.includes(id) && config.references.some((reference) => reference.id === id)) referenceIds.push(id);
        }
      }
      next.referenceIds = referenceIds;
    }
    return { ...job, ...next };
  };

  const updateScene = (job: GenerationJob, updates: Partial<GenerationJob>) =>
    updateJob(job.id, mergeSceneUpdates(job, updates));

  const addFrame = async (job: GenerationJob, edge: "start" | "end") => {
    if (!isTauri()) return;
    setStartFrameError(null);
    try {
      const imported = await invoke<{ name: string; relativePath: string } | null>("choose_reference_image", { folderPath });
      if (!imported) return;
      const current = configRef.current;
      const id = `ref-${Date.now()}`;
      const reference: ProjectReference = {
        id,
        kind: "text",
        name: imported.name,
        description: "",
        images: [{ id: `${id}-image`, name: imported.name, relativePath: imported.relativePath }],
        intendedUse: [],
        createdAt: new Date().toISOString(),
      };
      onChange({
        ...current,
        references: [reference, ...current.references],
        generationJobs: current.generationJobs.map((candidate) => candidate.id === job.id
          ? { ...candidate, ...(edge === "start" ? { startFrameReferenceId: id, usePreviousSceneLastFrame: undefined } : { endFrameReferenceId: id }), updatedAt: new Date().toISOString() }
          : candidate),
      });
    } catch (reason) {
      setStartFrameError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  /* --- The shots of a scene ------------------------------------------------
     Every one of these goes through writeShots, so the mirrored `prompt` and
     `creativeBrief` can never fall behind the lines they mirror. */

  const setShots = (job: GenerationJob, next: SceneShot[], extra: Partial<GenerationJob> = {}) =>
    updateScene(job, writeShots(job, next, extra));

  const patchShot = (job: GenerationJob, shotId: string, updates: Partial<SceneShot>) =>
    setShots(job, sceneShots(job).map((shot) => shot.id === shotId ? { ...shot, ...updates } : shot));

  const addShot = (job: GenerationJob) => {
    const shots = sceneShots(job);
    const duration = sceneDurationSeconds(job);
    const last = shots[shots.length - 1];
    const halfway = Math.round(((last.startSeconds + duration) / 2) / STEP_SECONDS) * STEP_SECONDS;
    const start = Math.min(duration, Math.max(last.startSeconds + STEP_SECONDS, halfway));
    const shot: SceneShot = { id: `shot-${crypto.randomUUID()}`, startSeconds: start, action: "" };
    setShots(job, [...shots, shot]);
    // The new card is blank, so open it: there is nowhere else to write it.
    setSelection({ jobId: job.id, shotId: shot.id });
  };

  const removeShot = (job: GenerationJob, shotId: string) => {
    const shots = sceneShots(job);
    // A scene is at least one shot: with none there is nowhere to write, and
    // the compiler would have nothing to make a [Shot 1] out of.
    if (shots.length <= 1) return;
    setShots(job, shots.filter((shot) => shot.id !== shotId));
    setSelection({ jobId: job.id, shotId: null });
  };

  const setDuration = (job: GenerationJob, value: number) => {
    const next = Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, Math.round(value / STEP_SECONDS) * STEP_SECONDS));
    // A shot cannot start after the scene ends, so shortening the scene pulls
    // the later cuts back with it rather than leaving them past the end.
    setShots(job, sceneShots(job).map((shot) => ({ ...shot, startSeconds: Math.min(shot.startSeconds, next) })), { durationSeconds: next });
  };

  const moveScene = (jobId: string, beforeJobId: string | null) => {
    const current = configRef.current;
    const moving = current.generationJobs.find((job) => job.id === jobId);
    if (!moving || beforeJobId === jobId) return;
    const without = current.generationJobs.filter((job) => job.id !== jobId);
    const index = beforeJobId === null ? without.length : without.findIndex((job) => job.id === beforeJobId);
    if (index < 0) return;
    const generationJobs = [...without.slice(0, index), moving, ...without.slice(index)];
    onChange({ ...current, generationJobs });
  };

  /** Reordering keeps the existing cut slots. A cross-scene move inserts a new
   * cut between its neighbours (or at the end), so array order and playback
   * order remain the same even though scene shots are normalized by time. */
  const moveShot = (sourceJobId: string, shotId: string, targetJobId: string, beforeShotId: string | null) => {
    const current = configRef.current;
    const source = current.generationJobs.find((job) => job.id === sourceJobId);
    const target = current.generationJobs.find((job) => job.id === targetJobId);
    if (!source || !target) return;
    const sourceShots = sceneShots(source);
    const moving = sourceShots.find((shot) => shot.id === shotId);
    if (!moving) return;

    if (source.id === target.id) {
      const without = sourceShots.filter((shot) => shot.id !== shotId);
      const index = beforeShotId === null ? without.length : without.findIndex((shot) => shot.id === beforeShotId);
      if (index < 0) return;
      const ordered = [...without.slice(0, index), moving, ...without.slice(index)];
      const starts = sourceShots.map((shot) => shot.startSeconds);
      const retimed = ordered.map((shot, at) => ({ ...shot, startSeconds: starts[at] }));
      const updated = mergeSceneUpdates(source, writeShots(source, retimed));
      onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === source.id ? updated : job) });
      setSelection({ jobId: source.id, shotId });
      return;
    }

    // A scene with no shots cannot be represented or edited.
    if (sourceShots.length <= 1) return;
    const targetShots = sceneShots(target);
    const insertAt = beforeShotId === null ? targetShots.length : targetShots.findIndex((shot) => shot.id === beforeShotId);
    if (insertAt < 0) return;
    const inserted = { ...moving, startSeconds: 0 };
    const orderedTargetShots = [...targetShots.slice(0, insertAt), inserted, ...targetShots.slice(insertAt)];
    const targetDuration = sceneDurationSeconds(target);
    // A destination gains a cut, so divide its available time again. This
    // avoids a zero-length shot when one is dropped at either edge.
    const nextTargetShots = orderedTargetShots.map((shot, at) => ({
      ...shot,
      startSeconds: at === 0 ? 0 : Math.min(targetDuration, Math.round((targetDuration * at / orderedTargetShots.length) / STEP_SECONDS) * STEP_SECONDS),
    }));
    const nextSourceShots = sourceShots.filter((shot) => shot.id !== shotId);
    const updatedSource = mergeSceneUpdates(source, writeShots(source, nextSourceShots));
    const updatedTarget = mergeSceneUpdates(target, writeShots(target, nextTargetShots));
    onChange({
      ...current,
      generationJobs: current.generationJobs.map((job) => job.id === source.id ? updatedSource : job.id === target.id ? updatedTarget : job),
    });
    setSelection({ jobId: target.id, shotId });
  };

  const requestFor = (job: GenerationJob): SlopfabGenerationRequest => {
    // Only the references actually bound to this scene, in list order. The same
    // ordered list drives the <Subject N> / <Picture N> numbering inside the
    // compiled prompt, because slopfab.rs adds reference_paths sequentially — so
    // array index 0 must be the asset the prompt calls <Picture 1>.
    const inputs = sceneFrameInputs(job, configRef.current);
    const bound = inputs.references;
    const canvas = generationDimensions(config.settings.resolution, config.settings.aspectRatio);
    return {
      jobId: job.id,
      // Recompiled from current state so edits to a bound reference or a
      // retimed shot reach the engine, rather than sending a prompt frozen at
      // draft-creation time. This is the ONE string slopfab is given, and it is
      // the same string the compiled-prompt panel shows.
      prompt: compileGenerationJobPrompt(inputs.job, bound),
      ...(inputs.previousSceneId ? { previousSceneId: inputs.previousSceneId } : {}),
      // The scene's own length, not a fixed six seconds.
      frames: Math.round(sceneDurationSeconds(job) * GENERATION_FRAME_RATE),
      steps: sceneGenerationSteps(job, defaultGenerationSteps),
      seed: sceneGenerationSeed(job),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      referencePaths: usableReferenceImages(bound)
        .map((image) => projectItemPath(folderPath, image) ?? "")
        .filter((path) => path.length > 0),
      referenceVideos: usableVideoReferences(bound).map((reference) => ({
        name: reference.name, relativePath: reference.relativePath, sourcePath: reference.sourcePath,
        startSeconds: reference.video?.startSeconds ?? 0,
        durationSeconds: reference.video?.durationSeconds ?? 2,
        includeAudio: reference.video?.includeAudio ?? true,
      })),
    };
  };

  const snapshotFor = (job: GenerationJob, request = requestFor(job)): string =>
    sceneGenerationSnapshot(job, request);

  const purgeSceneThumbnails = async (job: GenerationJob) => {
    if (job.outputRelativePath) forgetShotPosters(folderPath, job.outputRelativePath);
    await purgeTimelineThumbnails(folderPath, job.id).catch(() => undefined);
  };

  const submit = (scenes: GenerationJob[]) => {
    if (!runtimeReady) return;
    const submissions = scenes.map((job) => {
      const request = requestFor(job);
      return { job, request, snapshot: snapshotFor(job, request) };
    });
    try { onGenerate?.(submissions); }
    catch (reason) { setRuntimeError(reason instanceof Error ? reason.message : String(reason)); }
  };

  /* A scene now starts EMPTY. There is no box that turns a sentence into a
     scene any more: the + button adds a scene holding one blank shot, and the
     shots are written in the panel beside the board. Slopus still writes no
     line for anyone, so the scene arrives with no words and carries
     UNTITLED_SCENE as its name rather than a phrase this app made up.

     A scene built FROM a prompt is Slop’s job: the bar along the bottom of the
     window hands the request to Claude Code or Codex, which returns a compact
     command batch that Slopus applies. Nothing is auto-bound either way — which
     references steer a scene is decided by writing them into a line or by the
     references already named by its shots. */
  const newScene = () => {
    const job = createDraftGenerationJob("", { steps: defaultGenerationSteps });
    onChange({ ...config, generationJobs: [...jobs, job] });
    setSelection({ jobId: job.id, shotId: null });
  };

  const removeScene = (job: GenerationJob) => {
    const current = configRef.current;
    const at = current.generationJobs.findIndex((item) => item.id === job.id);
    if (at < 0) return;
    void purgeSceneThumbnails(job);
    if (job.status === "generating" || job.status === "queued") void onCancelGeneration?.([job.id]);
    const generationJobs = current.generationJobs.filter((item) => item.id !== job.id);
    onChange({ ...current, generationJobs });
    if (selection.jobId === job.id) {
      const fallback = generationJobs[Math.min(at, generationJobs.length - 1)];
      setSelection({ jobId: fallback?.id ?? "", shotId: null });
    }
  };

  const cancelScenes = (scenes: GenerationJob[]) => onCancelGeneration?.(scenes.map((job) => job.id));
  const generateScene = (job: GenerationJob) => {
    if (job.status === "queued" || job.status === "generating") void cancelScenes([job]);
    else submit([job]);
  };

  /** Generate All is an idempotent update for fixed seeds, but a deliberate
   * reroll for random ones. A completed fixed-seed scene is current only when
   * both its output and the exact renderer-input snapshot still exist. */
  const batchScenesReady: GenerationJob[] = [];
  for (const [index, job] of jobs.entries()) {
    if (job.status === "queued" || job.status === "generating" || job.status === "ready") continue;
    if (job.usePreviousSceneLastFrame && index === 0) continue;
    if (sendBlocker(job, config.references)) continue;
    const previous = jobs[index - 1];
    const previousWillRender = job.usePreviousSceneLastFrame && previous &&
      (batchScenesReady.includes(previous) || ["queued", "generating", "ready"].includes(previous.status));
    if (previousWillRender || sceneGenerationSeed(job) === RANDOM_GENERATION_SEED || job.status !== "completed"
      || !job.outputRelativePath
      || !job.generationSnapshot
      || job.generationSnapshot !== snapshotFor(job)) batchScenesReady.push(job);
  }

  const generateAll = () => submit(batchScenesReady);

  const generationBlocker = (job: GenerationJob): string | null => {
    if (!runtimeReady) return runtimeError ?? generatorRuntime?.detail ?? "The video generator is not ready.";
    if (job.status === "ready") return "This scene is being saved now.";
    if (job.usePreviousSceneLastFrame && jobs[0]?.id === job.id) return "This scene needs a previous scene to supply its first frame.";
    return sendBlocker(job, config.references);
  };

  const changedJobIds = new Set(jobs
    .filter((job, index) => job.status === "completed"
      && Boolean(job.generationSnapshot)
      && (job.generationSnapshot !== snapshotFor(job)
        || (job.usePreviousSceneLastFrame && ["queued", "generating", "ready"].includes(jobs[index - 1]?.status))))
    .map((job) => job.id));
  const selectedIndicator = selected && changedJobIds.has(selected.id) ? "changed" : selected?.status;

  return <div className={`generator-view ${selected ? "" : "generator-view--empty"}`}>
    <main className="generator-main">
      <header className="generator-heading">
        <div className="generator-heading__title">
          <h1>Generator</h1>
          <p>{boardSummary(active.length, queued.length, jobs.length)}</p>
        </div>
        <div className="generator-heading__actions">
          {/* One line: the headline already IS the status. */}
          <div
            className={`generator-runtime generator-runtime--${runtimeError ? "unavailable" : generatorRuntime?.state ?? "checking"}`}
            title={runtimeError ?? generatorRuntime?.detail ?? runtimeHeadline(generatorRuntime)}
          >
            <i role="img" aria-label={runtimeError ? "Video generator unavailable" : runtimeHeadline(generatorRuntime)} />
            <span className="generator-runtime__label">Generator:</span>
            <GeneratorTemplateCombobox templates={templateSettings.templates.filter((template) => !templateNeedsDownload(template))} selected={selectedTemplate} onChange={chooseGeneratorTemplate} />
            {(runtimeError || (generatorRuntime?.state !== "ready" && generatorRuntime?.state !== "modelsMissing")) && <span className="generator-runtime__status" aria-hidden="true">{runtimeError ? "Unavailable" : runtimeHeadline(generatorRuntime)}</span>}
          </div>
          <button
            className={cancellable.length > 0 ? "danger-button generator-heading__cancel" : "primary-button"}
            disabled={cancellable.length === 0 && active.length > 0}
            title={cancellable.length > 0
              ? `Cancel ${cancellable.length} ${cancellable.length === 1 ? "generation" : "generations"}`
              : !runtimeReady
                ? runtimeError ?? generatorRuntime?.detail ?? "The video generator is not ready."
                : active.length > 0
                  ? "Generation is still being saved."
                  : batchScenesReady.length === 0
                    ? "Every fixed-seed scene is already up to date."
                    : `Generate ${batchScenesReady.length} ${batchScenesReady.length === 1 ? "scene" : "scenes"}`}
            onClick={() => cancellable.length > 0 ? void cancelScenes(cancellable) : void generateAll()}
          >
            {cancellable.length > 0
              ? <><Square size={15} aria-hidden="true" /> Cancel All</>
              : <><WandSparkles size={16} aria-hidden="true" /> Generate All</>}
          </button>
        </div>
      </header>

      {jobs.length > 0 && <SceneBoard
        jobs={jobs}
        folderPath={folderPath}
        generationCompletionTimes={generationCompletionTimes}
        references={config.references}
        selection={{ jobId: selected?.id ?? "", shotId: openShot?.id ?? null }}
        onSelect={setSelection}
        onAddScene={newScene}
        onAddShot={addShot}
        onDuration={setDuration}
        onGenerate={generateScene}
        generationBlocker={generationBlocker}
        changedJobIds={changedJobIds}
        cancellingJobIds={cancellingJobIds}
        onMoveScene={moveScene}
        onMoveShot={moveShot}
      />}

      {jobs.length === 0 && <button
        type="button"
        className="shot-card shot-card--add scene-card--add"
        onClick={newScene}
        title="Add an empty scene — you write the shots"
      >
        <Plus size={18} aria-hidden="true" />
        <span>Add a scene</span>
      </button>}
    </main>

    {selected && <aside className="generator-panel" aria-label={openShot ? `${openShot.name ?? `Shot ${shotIndex + 1}`} of ${selected.title}` : `Scene: ${selected.title}`}>
      {openShot
        ? <>
          <header className="panel-head">
            {/* The way back up: the scene this shot belongs to, which is the
                same thing its line on the board opens. */}
            <button type="button" className="panel-head__up" onClick={() => setSelection({ jobId: selected.id, shotId: null })}>
              {selected.title}
            </button>
            <div className="panel-head__shot-title">
              <h2><input
                className="shot-title__name"
                value={openShot.name ?? ""}
                placeholder={`Shot ${shotIndex + 1}`}
                aria-label={`Rename shot ${shotIndex + 1}`}
                title="Rename this shot"
                onChange={(event) => patchShot(selected, openShot.id, { name: event.target.value || null })}
              /></h2>
              {selectedShots.length > 1 && <button
                type="button"
                className="inspector-remove-button"
                aria-label={`Remove shot ${shotIndex + 1}`}
                title="Remove this shot"
                onClick={() => setRemovalTarget({ kind: "shot", job: selected, shotId: openShot.id, shotName: openShot.name ?? `Shot ${shotIndex + 1}` })}
              ><Trash2 size={16} aria-hidden="true" /></button>}
            </div>
          </header>
          <div className="panel-scroll">
            <ShotInspector
              key={openShot.id}
              job={selected}
              shots={selectedShots}
              shot={openShot}
              index={shotIndex}
              endsAt={shotIndex + 1 < selectedShots.length ? selectedShots[shotIndex + 1].startSeconds : sceneDurationSeconds(selected)}
              duration={sceneDurationSeconds(selected)}
              references={config.references}
              disabled={false}
              onChange={(updates) => patchShot(selected, openShot.id, updates)}
            />
          </div>
        </>
        : <>
          <header className="panel-head">
            <div className="panel-head__scene-title">
              <div className="job-title">
                {selected.status !== "draft" && selectedIndicator && <span className={`status-icon status-icon--${selectedIndicator}`}>{statusIcon(selectedIndicator)}</span>}
                <div>
                  {/* The badge is on the scene's own line on the board, where the
                      eye compares one scene against the next. A second copy of it
                      an inch away from the first says nothing new. */}
                  {/* The title is the one part of a scene Slopus writes for the
                      user — taken from their first words — so it has to be theirs
                      to change. Blanking it falls back rather than saving a
                      nameless scene the schema would reject. */}
                  <h2><input
                    className="job-title__name"
                    value={selected.title}
                    aria-label={`Rename ${selected.title}`}
                    title="Rename this scene"
                    onChange={(event) => updateJob(selected.id, { title: event.target.value || "Untitled scene", updatedAt: new Date().toISOString() })}
                  /></h2>
                </div>
              </div>
              <button
                type="button"
                className="inspector-remove-button"
                aria-label={`Remove scene ${selected.title}`}
                title="Remove this scene"
                onClick={() => setRemovalTarget({ kind: "scene", job: selected })}
              ><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          </header>

          <div className="panel-scroll">
            <SceneInspector
              key={selected.id}
              job={selected}
              shots={selectedShots}
              defaultSteps={defaultGenerationSteps}
              disabled={false}
              references={config.references}
              importAvailable={isTauri()}
              importError={startFrameError}
              previousScene={jobs[jobs.findIndex((job) => job.id === selected.id) - 1]}
              onAddStartFrame={() => void addFrame(selected, "start")}
              onAddEndFrame={() => void addFrame(selected, "end")}
              onChange={(updates) => updateScene(selected, updates)}
              onShots={(next) => setShots(selected, next)}
            />
          </div>

          {debugEnabled && <div className="debug-prompt">
            <button
              type="button"
              className="secondary-button debug-prompt__toggle"
              aria-expanded={showDebugPrompt}
              aria-haspopup="dialog"
              onClick={() => setShowDebugPrompt(true)}
            >Debug Prompt</button>
          </div>}
        </>}
    </aside>}

    {debugEnabled && showDebugPrompt && selected && !openShot && <DebugPromptDialog
      sceneTitle={selected.title}
      segments={compileGenerationJobSegments(frameInputs?.job ?? selected, boundRefs)}
      onClose={() => setShowDebugPrompt(false)}
    />}

    {removalTarget && <div className="remove-dialog-backdrop">
      <div className="remove-dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-dialog-title">
        <h2 id="remove-dialog-title">Remove {removalTarget.kind}?</h2>
        <p>{removalTarget.kind === "scene"
          ? `Remove “${removalTarget.job.title}” and all of its shots?`
          : `Remove “${removalTarget.shotName}” from “${removalTarget.job.title}”?`}</p>
        <div>
          <button type="button" className="secondary-button" onClick={() => setRemovalTarget(null)}>Cancel</button>
          <button type="button" className="danger-button" onClick={() => {
            if (removalTarget.kind === "scene") removeScene(removalTarget.job);
            else removeShot(removalTarget.job, removalTarget.shotId);
            setRemovalTarget(null);
          }}>Remove {removalTarget.kind}</button>
        </div>
      </div>
    </div>}
  </div>;
}

/** Why this scene cannot be handed to the engine, in the user's words, or null.
 *  Each one is a real state of the scene, not a policy: a scene with no words
 *  has nothing to render, a scene of no length is no frames at all, and a name
 *  the prompt cannot cite would be silently dropped from the middle of a line. */
function sendBlocker(job: GenerationJob, references: ProjectReference[]): string | null {
  const shots = sceneShots(job);
  if (shots.every((shot) => shot.action.trim().length === 0 && !(shot.speech ?? "").trim())) {
    return "Describe what happens or add speech in at least one shot before this scene can be generated.";
  }
  if (sceneDurationSeconds(job) <= 0) {
    return "This scene is nought seconds long, so there are no frames to render. Give it a length first.";
  }
  const dangling = danglingReferenceTokens(shots, references);
  if (dangling.length > 0) {
    return "A reference named in one of the lines can no longer be used, and would be left out of the prompt. Swap it for another one or take it out of the line first.";
  }
  return null;
}

const boardSummary = (active: number, waiting: number, total: number) => {
  if (total === 0) return "Nothing here yet";
  if (active > 0) return `${active} rendering · ${waiting} waiting`;
  if (waiting > 0) return `${waiting} waiting to render`;
  return total === 1 ? "1 scene" : `${total} scenes`;
};

const runtimeHeadline = (runtime: SlopfabStatus | null) => {
  if (!runtime) return "Checking for the video engine…";
  switch (runtime.state) {
    case "ready": return "Video generator ready";
    case "demo": return "Preview mode";
    case "modelsMissing": return "Video model files missing";
    case "runtimeMissing": return "Video engine not installed";
    case "incompatible": return "Video engine doesn’t match";
  }
};

function GeneratorTemplateCombobox({ templates, selected, onChange }: {
  templates: GeneratorTemplate[];
  selected: GeneratorTemplate;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scrollDistance, setScrollDistance] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const measure = () => {
      const value = valueRef.current;
      setScrollDistance(value ? Math.max(0, value.scrollWidth - value.clientWidth) : 0);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [selected.id, selected.name]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    optionRefs.current[templates.findIndex((template) => template.id === selected.id)]?.focus();
    return () => document.removeEventListener("pointerdown", close);
  }, [open, selected.id, templates]);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const pick = (id: string) => {
    onChange(id);
    closeAndFocus();
  };

  const moveOptionFocus = (index: number, direction: number) => {
    const next = (index + direction + templates.length) % templates.length;
    optionRefs.current[next]?.focus();
  };

  return <div className={`generator-runtime__select${open ? " generator-runtime__select--open" : ""}`} ref={rootRef}>
    <button
      ref={triggerRef}
      type="button"
      className="generator-runtime__trigger"
      role="combobox"
      disabled={templates.length === 0}
      aria-label={`Video generator template: ${selected.name}`}
      aria-expanded={open}
      aria-haspopup="listbox"
      aria-controls="generator-template-options"
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
        } else if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
        }
      }}
    >
      <span
        ref={valueRef}
        className={`generator-runtime__value${scrollDistance > 0 ? " generator-runtime__value--overflow" : ""}`}
        style={{ "--template-scroll-distance": `-${scrollDistance}px` } as React.CSSProperties}
        title={selected.name}
      ><span>{selected.name}</span></span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && <div className="generator-runtime__options" id="generator-template-options" role="listbox" aria-label="Generator templates">
      {templates.map((template, index) => <button
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        role="option"
        aria-selected={template.id === selected.id}
        title={template.name}
        key={template.id}
        onClick={() => pick(template.id)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            moveOptionFocus(index, 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveOptionFocus(index, -1);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            optionRefs.current[event.key === "Home" ? 0 : templates.length - 1]?.focus();
          } else if (event.key === "Escape") {
            event.preventDefault();
            closeAndFocus();
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      ><span>{template.name}</span>{template.id === selected.id && <i aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
