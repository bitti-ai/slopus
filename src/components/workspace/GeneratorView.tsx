import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Ban, Check, ChevronRight, Clock3, FileText, Image as ImageIcon, Info, LoaderCircle, Music2, Play, Plus, RefreshCw, Sparkles, Square, Video, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolutionLabel } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import { actionReferenceIds, compileGenerationJobPrompt, compileGenerationJobSegments, createDraftGenerationJob, danglingReferenceTokens, sceneDurationSeconds, sceneShots, STORY_TRACK_ID, isReferenceDescribed, isReferenceUsable, isVisualReference, projectItemPath, usableImageReferences, type GenerationJob, type ProjectAsset, type ProjectConfig, type ProjectReference, type PromptSegment, type TimelineClip, type TimelineTrack } from "../../lib/project";
import { cancelVidfabGeneration, enqueueVidfabGeneration, resolveVidfabPlan, type VidfabGenerationRequest, type VidfabStatus } from "../../lib/runtime";
import { ReferenceImage } from "./ReferenceImage";
import { SceneEditor } from "./SceneEditor";

interface GeneratorViewProps {
  config: ProjectConfig;
  folderPath: string;
  runtime?: VidfabStatus | null;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
}

type JobStatus = GenerationJob["status"];

export function GeneratorView({ config, folderPath, runtime = null, onChange, onOpenTimeline, selectedJobId }: GeneratorViewProps) {
  const [selectedId, setSelectedId] = useState(selectedJobId ?? config.generationJobs.find((job) => job.status === "generating")?.id ?? config.generationJobs[0]?.id);
  const [planNotes, setPlanNotes] = useState<Record<string, string>>({});
  const configRef = useRef(config);
  configRef.current = config;
  const jobs = config.generationJobs;
  const selected = jobs.find((job) => job.id === selectedId);
  const active = jobs.filter((job) => job.status === "generating");
  const queued = jobs.filter((job) => job.status === "queued");
  const drafts = jobs.filter((job) => job.status === "draft");
  const completed = jobs.filter((job) => ["ready", "completed", "failed", "cancelled"].includes(job.status));
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

  useEffect(() => { if (selectedJobId) setSelectedId(selectedJobId); }, [selectedJobId]);

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    const current = configRef.current;
    onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  };

  /* An edit from the scene editor. Writing a reference into a line BINDS it to
     the scene, because binding is what gives it a <Subject N> and puts its
     picture in `reference_paths` — a citation the engine was never sent the
     reference for would point at nothing. Nothing is ever auto-unbound: taking
     a name out of one line is not a decision to stop steering the scene with it,
     and the checkbox list below is where that decision is made. */
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

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const subscriptions = Promise.all([
      listen<{ jobId: string; stage: string; step: number; totalSteps: number }>("vidfab-progress", ({ payload }) => {
        if (disposed) return;
        const progress = payload.totalSteps > 0 ? Math.min(.92, .12 + Math.max(0, payload.step) / payload.totalSteps * .72) : payload.stage === "delivering" ? .95 : .08;
        updateJob(payload.jobId, { status: "generating", stage: payload.stage === "starting" || payload.stage === "transformerLoad" ? "preparing" : "generating", progress, updatedAt: new Date().toISOString() });
      }),
      listen<{ jobId: string; state: string; detail: string }>("vidfab-job", ({ payload }) => {
        if (disposed) return;
        const updates: Partial<GenerationJob> = payload.state === "framesReady"
          ? { status: "ready", stage: "completed", progress: 1, error: payload.detail }
          : payload.state === "failed" ? { status: "failed", stage: "failed", error: payload.detail }
          : payload.state === "cancelled" ? { status: "cancelled", stage: "failed", error: payload.detail }
          : { status: "queued", stage: "queued" };
        updateJob(payload.jobId, { ...updates, updatedAt: new Date().toISOString() });
      }),
    ]);
    return () => { disposed = true; void subscriptions.then((unlisten) => unlisten.forEach((stop) => stop())); };
    // configRef keeps handlers current without resubscribing per progress tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onChange]);

  const prepareOrRetry = async (job: GenerationJob) => {
    const now = new Date().toISOString();
    updateJob(job.id, { status: runtimeReady ? "queued" : "draft", stage: "queued", progress: 0, error: runtimeReady ? null : runtime?.detail ?? "The video engine isn’t available on this computer right now.", updatedAt: now });
    if (runtimeReady) await enqueueVidfabGeneration(requestFor(job), configRef.current);
  };

  /* A scene now starts EMPTY. There is no box that turns a sentence into a
     scene any more: the + button adds a scene holding one blank shot, and the
     shots are written in the editor above. PolStudio still writes no line for
     anyone, so the scene arrives with no words and carries UNTITLED_SCENE as
     its name rather than a phrase this app made up.

     A scene built FROM a prompt is Pol’s job: the bar along the bottom of the
     window hands the request to Claude Code or Codex, which returns the whole
     project with the new scene in it. Nothing is auto-bound either way — which
     references steer a scene is decided by writing them into a line or by the
     checkbox list beside it. */
  const newScene = () => {
    const job = createDraftGenerationJob("");
    onChange({ ...config, generationJobs: [job, ...jobs] });
    setSelectedId(job.id);
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

  return <div className="generator-view">
    <aside className="queue-panel" aria-label="Scenes">
      <div className="queue-panel__title">
        <div>
          <span>Scenes</span>
          <b>{queueSummary(active.length, queued.length, jobs.length)}</b>
        </div>
        {/* Adds the scene and leaves it empty. PolStudio still writes no words
            for anyone — it gives the user somewhere to write them, and the
            scene keeps the name UNTITLED_SCENE until they rename it. */}
        <button className="queue-panel__new" onClick={newScene} aria-label="Add a scene" title="Add an empty scene — you write the shots"><Plus size={18} /></button>
      </div>
      <div className="queue-panel__scroll">
        <QueueGroup title="Rendering now" jobs={active} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Waiting to render" jobs={queued} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Drafts" jobs={drafts} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Already run" jobs={completed} selectedId={selectedId} onSelect={setSelectedId} />
        {jobs.length === 0 && <p className="queue-empty">No scenes yet. Choose + to add an empty one, or ask Pol in the bar along the bottom to build one from a prompt.</p>}
      </div>
      {/* One line: the headline already IS the status. */}
      <div className={`queue-runtime queue-runtime--${runtime?.state ?? "checking"}`}>
        <span className="queue-runtime__state"><i /> {runtimeHeadline(runtime)}</span>
      </div>
    </aside>

    <main className="generator-main">
      <header className="generator-heading">
        <h1>Generator</h1>
      </header>

      {selected && <section className="job-detail">
        <div className="job-detail__visual">
          {/* THE control on this screen: the lines the user writes, the shots
              they are split into, and the settings hung off each one. */}
          <SceneEditor
            key={selected.id}
            job={selected}
            references={config.references}
            disabled={refsLocked}
            onChange={(updates) => updateScene(selected, updates)}
          />
          {refsLocked && <p className="job-refs__empty">This scene is already with the engine. It can be changed once it finishes, and the next run will use the changes.</p>}

          {/* Every setting on this scene collapsed into the one string vidfab is
              given. Recompiled from what the scene holds right now, so it cannot
              disagree with what the next run sends. */}
          <CompiledPrompt
            segments={compileGenerationJobSegments(selected, boundRefs)}
            caption={refsLocked
              ? "This is the prompt the engine was given for the run in progress."
              : "Rebuilt from this scene’s shots, settings and references every time it is sent."}
          />

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
        </div>

        <aside className="job-detail__info">
          <div className="job-title">
            <span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span>
            <div>
              <span className="job-title__badge">{STATUS_BADGE[selected.status]}</span>
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

          {/* A labelled placeholder, never invented art — the same rule the
              scene thumb, media thumb and reference cards follow. PolStudio
              cannot display real frames yet, so it shows none. */}
          <div className={`generation-preview generation-preview--${selected.status}`}>
            {selected.status === "generating" && <span className="generation-scanner" aria-hidden="true" />}
            <span className="preview-status">{previewStatus(selected)}</span>
            <p className="generation-preview__caption">{previewCaption(selected)}</p>
          </div>

          {(planNotes[selected.id] || selected.error) && <div className="job-runtime-note">
            <span>What actually happened</span>
            <p>{planNotes[selected.id] ?? selected.error}</p>
            <small>Reported by the video engine (vidfab).</small>
          </div>}

          <dl className="job-meta">
            <div><dt>Video model</dt><dd>MiniMax H3</dd></div>
            <div><dt>Scene length</dt><dd>{sceneDurationSeconds(selected).toFixed(1)} seconds, {sceneShots(selected).length === 1 ? "one shot" : `${sceneShots(selected).length} shots`}</dd></div>
            {/* The project's own settings, not this scene's. The frame size is
                what the edit is exported at; the engine picks its own canvas
                from the shape alone (set_aspect is the only geometry vidfab
                takes), and the plan note above reports the one it picked. */}
            <div><dt>Shape</dt><dd>{config.settings.aspectRatio}</dd></div>
            <div><dt>Frame size</dt><dd>{resolutionLabel(config.settings.resolution, config.settings.aspectRatio)}</dd></div>
            <div><dt>Where it is</dt><dd>{STATUS_WORD[selected.status]}</dd></div>
            <div><dt>Saved to</dt><dd>{selected.outputRelativePath ?? "Nothing saved to disk"}</dd></div>
          </dl>

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
            {/* The request was already handed to the engine, so a change here
                would say it steered a render it never touched. */}
            {refsLocked && <p className="job-refs__empty">This scene is already with the engine. Its references can be changed once it finishes, and the next run will use them.</p>}
            {promptRefs.length === 0
              ? <p className="job-refs__empty">The video engine only follows the words above.</p>
              : <p className="job-refs__empty">{referenceRouting(promptRefs)} The tags are your own notes and don’t change what is sent.</p>}
          </div>

          <div className="job-actions">
            {blocked && !refsLocked && <p className="job-actions__note">{blocked}</p>}

            {selected.status === "generating" && <button className="danger-button" onClick={() => cancelJob(selected)}><Square size={14} /> Stop this scene</button>}

            {selected.status === "queued" && <button className="danger-button" onClick={() => cancelJob(selected)}><X size={14} /> Take out of the queue</button>}

            {selected.status === "draft" && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void startDraft(selected)}>
                <WandSparkles size={15} /> {runtimeReady ? (jobs.length === 1 ? "Generate your first scene" : "Generate this scene") : "Can’t generate yet"}
              </button>
              {/* Disclosed at the point of commitment, not after an expensive
                  run. This used to sit under the composer's submit button; the
                  button that actually starts a render is this one. */}
              {runtimeReady
                ? <p className="job-actions__limit"><Info size={16} /><span>A finished scene renders frames into memory. PolStudio can’t save them as a video file yet, so nothing lands in your project folder and there is nothing to add to the timeline.</span></p>
                : <p className="job-actions__note">This draft is saved with your project. PolStudio needs a working video engine before it can render it.</p>}
            </>}

            {(selected.status === "failed" || selected.status === "cancelled") && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Try this scene again" : "Can’t try again yet"}
              </button>
              {!runtimeReady && <p className="job-actions__note">PolStudio needs a working video engine before it can run this scene again.</p>}
            </>}

            {selected.status === "ready" && <>
              <div className="job-actions__blocked">
                <b>There is nothing to open yet</b>
                <p>The frames and sound were rendered and are held in memory, but PolStudio can’t package them into a video file yet — that step isn’t built. Nothing was written to your project folder.</p>
              </div>
              <div className="job-actions__choices">
                <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void prepareOrRetry(selected)}>
                  <RefreshCw size={15} /> {runtimeReady ? "Run this scene again" : "Can’t run it again yet"}
                </button>
                <button className="secondary-button" onClick={newScene}>
                  <Plus size={15} /> Start another scene
                </button>
              </div>
            </>}

            {selected.status === "completed" && selected.outputRelativePath && !selected.clipId && <button className="primary-button" onClick={() => insertIntoStory(selected)}><Play size={15} /> Insert into Track 1</button>}

            {selected.status === "completed" && selected.clipId && <button className="primary-button" onClick={onOpenTimeline}><Play size={15} /> Open in timeline</button>}

            {selected.status === "completed" && !selected.outputRelativePath && <>
              <button className="primary-button" disabled={!runtimeReady || Boolean(blocked)} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Run this scene again" : "Can’t run it again yet"}
              </button>
              <p className="job-actions__note">This run finished without saving a video file, so there is nothing to add to your edit.</p>
            </>}
          </div>
        </aside>
      </section>}

      {/* No scene selected — which, on a new project, means none exists. This
          is the whole of the "how do I start" advice now that the composer is
          gone, so it has to name both doors: the button below, and Pol. */}
      {!selected && <div className="job-empty">
        <span className="job-empty__icon"><Sparkles size={26} /></span>
        <h2>Start with one scene</h2>
        <p>An empty scene is one blank shot waiting for a line. Add one, then write what should happen on screen — who or what is in frame, what they do.</p>
        <ul className="job-empty__tips">
          <li>A scene can be up to 15 seconds and split into as many shots as you like.</li>
          <li>Each shot gets its own line, its own start time and its own settings.</li>
          <li>Drag a reference into a line and the prompt cites it as a subject.</li>
          <li>You can read the finished prompt before anything is sent.</li>
          <li>Or ask Pol in the bar along the bottom — Claude Code and Codex can write a whole scene from a prompt.</li>
        </ul>
        <button className="primary-button job-empty__add" onClick={newScene}><Plus size={16} /> Add an empty scene</button>
      </div>}
    </main>
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

/* The rail sits before the <h1> in the DOM, so its group titles are labelled
   groups rather than headings — otherwise the document outline would start
   mid-tree with an <h3>. */
function QueueGroup({ title, jobs, selectedId, onSelect }: { title: string; jobs: GenerationJob[]; selectedId?: string; onSelect: (id: string) => void }) {
  if (jobs.length === 0) return null;
  const labelId = `queue-group-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return <section className="queue-group" role="group" aria-labelledby={labelId}>
    <p className="queue-group__label" id={labelId}>{title}<span>{jobs.length}</span></p>
    {jobs.map((job) => <button key={job.id} className={selectedId === job.id ? "selected" : ""} onClick={() => onSelect(job.id)}>
      <span className={`queue-thumb queue-thumb--${job.status}`}>{statusIcon(job.status)}</span>
      <span className="queue-row__text">
        <b>{job.title}</b>
        <small>{queueLine(job)}</small>
        {job.status === "generating" && <i className="mini-progress"><em style={{ width: `${job.progress * 100}%` }} /></i>}
      </span>
      <ChevronRight size={16} />
    </button>)}
  </section>;
}

/* Only claim the route the bound references actually take. Saying "images are
   sent … text definitions are written into the prompt" for a scene that has only
   one of the two describes something that isn't happening. */
const referenceRouting = (references: ProjectReference[]): string => {
  const hasImage = references.some((reference) => reference.kind === "image");
  const hasText = references.some((reference) => reference.kind !== "image");
  if (hasImage && hasText) return "Images are sent to the video engine as reference assets; text definitions are written into this scene’s prompt.";
  if (hasImage) return references.length === 1
    ? "The image is sent to the video engine as a reference asset."
    : "The images are sent to the video engine as reference assets.";
  return references.length === 1
    ? "The text definition is written into this scene’s prompt."
    : "The text definitions are written into this scene’s prompt.";
};

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

const STAGES: Array<{ label: string; at: number }> = [
  { label: "Prepare", at: 0.01 },
  { label: "Render", at: 0.5 },
  { label: "Frames ready", at: 1 },
];

const STATUS_BADGE: Record<JobStatus, string> = {
  draft: "DRAFT",
  queued: "IN QUEUE",
  generating: "RENDERING",
  ready: "FRAMES RENDERED",
  completed: "FINISHED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

const STATUS_WORD: Record<JobStatus, string> = {
  draft: "Saved as a draft",
  queued: "Waiting to render",
  generating: "Rendering now",
  ready: "Frames rendered, held in memory",
  completed: "Finished",
  failed: "Stopped by an error",
  cancelled: "Stopped by you",
};

const queueSummary = (active: number, waiting: number, total: number) => {
  if (total === 0) return "Nothing here yet";
  if (active > 0) return `${active} rendering · ${waiting} waiting`;
  if (waiting > 0) return `${waiting} waiting to render`;
  return total === 1 ? "1 scene" : `${total} scenes`;
};

const queueLine = (job: GenerationJob) => {
  const shots = sceneShots(job).length;
  const shape = `${sceneDurationSeconds(job).toFixed(1)}s · ${shots === 1 ? "1 shot" : `${shots} shots`}`;
  switch (job.status) {
    case "generating": return `Rendering · ${Math.round(job.progress * 100)}%`;
    case "queued": return "Waiting its turn";
    case "draft": return `Draft — ${shape}`;
    case "ready": return "Frames rendered · no video file";
    case "completed": return job.outputRelativePath ? `Ready to use · ${shape}` : "Finished with no file";
    case "failed": return "Didn’t finish";
    case "cancelled": return "Cancelled";
  }
};

const statusIcon = (status: JobStatus) => status === "generating" ? <LoaderCircle size={16} /> : status === "completed" || status === "ready" ? <Check size={16} /> : status === "failed" ? <AlertCircle size={16} /> : status === "cancelled" ? <Ban size={16} /> : <Clock3 size={16} />;

const progressTitle = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return `${Math.round(job.progress * 100)}% rendered`;
    case "queued": return "Waiting to start";
    case "draft": return "Draft saved";
    case "ready": return "Frames rendered";
    case "completed": return job.outputRelativePath ? "Ready for your edit" : "Finished with no file";
    case "failed": return "Didn’t finish";
    case "cancelled": return "Generation stopped";
  }
};

const stageCopy = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return "The video engine is building the motion and the sound.";
    case "queued": return "Waiting for the scene ahead of it to finish.";
    case "draft": return "Saved with your project. Nothing has been rendered yet.";
    case "ready": return "The frames and sound exist in memory. PolStudio can’t package them into a video file yet.";
    case "completed": return job.outputRelativePath ? "Saved in your project and ready to drop into the timeline." : "This run ended without saving a video file.";
    case "failed": return "The run stopped before it finished. You can try it again.";
    case "cancelled": return "You stopped this one. You can run it again.";
  }
};

const previewStatus = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return <><LoaderCircle size={15} /> Rendering {Math.round(job.progress * 100)}%</>;
    case "queued": return <><Clock3 size={15} /> Waiting in queue</>;
    case "draft": return <><Clock3 size={15} /> Draft — nothing rendered</>;
    case "ready": return <><Check size={15} /> Frames rendered</>;
    case "completed": return job.outputRelativePath ? <><Check size={15} /> Ready for your edit</> : <><AlertCircle size={15} /> No video file was saved</>;
    case "failed": return <><AlertCircle size={15} /> Generation failed</>;
    case "cancelled": return <><Ban size={15} /> Generation cancelled</>;
  }
};

/* Says out loud why the placeholder is empty, so the blank surface is never
   read as "the picture failed to load". */
const previewCaption = (job: GenerationJob): string => {
  switch (job.status) {
    case "generating": return "Frames are being built now. PolStudio can’t show them while they are still in memory.";
    case "queued": return "This scene hasn’t started, so there is no picture to show.";
    case "draft": return "Nothing has been rendered, so there is no picture to show.";
    case "ready": return "The frames exist in memory only. PolStudio can’t display or save them yet.";
    case "completed": return job.outputRelativePath ? "A video file was saved. Open it in the timeline to watch it." : "This run ended without a video file, so there is no picture to show.";
    case "failed": return "The run stopped before any frames were kept.";
    case "cancelled": return "You stopped this run, so no frames were kept.";
  }
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
