import { Plus, Sparkles, Square, Trash2, WandSparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { actionReferenceIds, compileGenerationJobPrompt, compileGenerationJobSegments, createDraftGenerationJob, danglingReferenceTokens, GENERATION_FRAME_RATE, sceneDurationSeconds, sceneGenerationReferences, sceneGenerationSeed, sceneGenerationSnapshot, sceneGenerationSteps, sceneShots, SCENE_MAX_SECONDS, SCENE_MIN_SECONDS, projectItemPath, usableImageReferences, type GenerationJob, type ProjectConfig, type ProjectReference, type PromptSegment, type SceneShot } from "../../lib/project";
import { generationDimensions } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import { cancelVidfabGeneration, enqueueVidfabGeneration, resolveVidfabPlan, type VidfabGenerationRequest, type VidfabStatus } from "../../lib/runtime";
import { SceneBoard, type GeneratorSelection } from "./SceneBoard";
import { SceneInspector, ShotInspector, STEP_SECONDS, writeShots } from "./SceneEditor";
import { statusIcon } from "./sceneStatus";

interface GeneratorViewProps {
  config: ProjectConfig;
  folderPath: string;
  runtime?: VidfabStatus | null;
  generationCompletionTimes?: Readonly<Record<string, number>>;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
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
export function GeneratorView({ config, folderPath, runtime = null, generationCompletionTimes = {}, onChange, selectedJobId }: GeneratorViewProps) {
  const jobs = config.generationJobs;
  const configRef = useRef(config);
  configRef.current = config;
  // A scene is displayed as queued while its plan is resolving, just before
  // the backend receives it. Remember cancellation here as well as sending it
  // to vidfab, so a click in that small window prevents the later enqueue.
  const cancellationRequests = useRef(new Set<string>());
  // The ref above protects asynchronous work; this set exists so the cards
  // repaint immediately when Cancel is pressed, before vidfab reports the
  // terminal cancelled state.
  const [cancellingJobIds, setCancellingJobIds] = useState<ReadonlySet<string>>(() => new Set());

  /* A scene is always what is named; the shot inside it is what a card opens.
     Opening the Generator, or arriving from a clip in the timeline, opens the
     SCENE — the thing that has a state, a prompt and a Generate button. */
  const [selection, setSelection] = useState<GeneratorSelection>(() => ({ jobId: selectedJobId ?? jobs.find((job) => job.status === "generating")?.id ?? jobs[0]?.id ?? "", shotId: null }));
  const [, setPlanNotes] = useState<Record<string, string>>({});
  const [removalTarget, setRemovalTarget] = useState<RemovalTarget | null>(null);
  const [showDebugPrompt, setShowDebugPrompt] = useState(false);
  const [startFrameError, setStartFrameError] = useState<string | null>(null);

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
  const boundRefs = useMemo(() => selected ? sceneGenerationReferences(selected, config.references) : [], [config.references, selected]);
  const runtimeReady = runtime?.state === "ready";

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

  const addStartFrame = async (job: GenerationJob) => {
    if (!isTauri()) return;
    setStartFrameError(null);
    try {
      const imported = await invoke<{ name: string; relativePath: string } | null>("choose_reference_image", { folderPath });
      if (!imported) return;
      const current = configRef.current;
      const id = `ref-${Date.now()}`;
      const reference: ProjectReference = {
        id,
        kind: "image",
        name: imported.name,
        description: "",
        relativePath: imported.relativePath,
        intendedUse: [],
        createdAt: new Date().toISOString(),
      };
      onChange({
        ...current,
        references: [reference, ...current.references],
        generationJobs: current.generationJobs.map((candidate) => candidate.id === job.id
          ? { ...candidate, startFrameReferenceId: id, updatedAt: new Date().toISOString() }
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

  const requestFor = (job: GenerationJob): VidfabGenerationRequest => {
    // Only the references actually bound to this scene, in list order. The same
    // ordered list drives the <Subject N> / <Picture N> numbering inside the
    // compiled prompt, because vidfab.rs adds reference_paths sequentially — so
    // array index 0 must be the asset the prompt calls <Picture 1>.
    const bound = sceneGenerationReferences(job, configRef.current.references);
    const canvas = generationDimensions(config.settings.resolution, config.settings.aspectRatio);
    return {
      jobId: job.id,
      // Recompiled from current state so edits to a bound reference or a
      // retimed shot reach the engine, rather than sending a prompt frozen at
      // draft-creation time. This is the ONE string vidfab is given, and it is
      // the same string the compiled-prompt panel shows.
      prompt: compileGenerationJobPrompt(job, bound),
      // The scene's own length, not a fixed six seconds.
      frames: Math.round(sceneDurationSeconds(job) * GENERATION_FRAME_RATE),
      steps: sceneGenerationSteps(job),
      seed: sceneGenerationSeed(job),
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      referencePaths: usableImageReferences(bound)
        .map((reference) => projectItemPath(folderPath, reference) ?? "")
        .filter((path) => path.length > 0),
    };
  };

  const snapshotFor = (job: GenerationJob, request = requestFor(job)): string =>
    sceneGenerationSnapshot(job, request);

  /* The engine's own events are listened for by the project screen
     (useGenerationEvents), not here: a render outlives this view, and the
     encode that turns its frames into a file has to happen wherever the user
     happens to be. What this view does with a scene is start it, stop it, and
     show what became of it. */

  const prepareOrRetry = async (job: GenerationJob) => {
    cancellationRequests.current.delete(job.id);
    setCancellingJobIds((current) => current.has(job.id)
      ? new Set([...current].filter((id) => id !== job.id))
      : current);
    const now = new Date().toISOString();
    const request = requestFor(job);
    updateJob(job.id, {
      status: runtimeReady ? "queued" : "draft",
      stage: "queued",
      progress: 0,
      error: runtimeReady ? null : runtime?.detail ?? "The video engine isn’t available on this computer right now.",
      generationSnapshot: runtimeReady ? snapshotFor(job, request) : job.generationSnapshot,
      updatedAt: now,
    });
    if (runtimeReady) await enqueueVidfabGeneration(request, configRef.current);
  };

  /* A scene now starts EMPTY. There is no box that turns a sentence into a
     scene any more: the + button adds a scene holding one blank shot, and the
     shots are written in the panel beside the board. PolStudio still writes no
     line for anyone, so the scene arrives with no words and carries
     UNTITLED_SCENE as its name rather than a phrase this app made up.

     A scene built FROM a prompt is Slop’s job: the bar along the bottom of the
     window hands the request to Claude Code or Codex, which returns the whole
     project with the new scene in it. Nothing is auto-bound either way — which
     references steer a scene is decided by writing them into a line or by the
     references already named by its shots. */
  const newScene = () => {
    const job = createDraftGenerationJob("");
    onChange({ ...config, generationJobs: [...jobs, job] });
    setSelection({ jobId: job.id, shotId: null });
  };

  const removeScene = (job: GenerationJob) => {
    const current = configRef.current;
    const at = current.generationJobs.findIndex((item) => item.id === job.id);
    if (at < 0) return;
    if (job.status === "generating" || job.status === "queued") void cancelVidfabGeneration(job.id);
    const generationJobs = current.generationJobs.filter((item) => item.id !== job.id);
    onChange({ ...current, generationJobs });
    if (selection.jobId === job.id) {
      const fallback = generationJobs[Math.min(at, generationJobs.length - 1)];
      setSelection({ jobId: fallback?.id ?? "", shotId: null });
    }
  };

  const startDraft = async (job: GenerationJob) => {
    if (!runtimeReady) return;
    cancellationRequests.current.delete(job.id);
    setCancellingJobIds((current) => current.has(job.id)
      ? new Set([...current].filter((id) => id !== job.id))
      : current);
    const request = requestFor(job);
    updateJob(job.id, {
      status: "queued",
      stage: "queued",
      error: null,
      generationSnapshot: snapshotFor(job, request),
      updatedAt: new Date().toISOString(),
    });
    try {
      /* Resolved before the job is handed over, so "What actually happened"
         reports the real frame count and canvas this run was planned as. The
         composer used to do this for a scene it had just created; a scene is
         now created empty and generated from here, so the plan is resolved
         here or nobody ever sees it. */
      const plan = await resolveVidfabPlan(request, configRef.current);
      setPlanNotes((current) => ({ ...current, [job.id]: `Planned as ${plan.alignedFrames} frames at ${plan.canvasWidth}×${plan.canvasHeight}. ${plan.boundary}` }));
      if (cancellationRequests.current.has(job.id)) return;
      await enqueueVidfabGeneration(request, configRef.current);
    } catch (reason) {
      if (cancellationRequests.current.has(job.id)) return;
      updateJob(job.id, { status: "failed", stage: "failed", error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const cancelScenes = async (scenes: GenerationJob[]) => {
    const next = scenes.filter((job) =>
      (job.status === "queued" || job.status === "generating")
      && !cancellationRequests.current.has(job.id));
    if (next.length === 0) return;
    next.forEach((job) => cancellationRequests.current.add(job.id));
    setCancellingJobIds((current) => new Set([...current, ...next.map((job) => job.id)]));
    const accepted = await Promise.all(next.map(async (job) => {
      try {
        return await cancelVidfabGeneration(job.id);
      } catch {
        return false;
      }
    }));
    // False means the scene was still in frontend planning and never reached
    // vidfab. No backend event will arrive for it, so finish that cancellation
    // locally; accepted cancellations are finalized by the normal event path.
    const beforeEnqueue = new Set(next.filter((_, index) => !accepted[index]).map((job) => job.id));
    if (beforeEnqueue.size > 0) {
      const current = configRef.current;
      onChange({
        ...current,
        generationJobs: current.generationJobs.map((job) => beforeEnqueue.has(job.id)
          ? { ...job, status: "cancelled", stage: "failed", error: "Generation cancelled before it started.", updatedAt: new Date().toISOString() }
          : job),
      });
    }
  };

  const generateScene = (job: GenerationJob) => {
    if (job.status === "queued" || job.status === "generating") {
      void cancelScenes([job]);
      return;
    }
    if (job.status === "draft") void startDraft(job);
    else void prepareOrRetry(job);
  };

  const draftScenesReady = jobs.filter((job) => job.status === "draft" && !sendBlocker(job, config.references));

  const generateAll = async () => {
    if (!runtimeReady || draftScenesReady.length === 0) return;
    draftScenesReady.forEach((job) => cancellationRequests.current.delete(job.id));
    const startingIds = new Set(draftScenesReady.map((job) => job.id));
    setCancellingJobIds((current) => {
      const next = new Set([...current].filter((id) => !startingIds.has(id)));
      return next.size === current.size ? current : next;
    });
    const current = configRef.current;
    const requests = draftScenesReady.map((job) => ({ job, request: requestFor(job) }));
    const ids = new Map(requests.map(({ job, request }) => [job.id, snapshotFor(job, request)]));
    const now = new Date().toISOString();
    onChange({
      ...current,
      generationJobs: current.generationJobs.map((job) => ids.has(job.id)
        ? { ...job, status: "queued", stage: "queued", progress: 0, error: null, generationSnapshot: ids.get(job.id), updatedAt: now }
        : job),
    });

    for (const { job, request } of requests) {
      if (cancellationRequests.current.has(job.id)) continue;
      try {
        const plan = await resolveVidfabPlan(request, current);
        setPlanNotes((notes) => ({ ...notes, [job.id]: `Planned as ${plan.alignedFrames} frames at ${plan.canvasWidth}×${plan.canvasHeight}. ${plan.boundary}` }));
        if (cancellationRequests.current.has(job.id)) continue;
        await enqueueVidfabGeneration(request, current);
      } catch (reason) {
        if (cancellationRequests.current.has(job.id)) continue;
        updateJob(job.id, { status: "failed", stage: "failed", error: reason instanceof Error ? reason.message : String(reason) });
      }
    }
  };

  const generationBlocker = (job: GenerationJob): string | null => {
    if (!runtimeReady) return runtime?.detail ?? "The video generator is not ready.";
    if (job.status === "ready") return "This scene is being saved now.";
    return sendBlocker(job, config.references);
  };

  const changedJobIds = new Set(jobs
    .filter((job) => job.status === "completed"
      && Boolean(job.generationSnapshot)
      && job.generationSnapshot !== snapshotFor(job))
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
          <span className={`generator-runtime generator-runtime--${runtime?.state ?? "checking"}`}>
            <i aria-hidden="true" /> {runtimeHeadline(runtime)}
          </span>
          {/* Adds the scene and leaves it empty. PolStudio still writes no words
              for anyone — it gives the user somewhere to write them, and the
              scene keeps the name UNTITLED_SCENE until they rename it. */}
          <button className="secondary-button" onClick={newScene} title="Add an empty scene — you write the shots">
            <Plus size={16} aria-hidden="true" /> Add Scene
          </button>
          <button
            className={cancellable.length > 0 ? "danger-button generator-heading__cancel" : "primary-button"}
            disabled={cancellable.length === 0 && (!runtimeReady || draftScenesReady.length === 0)}
            title={cancellable.length > 0
              ? `Cancel ${cancellable.length} ${cancellable.length === 1 ? "generation" : "generations"}`
              : !runtimeReady
                ? runtime?.detail ?? "The video generator is not ready."
                : draftScenesReady.length === 0
                  ? "There are no ready draft scenes to generate."
                  : `Generate ${draftScenesReady.length} draft ${draftScenesReady.length === 1 ? "scene" : "scenes"}`}
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
        onAddShot={addShot}
        onDuration={setDuration}
        onRemoveScene={(job) => setRemovalTarget({ kind: "scene", job })}
        onGenerate={generateScene}
        generationBlocker={generationBlocker}
        changedJobIds={changedJobIds}
        cancellingJobIds={cancellingJobIds}
        onMoveScene={moveScene}
        onMoveShot={moveShot}
      />}

      {/* No scenes at all — which, on a new project, is where everyone starts.
          This is the whole of the "how do I start" advice now that the composer
          is gone, so it has to name both doors: the button below, and Slop. */}
      {jobs.length === 0 && <div className="job-empty">
        <span className="job-empty__icon"><Sparkles size={26} /></span>
        <h2>Start with one scene</h2>
        <p>An empty scene is one blank shot waiting for a line. Add one, then write what should happen on screen — who or what is in frame, what they do.</p>
        <ul className="job-empty__tips">
          <li>A scene can be up to 15 seconds and split into as many shots as you like.</li>
          <li>Each shot is a card. Choose one to write its line and set it up.</li>
          <li>Drag a reference into a line and the prompt cites it as a subject.</li>
          <li>You can read the finished prompt before anything is sent.</li>
          <li>Or ask Slop in the bar along the bottom — Claude Code and Codex can write a whole scene from a prompt.</li>
        </ul>
        <button className="primary-button job-empty__add" onClick={newScene}><Plus size={16} /> Add an empty scene</button>
      </div>}
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
            <div className="job-title">
              {selected.status !== "draft" && selectedIndicator && <span className={`status-icon status-icon--${selectedIndicator}`}>{statusIcon(selectedIndicator)}</span>}
              <div>
                {/* The badge is on the scene's own line on the board, where the
                    eye compares one scene against the next. A second copy of it
                    an inch away from the first says nothing new. */}
                {/* The title is the one part of a scene PolStudio writes for the
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
          </header>

          <div className="panel-scroll">
            <SceneInspector
              key={selected.id}
              job={selected}
              shots={selectedShots}
              disabled={false}
              references={config.references}
              importAvailable={isTauri()}
              importError={startFrameError}
              onAddStartFrame={() => void addStartFrame(selected)}
              onChange={(updates) => updateScene(selected, updates)}
              onShots={(next) => setShots(selected, next)}
            />
          </div>

          <div className="debug-prompt">
            {showDebugPrompt && <CompiledPrompt segments={compileGenerationJobSegments(selected, boundRefs)} />}
            <button
              type="button"
              className="secondary-button debug-prompt__toggle"
              aria-expanded={showDebugPrompt}
              onClick={() => setShowDebugPrompt((visible) => !visible)}
            >Debug Prompt</button>
          </div>
        </>}
    </aside>}

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

/* The compiled prompt, shown before anything is sent and coloured by who wrote
   which part. The segments come from the compiler itself, so this panel is the
   string vidfab receives — not a re-rendering of it that could drift. */
function CompiledPrompt({ segments }: { segments: PromptSegment[] }) {
  return <section className="compiled-prompt" aria-label="The compiled MiniMax H3 prompt">
    <pre className="compiled-prompt__text">{segments.map((segment, index) =>
      <span key={index} className={`prompt-part prompt-part--${segment.kind}`}>{segment.value}</span>)}</pre>
  </section>;
}

const boardSummary = (active: number, waiting: number, total: number) => {
  if (total === 0) return "Nothing here yet";
  if (active > 0) return `${active} rendering · ${waiting} waiting`;
  if (waiting > 0) return `${waiting} waiting to render`;
  return total === 1 ? "1 scene" : `${total} scenes`;
};

const runtimeHeadline = (runtime: VidfabStatus | null) => {
  if (!runtime) return "Checking for the video engine…";
  switch (runtime.state) {
    case "ready": return "Video generator ready";
    case "demo": return "Preview mode";
    case "modelsMissing": return "Video model files missing";
    case "runtimeMissing": return "Video engine not installed";
    case "incompatible": return "Video engine doesn’t match";
  }
};
