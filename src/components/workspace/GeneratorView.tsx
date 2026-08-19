import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Ban, Check, ChevronRight, Clock3, Film, Info, LoaderCircle, Play, Plus, RefreshCw, Sparkles, Square, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "../../lib/persistence";
import { compileMiniMaxH3Prompt, compileMiniMaxH3PromptSegments, createDraftGenerationJob, STORY_TRACK_ID, isReferenceDescribed, isReferenceUsable, isVisualReference, projectItemPath, shotTagSelectionSchema, usableImageReferences, type GenerationJob, type ProjectAsset, type ProjectConfig, type ProjectReference, type TimelineClip, type TimelineTrack } from "../../lib/project";
import { countShotTags, hasCameraMovement, normalizeShotTagSelection, selectedShotTagOptions, SHOT_TAG_GROUPS, toggleShotTag, type ShotTagSelection } from "../../lib/shot-tags";
import { cancelVidfabGeneration, enqueueVidfabGeneration, resolveVidfabPlan, type VidfabGenerationRequest, type VidfabStatus } from "../../lib/runtime";

interface GeneratorViewProps {
  config: ProjectConfig;
  folderPath: string;
  runtime?: VidfabStatus | null;
  onChange: (next: ProjectConfig) => void;
  onOpenTimeline: () => void;
  selectedJobId?: string;
  /** Composer text, held by the parent. Switching tabs unmounts this view, and
   *  keeping the half-written shot in local state threw the user's own words
   *  away — the one thing this app is not allowed to do. Optional so the view
   *  still works standalone; it falls back to its own state. */
  draftPrompt?: string;
  onDraftPromptChange?: (value: string) => void;
}

type JobStatus = GenerationJob["status"];

export function GeneratorView({ config, folderPath, runtime = null, onChange, onOpenTimeline, selectedJobId, draftPrompt, onDraftPromptChange }: GeneratorViewProps) {
  const [selectedId, setSelectedId] = useState(selectedJobId ?? config.generationJobs.find((job) => job.status === "generating")?.id ?? config.generationJobs[0]?.id);
  const [ownPrompt, setOwnPrompt] = useState("");
  const prompt = draftPrompt ?? ownPrompt;
  const setPrompt: (value: string) => void = onDraftPromptChange ?? setOwnPrompt;
  /* The tags on the shot being written. They belong to the half-written shot,
     not to the project, so they live outside the config until it is created —
     but switching tabs unmounts this view, and dropping a dozen deliberate
     choices on the way back is the same loss the composer text was rescued
     from. Parked per project, exactly like the media panel's layout habit. */
  const draftTagsKey = `polstudio.draft-shot-tags.v1:${config.id}`;
  const [draftTags, setDraftTagsState] = useState<ShotTagSelection>(() => readDraftTags(draftTagsKey));
  const setDraftTags = (next: ShotTagSelection) => {
    setDraftTagsState(next);
    writeDraftTags(draftTagsKey, next);
  };
  const [planNotes, setPlanNotes] = useState<Record<string, string>>({});
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const jobs = config.generationJobs;
  const selected = jobs.find((job) => job.id === selectedId);
  const active = jobs.filter((job) => job.status === "generating");
  const queued = jobs.filter((job) => job.status === "queued");
  const drafts = jobs.filter((job) => job.status === "draft");
  const completed = jobs.filter((job) => ["ready", "completed", "failed", "cancelled"].includes(job.status));
  // Queued and generating shots have already been handed to the engine with
  // their references attached; re-binding now would change nothing about that
  // run while claiming otherwise.
  const refsLocked = selected?.status === "generating" || selected?.status === "queued";
  const boundRefs = useMemo(() => config.references.filter((ref) => selected?.referenceIds.includes(ref.id)), [config.references, selected]);
  // Bound is not the same as used. compileMiniMaxH3Prompt drops a reference that
  // isn't described yet, and isVisualReference drops an audio-only one, so a
  // count taken from the IDs alone told the user a definition was steering the
  // shot when the compiled prompt never mentioned it.
  const promptRefs = useMemo(() => boundRefs.filter((ref) => isReferenceUsable(ref) && isVisualReference(ref)), [boundRefs]);
  // The references a NEW shot would bind and the compiler would then keep. Both
  // filters, or the hint promises a reference the prompt drops and a legacy
  // audio-only one eats a binding slot a real reference should have had.
  const usableReferences = useMemo(
    () => config.references.filter((ref) => isReferenceUsable(ref) && isVisualReference(ref)),
    [config.references],
  );
  const runtimeReady = runtime?.state === "ready";
  const submitLabel = runtimeReady ? "Generate this shot" : "Save as a draft";

  useEffect(() => { if (selectedJobId) setSelectedId(selectedJobId); }, [selectedJobId]);

  const updateJob = (id: string, updates: Partial<GenerationJob>) => {
    const current = configRef.current;
    onChange({ ...current, generationJobs: current.generationJobs.map((job) => job.id === id ? { ...job, ...updates } : job) });
  };
  const requestFor = (job: GenerationJob): VidfabGenerationRequest => {
    // Only the references actually bound to this job, in list order. The same
    // ordered list drives the <Picture N> numbering inside the compiled prompt,
    // because vidfab.rs adds reference_paths sequentially — so array index 0
    // must be the asset the prompt calls <Picture 1>.
    const bound = configRef.current.references.filter((reference) => job.referenceIds.includes(reference.id));
    return {
      jobId: job.id,
      // Recompiled from current state so edits to a bound reference or a
      // retagged shot reach the engine, rather than sending a prompt frozen at
      // draft-creation time. This is the ONE string vidfab is given, and it is
      // the same string the compiled-prompt panel shows.
      prompt: compileMiniMaxH3Prompt(job.creativeBrief, bound, job.shotTags ?? null),
      frames: Math.round(6 * config.settings.frameRate),
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

  const createJob = async () => {
    // Never synthesise a prompt: a shot must only ever describe what the user
    // actually typed, or it gets read back to them as their own request.
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    // Same pair the compiler applies, so a bound reference is always one that
    // actually reaches the prompt.
    const bound = config.references.filter((ref) => isReferenceUsable(ref) && isVisualReference(ref)).slice(0, 2);
    const draft = createDraftGenerationJob(cleanPrompt, { referenceIds: bound.map((ref) => ref.id), references: bound, shotTags: draftTags });
    const job: GenerationJob = runtimeReady ? { ...draft, status: "queued" } : draft;
    const next = { ...config, generationJobs: [job, ...jobs] };
    onChange(next);
    setSelectedId(job.id);
    setPrompt("");
    // The tags moved into the shot, so the composer starts clean for the next
    // one rather than silently applying the last shot's camera to it.
    setDraftTags({});
    try {
      const request = requestFor(job);
      const plan = await resolveVidfabPlan(request, next);
      setPlanNotes((current) => ({ ...current, [job.id]: `Planned as ${plan.alignedFrames} frames at ${plan.canvasWidth}×${plan.canvasHeight}. ${plan.boundary}` }));
      if (runtimeReady) await enqueueVidfabGeneration(request, next);
      else updateJob(job.id, { error: runtime?.detail ?? "The video engine isn’t available, so this was kept as an editable draft." });
    } catch (reason) {
      updateJob(job.id, { error: reason instanceof Error ? reason.message : String(reason) });
    }
  };

  const startDraft = async (job: GenerationJob) => {
    if (!runtimeReady) return;
    updateJob(job.id, { status: "queued", stage: "queued", error: null, updatedAt: new Date().toISOString() });
    await enqueueVidfabGeneration(requestFor(job), configRef.current);
  };

  const insertIntoStory = (job: GenerationJob) => {
    if (!job.outputRelativePath) return;
    const now = new Date().toISOString();
    const existingAsset = config.assets.find((asset) => asset.relativePath === job.outputRelativePath);
    const asset: ProjectAsset = existingAsset ?? { id: `asset-${crypto.randomUUID()}`, kind: "generated", name: job.title, relativePath: job.outputRelativePath, mimeType: "video/mp4", durationMs: 6_000, createdAt: now };
    /* By id first: tracks can be renamed, and matching on the name alone made
       a renamed first video track invisible here — the next insert built a
       second one beside it. The name check is the fallback for projects saved
       before the id was fixed, when the track was still called "Story". */
    const existingStory = config.timeline.tracks.find((track) => track.id === STORY_TRACK_ID)
      ?? config.timeline.tracks.find((track) => track.kind === "video" && track.name === "Story");
    const story: TimelineTrack = existingStory ?? { id: STORY_TRACK_ID, kind: "video", name: "Track 1, Video", locked: false, muted: false, clips: [] };
    if (story.locked) return;
    const startMs = story.clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
    const clip: TimelineClip = { id: `clip-${crypto.randomUUID()}`, assetId: asset.id, trackId: story.id, startMs, durationMs: asset.durationMs ?? 6_000, sourceStartMs: 0, label: job.title, color: "#4f6ba8", status: "generated" };
    const tracks = existingStory ? config.timeline.tracks.map((track) => track.id === story.id ? { ...track, clips: [...track.clips, clip] } : track) : [{ ...story, clips: [clip] }, ...config.timeline.tracks];
    onChange({ ...config, assets: existingAsset ? config.assets : [...config.assets, asset], timeline: { tracks }, generationJobs: jobs.map((item) => item.id === job.id ? { ...item, clipId: clip.id, updatedAt: now } : item) });
    onOpenTimeline();
  };

  // "Keep drafting other shots" has to be a real control, not advice, so the
  // ready state always has somewhere to go.
  const focusComposer = () => {
    const node = composerRef.current;
    if (!node) return;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center" });
    node.focus();
  };

  /* Binding order does not matter: requestFor and the compiler both read
     config.references in list order and keep whatever this job names, so the
     <Picture N> numbering stays in lockstep however the boxes are ticked. */
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
    <aside className="queue-panel" aria-label="Shots">
      <div className="queue-panel__title">
        <div>
          <span>Shots</span>
          <b>{queueSummary(active.length, queued.length, jobs.length)}</b>
        </div>
        {/* A shot is its words, and PolStudio never writes those for anyone —
            so this opens the composer rather than adding an empty job to the
            list. Same destination as "Describe another shot" below. */}
        <button className="queue-panel__new" onClick={focusComposer} aria-label="Describe a new shot" title="Describe a new shot"><Plus size={18} /></button>
      </div>
      <div className="queue-panel__scroll">
        <QueueGroup title="Rendering now" jobs={active} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Waiting to render" jobs={queued} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Drafts" jobs={drafts} selectedId={selectedId} onSelect={setSelectedId} />
        <QueueGroup title="Already run" jobs={completed} selectedId={selectedId} onSelect={setSelectedId} />
        {jobs.length === 0 && <p className="queue-empty">No shots yet. Describe one in the box on the right and it will appear here.</p>}
      </div>
      {/* One line: the headline already IS the status. The paragraph under it
          restated the same fact in a second sentence, and the "frames, not a
          video file" limit is still disclosed in the composer, at the point
          where someone actually commits to a render. */}
      <div className={`queue-runtime queue-runtime--${runtime?.state ?? "checking"}`}>
        <span className="queue-runtime__state"><i /> {runtimeHeadline(runtime)}</span>
      </div>
    </aside>

    <main className="generator-main">
      <header className="generator-heading">
        <div>
          <span className="eyebrow">Create shots</span>
          <h1>Generator</h1>
          <p>Describe a shot in your own words and PolStudio turns it into a scene you can keep editing. You always see what the video engine can actually do before anything starts.</p>
        </div>
        <button className="secondary-button" onClick={onOpenTimeline}><Film size={16} /> View timeline</button>
      </header>

      {/* The draft made from the user's own words leads the screen: they
          just described their video, so the next step is running that shot,
          not describing it again in a different unit. */}
      {selected && <section className="job-detail">
        <div className="job-detail__visual">
          {/* A labelled placeholder, never invented art — the same rule the scene
              thumb, media thumb and reference cards follow. PolStudio cannot
              display real frames yet, so it shows none. */}
          <div className={`generation-preview generation-preview--${selected.status}`}>
            {selected.status === "generating" && <span className="generation-scanner" aria-hidden="true" />}
            <span className="preview-status">{previewStatus(selected)}</span>
            <p className="generation-preview__caption">{previewCaption(selected)}</p>
          </div>
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
          {/* Every setting on this shot collapsed into the one string vidfab is
              given. Recompiled from what the shot holds right now, so it cannot
              disagree with what the next run sends. */}
          <CompiledPrompt
            creativeBrief={selected.creativeBrief}
            references={boundRefs}
            shotTags={selected.shotTags ?? null}
            caption={refsLocked
              ? "This is the prompt the engine was given for the run in progress."
              : "Rebuilt from this shot’s words, tags and references every time it is sent."}
          />
        </div>

        <aside className="job-detail__info">
          <div className="job-title">
            <span className={`status-icon status-icon--${selected.status}`}>{statusIcon(selected.status)}</span>
            <div>
              <span className="job-title__badge">{STATUS_BADGE[selected.status]}</span>
              {/* The title is the one part of a shot PolStudio writes for the
                  user — taken from their first words — so it has to be theirs
                  to change. Blanking it falls back rather than saving a
                  nameless shot the schema would reject. */}
              <h2><input
                className="job-title__name"
                value={selected.title}
                aria-label={`Rename ${selected.title}`}
                title="Rename this shot"
                onChange={(event) => updateJob(selected.id, { title: event.target.value || "Untitled shot", updatedAt: new Date().toISOString() })}
              /></h2>
            </div>
          </div>

          <div className="job-prompt">
            <span>What you asked for</span>
            <p>{selected.creativeBrief}</p>
          </div>

          {/* Tags are stored with the shot, so an existing one can be reopened
              and retagged rather than rewritten from scratch. */}
          <div className="job-tags">
            <span>{shotTagSummary(selected.shotTags ?? null)}</span>
            <ShotTagPicker
              idPrefix={selected.id}
              value={selected.shotTags ?? {}}
              disabled={refsLocked}
              onChange={(next) => updateJob(selected.id, { shotTags: normalizeShotTagSelection(next), updatedAt: new Date().toISOString() })}
            />
            {refsLocked && <p className="job-refs__empty">This shot is already with the engine. Its tags can be changed once it finishes, and the next run will use them.</p>}
          </div>

          {(planNotes[selected.id] || selected.error) && <div className="job-runtime-note">
            <span>What actually happened</span>
            <p>{planNotes[selected.id] ?? selected.error}</p>
            <small>Reported by the video engine (vidfab).</small>
          </div>}

          <dl className="job-meta">
            <div><dt>Video model</dt><dd>MiniMax H3</dd></div>
            <div><dt>Where it is</dt><dd>{STATUS_WORD[selected.status]}</dd></div>
            <div><dt>Saved to</dt><dd>{selected.outputRelativePath ?? "Nothing saved to disk"}</dd></div>
            <div><dt>Video file</dt><dd>{selected.outputRelativePath ? "Ready to use in your edit" : "Not created yet"}</dd></div>
          </dl>

          <div className="job-refs">
            <span>{promptRefs.length === 0 ? "No references used by this shot" : promptRefs.length === 1 ? "1 reference guides this shot" : `${promptRefs.length} references guide this shot`}</span>
            {/* Every reference in the project, each a checkbox: which ones steer
                a shot is the user's decision, and until now the two that were
                bound when the draft was written were the two it kept forever.
                A bound reference the prompt skips stays listed with its reason —
                hiding it would leave the user wondering where it went. */}
            {config.references.map((ref, index) => {
              const bound = selected.referenceIds.includes(ref.id);
              const skipped = skipReason(ref);
              return <label key={ref.id} className={`job-ref ${bound ? "job-ref--bound" : ""}`}>
                <input
                  type="checkbox"
                  checked={bound}
                  disabled={refsLocked}
                  onChange={() => toggleReference(selected, ref.id)}
                />
                <i className={`ref-mini ref-mini--${index}`} />
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
            {config.references.length === 0 && <p className="job-refs__empty">This project has no references yet. Add one under References and it can steer this shot.</p>}
            {/* The request was already handed to the engine, so a change here
                would say it steered a render it never touched. */}
            {refsLocked && <p className="job-refs__empty">This shot is already with the engine. Its references can be changed once it finishes, and the next run will use them.</p>}
            {promptRefs.length === 0
              ? <p className="job-refs__empty">The video engine only follows the words above.</p>
              : <p className="job-refs__empty">{referenceRouting(promptRefs)} The tags are your own notes and don’t change what is sent.</p>}
          </div>

          <div className="job-actions">
            {selected.status === "generating" && <button className="danger-button" onClick={() => cancelJob(selected)}><Square size={14} /> Stop this shot</button>}

            {selected.status === "queued" && <button className="danger-button" onClick={() => cancelJob(selected)}><X size={14} /> Take out of the queue</button>}

            {selected.status === "draft" && <>
              <button className="primary-button" disabled={!runtimeReady} onClick={() => void startDraft(selected)}>
                <WandSparkles size={15} /> {runtimeReady ? (jobs.length === 1 ? "Generate your first shot" : "Generate this shot") : "Can’t generate yet"}
              </button>
              {!runtimeReady && <p className="job-actions__note">This draft is saved with your project. PolStudio needs a working video engine before it can render it.</p>}
            </>}

            {(selected.status === "failed" || selected.status === "cancelled") && <>
              <button className="primary-button" disabled={!runtimeReady} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Try this shot again" : "Can’t try again yet"}
              </button>
              {!runtimeReady && <p className="job-actions__note">PolStudio needs a working video engine before it can run this shot again.</p>}
            </>}

            {selected.status === "ready" && <>
              <div className="job-actions__blocked">
                <b>There is nothing to open yet</b>
                <p>The frames and sound were rendered and are held in memory, but PolStudio can’t package them into a video file yet — that step isn’t built. Nothing was written to your project folder.</p>
              </div>
              <div className="job-actions__choices">
                <button className="primary-button" disabled={!runtimeReady} onClick={() => void prepareOrRetry(selected)}>
                  <RefreshCw size={15} /> {runtimeReady ? "Run this shot again" : "Can’t run it again yet"}
                </button>
                <button className="secondary-button" onClick={focusComposer}>
                  <Sparkles size={15} /> Describe another shot
                </button>
              </div>
            </>}

            {selected.status === "completed" && selected.outputRelativePath && !selected.clipId && <button className="primary-button" onClick={() => insertIntoStory(selected)}><Play size={15} /> Insert into Track 1, Video</button>}

            {selected.status === "completed" && selected.clipId && <button className="primary-button" onClick={onOpenTimeline}><Play size={15} /> Open in timeline</button>}

            {selected.status === "completed" && !selected.outputRelativePath && <>
              <button className="primary-button" disabled={!runtimeReady} onClick={() => void prepareOrRetry(selected)}>
                <RefreshCw size={15} /> {runtimeReady ? "Run this shot again" : "Can’t run it again yet"}
              </button>
              <p className="job-actions__note">This run finished without saving a video file, so there is nothing to add to your edit.</p>
            </>}
          </div>
        </aside>
      </section>}

      {/* Always here, and always called the same thing. It used to rename
          itself to "Write another shot" the moment a shot existed, which read
          as a footnote to the shot above rather than as the place shots are
          made. This is where a shot is authored; the dock along the bottom of
          the window changes one that already exists. */}
      <section className="generation-composer" aria-labelledby="describe-the-shot">
        <div className="generation-composer__head">
          <h2 className="generation-composer__label" id="describe-the-shot"><Sparkles size={17} /> Describe the shot</h2>
          <p className="generation-composer__lede">
            Write what happens in your own words, then pick the camera, light and mood from MiniMax H3’s own vocabulary.
            New shots are made here. The prompt bar along the bottom of the window is for changing a shot that already exists — it doesn’t start one.
          </p>
        </div>
        <label className="generation-composer__field">
          <span className="generation-composer__sublabel">In your own words</span>
          <textarea
            ref={composerRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Example: hands shaping wet clay on a spinning wheel, the wheel slowing as the rim thins."
          />
        </label>
        <ShotTagPicker idPrefix="new-shot" value={draftTags} onChange={setDraftTags} />
        {/* Visible before the button is ever pressed: the exact words that go
            to the engine, with the user's own prose marked apart from the terms
            their tags contributed. */}
        {prompt.trim().length > 0 && <CompiledPrompt
          creativeBrief={prompt}
          references={usableReferences.slice(0, 2)}
          shotTags={draftTags}
          caption={`Nothing is sent until you choose “${submitLabel}”.`}
        />}
        <div className="generation-composer__foot">
          <div className="generation-settings">
            <span className="generation-settings__lead">Every shot is made as</span>
            <span className="setting-chip"><em>Length</em><b>6 seconds</b></span>
            <span className="setting-chip"><em>Shape</em><b>{config.settings.aspectRatio}</b></span>
            <span className="setting-chip"><em>Size</em><b>{config.settings.resolution.toUpperCase()}</b></span>
            <span className="setting-chip"><em>Model</em><b>MiniMax H3</b></span>
          </div>
          {/* Primary whether or not a shot is already selected: this is the
              authoring surface, and demoting it the moment one shot existed
              made it look like an afterthought to the shot above. */}
          <button className="primary-button generation-composer__submit" onClick={() => void createJob()} disabled={!prompt.trim()}>
            <WandSparkles size={17} /> {submitLabel}
          </button>
        </div>
        {/* Disclosed at the point of commitment, not after an expensive run. */}
        {runtimeReady && <p className="generation-composer__limit">
          <Info size={16} />
          <span>A finished shot renders frames into memory. PolStudio can’t save them as a video file yet, so nothing lands in your project folder and there is nothing to add to the timeline.</span>
        </p>}
        <p className="generation-composer__hint">
          {runtimeReady
            ? "Shots render one at a time, so a new shot joins the queue behind anything already running."
            : "Nothing renders on this computer yet, so your shot is saved as a draft you can run later."}
          {/* Images are sent as real assets (referencePaths) AND cited as
              <Picture N>; text definitions reach the engine only as prose
              inside <Subject N>. Say exactly that — no more, and only about the
              references actually in hand: the same referenceRouting the shot
              panel uses, so the two places cannot drift apart. */}
          {usableReferences.length > 0
            ? ` It will use ${usableReferences.length === 1 ? "your reference" : `the first ${Math.min(2, usableReferences.length)} of your ${usableReferences.length} references`}. ${referenceRouting(usableReferences.slice(0, 2), "the prompt")}`
            : ""}
        </p>
      </section>

      {!selected && <div className="job-empty">
        <span className="job-empty__icon"><Sparkles size={26} /></span>
        <h2>Start with one shot</h2>
        <p>Write what should happen on screen in the box above — who or what is in frame, what they do, the sound. Then choose “{submitLabel}”.</p>
        <ul className="job-empty__tips">
          <li>One moment per shot works better than a whole scene.</li>
          <li>The camera, the light and the mood have tags above, in the video model’s own words.</li>
          <li>You can read the finished prompt before anything is sent.</li>
          <li>Every shot stays editable, so you can rewrite and run it again.</li>
        </ul>
      </div>}
    </main>
  </div>;
}

/* One accordion row per group in the taxonomy. All eleven groups open at once
   would be ninety-odd chips before the user has typed a word, so a row shows
   what it holds and opens on demand — and a row with choices in it says which,
   using the exact terms those choices put in the prompt.

   The vocabulary is never spelled here: every label and every term comes from
   src/lib/shot-tags.ts, so this component cannot invent a synonym. */
function ShotTagPicker({ idPrefix, value, onChange, disabled = false }: {
  idPrefix: string;
  value: ShotTagSelection;
  onChange: (next: ShotTagSelection) => void;
  disabled?: boolean;
}) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const movementChosen = hasCameraMovement(value);
  return <div className="shot-tags">
    <p className="shot-tags__lead">
      {countShotTags(value) === 0
        ? "Optional. Anything you tag is added to the prompt in MiniMax H3’s own words, next to yours."
        : `${countShotTags(value)} ${countShotTags(value) === 1 ? "tag" : "tags"} — each one adds its term to the prompt below.`}
    </p>
    {SHOT_TAG_GROUPS.map((group) => {
      const chosen = value[group.id] ?? [];
      // Speed and amplitude qualify a movement. With none chosen the compiler
      // leaves them out, so offering them would promise something the prompt
      // does not do.
      const blocked = Boolean(group.requiresMovement) && !movementChosen;
      const open = openGroup === group.id;
      const panelId = `${idPrefix}-${group.id}-panel`;
      const terms = group.options.filter((option) => chosen.includes(option.id)).map((option) => option.term);
      return <div key={group.id} className={`shot-tag-group ${open ? "shot-tag-group--open" : ""} ${blocked ? "shot-tag-group--blocked" : ""}`}>
        <button
          type="button"
          className="shot-tag-group__head"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={disabled || blocked}
          onClick={() => setOpenGroup(open ? null : group.id)}
        >
          <b>{group.label}</b>
          <span>{blocked ? "Needs a camera movement first" : terms.length > 0 ? terms.join(", ") : "None"}</span>
          <ChevronRight size={16} />
        </button>
        {open && <div className="shot-tag-group__body" id={panelId}>
          <p className="shot-tag-group__help">{group.help} {group.multiple ? "Choose as many as you like." : "One at a time."}</p>
          <div className="shot-tag-group__options">
            {group.options.map((option) => {
              const on = chosen.includes(option.id);
              return <button
                key={option.id}
                type="button"
                className={`shot-tag ${on ? "shot-tag--on" : ""}`}
                aria-pressed={on}
                disabled={disabled}
                title={`Puts “${option.term}” in the prompt`}
                onClick={() => onChange(toggleShotTag(value, group.id, option.id))}
              >{option.label}</button>;
            })}
          </div>
        </div>}
      </div>;
    })}
  </div>;
}

/* The compiled prompt, shown before anything is sent and coloured by who wrote
   which part. The segments come from the compiler itself, so this panel is the
   string vidfab receives — not a re-rendering of it that could drift. */
function CompiledPrompt({ creativeBrief, references, shotTags, caption }: {
  creativeBrief: string;
  references: ProjectReference[];
  shotTags: ShotTagSelection | null;
  caption: string;
}) {
  const segments = useMemo(
    () => compileMiniMaxH3PromptSegments(creativeBrief, references, shotTags),
    [creativeBrief, references, shotTags],
  );
  return <section className="compiled-prompt" aria-label="The compiled MiniMax H3 prompt">
    <span className="compiled-prompt__title">The prompt this shot becomes</span>
    <p className="compiled-prompt__key">
      <em className="compiled-prompt__swatch compiled-prompt__swatch--brief">your words</em>
      <em className="compiled-prompt__swatch compiled-prompt__swatch--tag">your tags</em>
      <em className="compiled-prompt__swatch compiled-prompt__swatch--frame">the H3 format, added by PolStudio</em>
    </p>
    <pre className="compiled-prompt__text">{segments.map((segment, index) =>
      <span key={index} className={`prompt-part prompt-part--${segment.kind}`}>{segment.value}</span>)}</pre>
    <small>{caption}</small>
  </section>;
}

/* Counts only what this build can turn into a term — a tag id saved by a newer
   build is kept in the file but has no words here, so claiming it is in the
   prompt would be a claim about something that isn't. */
const shotTagSummary = (tags: ShotTagSelection | null): string => {
  const chosen = selectedShotTagOptions(tags);
  if (chosen.length === 0) return "No tags on this shot";
  return chosen.length === 1 ? "1 tag shapes this shot" : `${chosen.length} tags shape this shot`;
};

/* The half-written shot's tags, parked per project. Anything unreadable is
   treated as no tags rather than thrown at the user: this is a convenience
   store, and nothing in it is the only copy of anything. */
const readDraftTags = (key: string): ShotTagSelection => {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return {};
    const parsed = shotTagSelectionSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
};

const writeDraftTags = (key: string, tags: ShotTagSelection) => {
  try {
    if (Object.keys(tags).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(tags));
  } catch {
    /* A full or blocked store costs the parked copy, nothing on screen. */
  }
};

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
   sent … text definitions are written into the prompt" for a shot that has only
   one of the two describes something that isn't happening. */
const referenceRouting = (references: ProjectReference[], prompt = "this shot’s prompt"): string => {
  const hasImage = references.some((reference) => reference.kind === "image");
  const hasText = references.some((reference) => reference.kind !== "image");
  if (hasImage && hasText) return `Images are sent to the video engine as reference assets; text definitions are written into ${prompt}.`;
  if (hasImage) return references.length === 1
    ? "The image is sent to the video engine as a reference asset."
    : "The images are sent to the video engine as reference assets.";
  return references.length === 1
    ? `The text definition is written into ${prompt}.`
    : `The text definitions are written into ${prompt}.`;
};

/* Why a reference that is bound to this shot never reaches its prompt, or null
   when it does. The wording mirrors the References card so the two screens
   describe the same state in the same words. */
const skipReason = (reference: ProjectReference): string | null => {
  if (!isReferenceUsable(reference)) return "Not described yet — not used by this shot";
  if (!isVisualReference(reference)) return "Tagged as a sound note, so it isn’t sent to the video engine.";
  return null;
};

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
  return total === 1 ? "1 shot" : `${total} shots`;
};

const queueLine = (job: GenerationJob) => {
  switch (job.status) {
    case "generating": return `Rendering · ${Math.round(job.progress * 100)}%`;
    case "queued": return "Waiting its turn";
    case "draft": return "Draft — not started";
    case "ready": return "Frames rendered · no video file";
    case "completed": return job.outputRelativePath ? "Ready to use · 6 seconds" : "Finished with no file";
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
    case "queued": return "Waiting for the shot ahead of it to finish.";
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
    case "queued": return "This shot hasn’t started, so there is no picture to show.";
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

