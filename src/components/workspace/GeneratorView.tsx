import { Ban, Check, FileText, Image as ImageIcon, LoaderCircle, Music2, Play, Plus, RefreshCw, Sparkles, Square, Video, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolutionLabel } from "../../lib/export";
import { actionReferenceIds, compileGenerationJobPrompt, compileGenerationJobSegments, createDraftGenerationJob, danglingReferenceTokens, sceneDurationSeconds, sceneShots, SCENE_MAX_SECONDS, SCENE_MIN_SECONDS, STORY_TRACK_ID, isReferenceDescribed, isReferenceUsable, isVisualReference, projectItemPath, usableImageReferences, type GenerationJob, type ProjectAsset, type ProjectConfig, type ProjectReference, type PromptSegment, type SceneShot, type TimelineClip, type TimelineTrack } from "../../lib/project";
import { cancelVidfabGeneration, enqueueVidfabGeneration, resolveVidfabPlan, type VidfabGenerationRequest, type VidfabStatus } from "../../lib/runtime";
import { ReferenceImage } from "./ReferenceImage";
import { SceneBoard, type GeneratorSelection } from "./SceneBoard";
import { SceneInspector, ShotInspector, STEP_SECONDS, writeShots } from "./SceneEditor";
import { progressTitle, stageCopy, statusIcon, STATUS_WORD } from "./sceneStatus";

interface GeneratorViewProps {
  config: ProjectConfig;
  folderPath: string;
  runtime?: VidfabStatus | null;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
}

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
export function GeneratorView({ config, folderPath, runtime = null, onChange, onOpenTimeline, selectedJobId }: GeneratorViewProps) {
  const jobs = config.generationJobs;
  const configRef = useRef(config);
  configRef.current = config;

  /* A scene is always what is named; the shot inside it is what a card opens.
     Opening the Generator, or arriving from a clip in the timeline, opens the
     SCENE — the thing that has a state, a prompt and a Generate button. */
  const [selection, setSelection] = useState<GeneratorSelection>(() => ({ jobId: selectedJobId ?? jobs.find((job) => job.status === "generating")?.id ?? jobs[0]?.id ?? "", shotId: null }));
  const [planNotes, setPlanNotes] = useState<Record<string, string>>({});

  useEffect(() => { if (selectedJobId) setSelection({ jobId: selectedJobId, shotId: null }); }, [selectedJobId]);

  /* A scene can be deleted, and a shot can be removed, from under the panel.
     Falling back to the first scene beats a panel pointing at nothing. */
  const selected = jobs.find((job) => job.id === selection.jobId) ?? jobs[0];
  const selectedShots = useMemo(() => (selected ? sceneShots(selected) : []), [selected]);
  const shotIndex = selectedShots.findIndex((shot) => shot.id === selection.shotId);
  const openShot = shotIndex >= 0 ? selectedShots[shotIndex] : null;

  const active = jobs.filter((job) => job.status === "generating" || job.status === "ready");
  const queued = jobs.filter((job) => job.status === "queued");
  // Queued and generating scenes have already been handed to the engine with
  // their references attached; re-binding now would change nothing about that
  // run while claiming otherwise.
  const refsLocked = selected?.status === "generating" || selected?.status === "queued";
  const boundRefs = useMemo(() => config.references.filter((ref) => selected?.referenceIds.includes(ref.id)), [config.references, selected]);
  // Bound is not the same as used. The compiler drops a reference that isn't
  // described yet, and isVisualReference drops an audio-only one, so a count
  // taken from the IDs alone told the user a definition was steering the scene
  // when the compiled prompt never mentioned it.
  const promptRefs = useMemo(() => boundRefs.filter((ref) => isReferenceUsable(ref) && isVisualReference(ref)), [boundRefs]);
  const runtimeReady = runtime?.state === "ready";
  /* Why this scene cannot be sent, or null. Every one of these is a state the
     user can see and fix; the button says the reason rather than sitting grey. */
  const blocked = selected ? sendBlocker(selected, config.references) : null;

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    const current = configRef.current;
    onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  };

  /* An edit from the panel. Writing a reference into a line BINDS it to the
     scene, because binding is what gives it a <Subject N> and puts its picture
     in `reference_paths` — a citation the engine was never sent the reference
     for would point at nothing. Nothing is ever auto-unbound: taking a name out
     of one line is not a decision to stop steering the scene with it, and the
     checkbox list in the scene panel is where that decision is made. */
  const updateScene = (job: GenerationJob, updates: Partial<GenerationJob>) => {
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
    updateJob(job.id, next);
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

  const requestFor = (job: GenerationJob): VidfabGenerationRequest => {
    // Only the references actually bound to this scene, in list order. The same
    // ordered list drives the <Subject N> / <Picture N> numbering inside the
    // compiled prompt, because vidfab.rs adds reference_paths sequentially — so
    // array index 0 must be the asset the prompt calls <Picture 1>.
    const bound = configRef.current.references.filter((reference) => job.referenceIds.includes(reference.id));
    return {
      jobId: job.id,
      // Recompiled from current state so edits to a bound reference or a
      // retimed shot reach the engine, rather than sending a prompt frozen at
      // draft-creation time. This is the ONE string vidfab is given, and it is
      // the same string the compiled-prompt panel shows.
      prompt: compileGenerationJobPrompt(job, bound),
      // The scene's own length, not a fixed six seconds.
      frames: Math.round(sceneDurationSeconds(job) * config.settings.frameRate),
      steps: 50,
      seed: 482091,
      aspectRatio: config.settings.aspectRatio,
      referencePaths: usableImageReferences(bound)
        .map((reference) => projectItemPath(folderPath, reference) ?? "")
        .filter((path) => path.length > 0),
    };
  };

  /* The engine's own events are listened for by the project screen
     (useGenerationEvents), not here: a render outlives this view, and the
     encode that turns its frames into a file has to happen wherever the user
     happens to be. What this view does with a scene is start it, stop it, and
     show what became of it. */

  const prepareOrRetry = async (job: GenerationJob) => {
    const now = new Date().toISOString();
    updateJob(job.id, { status: runtimeReady ? "queued" : "draft", stage: "queued", progress: 0, error: runtimeReady ? null : runtime?.detail ?? "The video engine isn’t available on this computer right now.", updatedAt: now });
    if (runtimeReady) await enqueueVidfabGeneration(requestFor(job), configRef.current);
  };

  /* A scene now starts EMPTY. There is no box that turns a sentence into a
     scene any more: the + button adds a scene holding one blank shot, and the
     shots are written in the panel beside the board. PolStudio still writes no
     line for anyone, so the scene arrives with no words and carries
     UNTITLED_SCENE as its name rather than a phrase this app made up.

     A scene built FROM a prompt is Pol’s job: the bar along the bottom of the
     window hands the request to Claude Code or Codex, which returns the whole
     project with the new scene in it. Nothing is auto-bound either way — which
     references steer a scene is decided by writing them into a line or by the
     checkbox list beside it. */
  const newScene = () => {
    const job = createDraftGenerationJob("");
    onChange({ ...config, generationJobs: [job, ...jobs] });
    setSelection({ jobId: job.id, shotId: null });
  };

  const startDraft = async (job: GenerationJob) => {
    if (!runtimeReady) return;
    updateJob(job.id, { status: "queued", stage: "queued", error: null, updatedAt: new Date().toISOString() });
    try {
      /* Resolved before the job is handed over, so "What actually happened"
         reports the real frame count and canvas this run was planned as. The
         composer used to do this for a scene it had just created; a scene is
         now created empty and generated from here, so the plan is resolved
         here or nobody ever sees it. */
      const request = requestFor(job);
      const plan = await resolveVidfabPlan(request, configRef.current);
      setPlanNotes((current) => ({ ...current, [job.id]: `Planned as ${plan.alignedFrames} frames at ${plan.canvasWidth}×${plan.canvasHeight}. ${plan.boundary}` }));
      await enqueueVidfabGeneration(request, configRef.current);
    } catch (reason) {
      updateJob(job.id, { error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const insertIntoStory = (job: GenerationJob) => {
    if (!job.outputRelativePath) return;
    const now = new Date().toISOString();
    const lengthMs = Math.round(sceneDurationSeconds(job) * 1000);
    const existingAsset = config.assets.find((asset) => asset.relativePath === job.outputRelativePath);
    const asset: ProjectAsset = existingAsset ?? { id: `asset-${crypto.randomUUID()}`, kind: "generated", name: job.title, relativePath: job.outputRelativePath, mimeType: "video/mp4", durationMs: lengthMs, createdAt: now };
    /* By id first: tracks can be renamed, and matching on the name alone made
       a renamed first video track invisible here — the next insert built a
       second one beside it. The name check is the fallback for projects saved
       before the id was fixed, when the track was still called "Story". */
    const existingStory = config.timeline.tracks.find((track) => track.id === STORY_TRACK_ID)
      ?? config.timeline.tracks.find((track) => track.kind === "video" && track.name === "Story");
    const story: TimelineTrack = existingStory ?? { id: STORY_TRACK_ID, kind: "video", name: "Track 1", locked: false, muted: false, clips: [] };
    if (story.locked) return;
    const startMs = story.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    const clip: TimelineClip = { id: `clip-${crypto.randomUUID()}`, assetId: asset.id, trackId: story.id, startMs, durationMs: asset.durationMs || lengthMs || 1, sourceStartMs: 0, label: job.title, color: "#4f6ba8", status: "generated" };
    const tracks = existingStory ? config.timeline.tracks.map((track) => track.id === story.id ? { ...track, clips: [...track.clips, clip] } : track) : [{ ...story, clips: [clip] }, ...config.timeline.tracks];
    onChange({ ...config, assets: existingAsset ? config.assets : [...config.assets, asset], timeline: { tracks }, generationJobs: jobs.map((item) => item.id === job.id ? { ...item, clipId: clip.id, updatedAt: now } : item) });
    onOpenTimeline();
  };

  /* Binding order does not matter: requestFor and the compiler both read
     config.references in list order and keep whatever this scene names, so the
     <Subject N> / <Picture N> numbering stays in lockstep however the boxes are
     ticked. */
  const toggleReference = (job: GenerationJob, referenceId: string) => {
    const referenceIds = job.referenceIds.includes(referenceId)
      ? job.referenceIds.filter((id) => id !== referenceId)
      : [...job.referenceIds, referenceId];
    updateJob(job.id, { referenceIds, updatedAt: new Date().toISOString() });
  };

  const cancelJob = (job: GenerationJob) => {
    if (job.status === "generating" || job.status === "queued") void cancelVidfabGeneration(job.id);
    updateJob(job.id, { status: "cancelled", stage: "failed", updatedAt: new Date().toISOString() });
  };

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
            <Plus size={16} aria-hidden="true" /> Add a scene
          </button>
        </div>
      </header>

      {jobs.length > 0 && <SceneBoard
        jobs={jobs}
        folderPath={folderPath}
        references={config.references}
        selection={{ jobId: selected?.id ?? "", shotId: openShot?.id ?? null }}
        onSelect={setSelection}
        onAddShot={addShot}
      />}

      {/* No scenes at all — which, on a new project, is where everyone starts.
          This is the whole of the "how do I start" advice now that the composer
          is gone, so it has to name both doors: the button below, and Pol. */}
      {jobs.length === 0 && <div className="job-empty">
        <span className="job-empty__icon"><Sparkles size={26} /></span>
        <h2>Start with one scene</h2>
        <p>An empty scene is one blank shot waiting for a line. Add one, then write what should happen on screen — who or what is in frame, what they do.</p>
        <ul className="job-empty__tips">
          <li>A scene can be up to 15 seconds and split into as many shots as you like.</li>
          <li>Each shot is a card. Choose one to write its line and set it up.</li>
          <li>Drag a reference into a line and the prompt cites it as a subject.</li>
          <li>You can read the finished prompt before anything is sent.</li>
          <li>Or ask Pol in the bar along the bottom — Claude Code and Codex can write a whole scene from a prompt.</li>
        </ul>
        <button className="primary-button job-empty__add" onClick={newScene}><Plus size={16} /> Add an empty scene</button>
      </div>}
    </main>

    {selected && <aside className="generator-panel" aria-label={openShot ? `Shot ${shotIndex + 1} of ${selected.title}` : `Scene: ${selected.title}`}>
      {openShot
        ? <>
          <header className="panel-head">
            {/* The way back up: the scene this shot belongs to, which is the
                same thing its line on the board opens. */}
            <button type="button" className="panel-head__up" onClick={() => setSelection({ jobId: selected.id, shotId: null })}>
              {selected.title} · Scene settings
            </button>
            <h2>Shot {shotIndex + 1}<small>of {selectedShots.length === 1 ? "one shot" : `${selectedShots.length} shots`}</small></h2>
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
              disabled={refsLocked}
              removable={selectedShots.length > 1}
              onChange={(updates) => patchShot(selected, openShot.id, updates)}
              onRemove={() => removeShot(selected, openShot.id)}
            />
            {refsLocked && <p className="job-refs__empty">This scene is already with the engine. It can be changed once it finishes, and the next run will use the changes.</p>}
          </div>
        </>
        : <>
          <header className="panel-head">
            <div className="job-title">
              <span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span>
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
            <div className="job-progress-block">
              <div className="job-progress-block__head">
                <b>{progressTitle(selected)}</b>
                <span>{stageCopy(selected)}</span>
              </div>
              <div className="progress-track"><i style={{ width: `${selected.progress * 100}%` }} /></div>
              <ol className="stage-rail">
                {STAGES.map((stage, index) => {
                  const done = selected.progress > 0 && selected.progress >= stage.at;
                  return <li key={stage.label} className={done ? "done" : ""}>
                    <i>{done ? <Check size={14} /> : index + 1}</i>
                    <span>{stage.label}</span>
                  </li>;
                })}
                <li className="stage-rail__blocked">
                  <i><Ban size={14} /></i>
                  <span>Save as a video file<small>Not built yet</small></span>
                </li>
              </ol>
            </div>

            {(planNotes[selected.id] || selected.error) && <div className="job-runtime-note">
              <span>What actually happened</span>
              <p>{planNotes[selected.id] ?? selected.error}</p>
              <small>Reported by the video engine (vidfab).</small>
            </div>}

            {/* How long the scene runs, where its cuts fall, and the three
                things the H3 guide defines once per prompt. */}
            <SceneInspector
              key={selected.id}
              job={selected}
              shots={selectedShots}
              disabled={refsLocked}
              onChange={(updates) => updateScene(selected, updates)}
              onShots={(next) => setShots(selected, next)}
              onDuration={(value) => setDuration(selected, value)}
              onSelectShot={(shotId) => setSelection({ jobId: selected.id, shotId })}
            />

            {refsLocked && <p className="job-refs__empty">This scene is already with the engine. It can be changed once it finishes, and the next run will use the changes.</p>}

            <div className="job-refs">
              <span>{promptRefs.length === 0 ? "No references used by this scene" : promptRefs.length === 1 ? "1 reference guides this scene" : `${promptRefs.length} references guide this scene`}</span>
              {/* Every reference in the project, each a checkbox: which ones steer
                  a scene is the user's decision. Writing one into a line ticks it
                  here; unticking it takes it out of the prompt and out of what is
                  sent to the engine. A bound reference the prompt skips stays
                  listed with its reason — hiding it would leave the user
                  wondering where it went. */}
              {config.references.map((ref) => {
                const bound = selected.referenceIds.includes(ref.id);
                const picture = ref.kind === "image" && (ref.relativePath || ref.sourcePath);
                const skipped = skipReason(ref);
                return <label key={ref.id} className={`job-ref ${bound ? "job-ref--bound" : ""}`}>
                  <input
                    type="checkbox"
                    checked={bound}
                    disabled={refsLocked}
                    onChange={() => toggleReference(selected, ref.id)}
                  />
                  {/* The reference's real picture, not a stand-in. aria-hidden
                      because the name it illustrates is the next node in this
                      same <label>, and repeating it would say every reference
                      twice when the checkbox announces itself. */}
                  <span className="ref-mini" aria-hidden="true">
                    {picture
                      ? <ReferenceImage folderPath={folderPath} relativePath={ref.relativePath} sourcePath={ref.sourcePath} alt="" />
                      : referenceKindIcon(ref.kind)}
                  </span>
                  <b>{ref.name}</b>
                  {skipped
                    ? <p className="job-refs__reason">{skipped}</p>
                    : bound && !isReferenceDescribed(ref)
                      // Used, but incomplete: the picture goes to the engine while
                      // nothing tells it what to keep. Silence here let a
                      // boilerplate-filled card look finished.
                      ? <p className="job-refs__reason">Not described yet — the picture is sent, but nothing tells the engine what to keep.</p>
                      : ref.intendedUse.length > 0 && <small>Your tags: {ref.intendedUse.join(", ")}</small>}
                </label>;
              })}
              {config.references.length === 0 && <p className="job-refs__empty">This project has no references yet. Add one under References and it can steer this scene.</p>}
              {/* Only the empty case says anything now. With references actually
                  bound, the list above already shows what each one is and what is
                  wrong with any that will not be used; a paragraph restating the
                  route every one of them takes was a sentence about the system
                  rather than about this scene. */}
              {promptRefs.length === 0 && <p className="job-refs__empty">The video engine only follows the words in the shots.</p>}
            </div>

            {/* Every setting on this scene collapsed into the one string vidfab is
                given. Recompiled from what the scene holds right now, so it cannot
                disagree with what the next run sends. */}
            <CompiledPrompt
              segments={compileGenerationJobSegments(selected, boundRefs)}
              caption={refsLocked
                ? "This is the prompt the engine was given for the run in progress."
                : "Rebuilt from this scene’s shots, settings and references every time it is sent."}
            />

            <dl className="job-meta">
              <div><dt>Video model</dt><dd>MiniMax H3</dd></div>
              <div><dt>Scene length</dt><dd>{sceneDurationSeconds(selected).toFixed(1)} seconds, {selectedShots.length === 1 ? "one shot" : `${selectedShots.length} shots`}</dd></div>
              {/* The project's own settings, not this scene's. The frame size is
                  what the edit is exported at; the engine picks its own canvas
                  from the shape alone (set_aspect is the only geometry vidfab
                  takes), and the plan note above reports the one it picked. */}
              <div><dt>Shape</dt><dd>{config.settings.aspectRatio}</dd></div>
              <div><dt>Frame size</dt><dd>{resolutionLabel(config.settings.resolution, config.settings.aspectRatio)}</dd></div>
              <div><dt>Where it is</dt><dd>{STATUS_WORD[selected.status]}</dd></div>
              <div><dt>Saved to</dt><dd>{selected.outputRelativePath ?? "Nothing saved to disk"}</dd></div>
            </dl>
          </div>

          <div className="job-actions">
            {blocked && !refsLocked && <p className="job-actions__note">{blocked}</p>}

            {selected.status === "generating" && <button className="danger-button" onClick={() => cancelJob(selected)}><Square size={14} /> Stop this scene</button>}

            {selected.status === "queued" && <button className="danger-button" onClick={() => cancelJob(selected)}><X size={14} /> Take out of the queue</button>}

            {selected.status === "draft" && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void startDraft(selected)}>
                <WandSparkles size={15} /> {runtimeReady ? (jobs.length === 1 ? "Generate your first scene" : "Generate this scene") : "Can’t generate yet"}
              </button>
              {!runtimeReady && <p className="job-actions__note">This draft is saved with your project. PolStudio needs a working video engine before it can render it.</p>}
            </>}

            {(selected.status === "failed" || selected.status === "cancelled") && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Try this scene again" : "Can’t try again yet"}
              </button>
              {!runtimeReady && <p className="job-actions__note">PolStudio needs a working video engine before it can run this scene again.</p>}
            </>}

            {/* Between the last frame and the file: the pictures are rendered
                and are being encoded into an .mp4 in the project folder. It is
                a real step with a real duration — a few hundred megabytes
                through the machine's encoder — so it is a state, not a
                flicker. */}
            {selected.status === "ready" && <p className="job-actions__note">
              <LoaderCircle size={15} className="spin" /> Saving this scene into your project folder…
            </p>}

            {selected.status === "completed" && selected.outputRelativePath && !selected.clipId && <>
              <button className="primary-button" onClick={() => insertIntoStory(selected)}><Play size={15} /> Insert into Track 1</button>
              <p className="job-actions__note">Saved to <code>{selected.outputRelativePath}</code>.</p>
            </>}

            {/* Something was left out of the file — the scene is finished and
                the file exists, so this is a note rather than a failure. */}
            {selected.status === "completed" && selected.outputRelativePath && selected.error && <p className="job-actions__note">{selected.error}</p>}

            {selected.status === "completed" && selected.clipId && <button className="primary-button" onClick={onOpenTimeline}><Play size={15} /> Open in timeline</button>}

            {selected.status === "completed" && !selected.outputRelativePath && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Run this scene again" : "Can’t run it again yet"}
              </button>
              <p className="job-actions__note">This run finished without a video file in your project folder, so there is nothing to add to your edit.</p>
            </>}
          </div>
        </>}
    </aside>}
  </div>;
}

/** Why this scene cannot be handed to the engine, in the user's words, or null.
 *  Each one is a real state of the scene, not a policy: a scene with no words
 *  has nothing to render, a scene of no length is no frames at all, and a name
 *  the prompt cannot cite would be silently dropped from the middle of a line. */
function sendBlocker(job: GenerationJob, references: ProjectReference[]): string | null {
  const shots = sceneShots(job);
  if (shots.every((shot) => shot.action.trim().length === 0)) {
    return "Write what happens in at least one shot before this scene can be generated.";
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
function CompiledPrompt({ segments, caption }: { segments: PromptSegment[]; caption: string }) {
  return <section className="compiled-prompt" aria-label="The compiled MiniMax H3 prompt">
    <span className="compiled-prompt__title">The prompt this scene becomes</span>
    <p className="compiled-prompt__key">
      <em className="compiled-prompt__swatch compiled-prompt__swatch--brief">your words</em>
      <em className="compiled-prompt__swatch compiled-prompt__swatch--tag">your settings</em>
      <em className="compiled-prompt__swatch compiled-prompt__swatch--frame">the H3 format, added by PolStudio</em>
    </p>
    <pre className="compiled-prompt__text">{segments.map((segment, index) =>
      <span key={index} className={`prompt-part prompt-part--${segment.kind}`}>{segment.value}</span>)}</pre>
    <small>{caption}</small>
  </section>;
}

/* Why a reference that is bound to this scene never reaches its prompt, or null
   when it does. The wording mirrors the References card so the two screens
   describe the same state in the same words. */
const skipReason = (reference: ProjectReference): string | null => {
  if (!isReferenceUsable(reference)) return "Not described yet — not used by this scene";
  if (!isVisualReference(reference)) return "Tagged as a sound note, so it isn’t sent to the video engine.";
  return null;
};

/* The stand-in for a reference whose own picture is not being shown. The four
   kinds get four icons, which they did not before: an `image` arm sat here that
   nothing could reach — referenceSchema refuses an image with no file, so a
   parsed image reference always has one and always renders the real picture —
   while `video` and `audio`, which DO reach here (they are pointed at rather
   than copied, and ReferenceImage cannot show a frame of either), fell through
   to the same page icon a written definition gets. Same icons as
   MediaThumbnail, so a clip and the reference it came from read alike. */
const referenceKindIcon = (kind: ProjectReference["kind"]) =>
  kind === "video" ? <Video size={16} />
    : kind === "audio" ? <Music2 size={16} />
      /* Unreachable for anything zod parsed; kept so a future kind that can
         legitimately arrive without a file is not silently called a document. */
      : kind === "image" ? <ImageIcon size={16} />
        : <FileText size={16} />;

/* The three things that happen to a scene, in the order they happen. "Save" is
   the encode: the engine's pictures being written into an .mp4 in the project
   folder, which is the last tenth of the bar. */
const STAGES: Array<{ label: string; at: number }> = [
  { label: "Prepare", at: 0.01 },
  { label: "Render", at: 0.5 },
  { label: "Save", at: 0.9 },
];

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
