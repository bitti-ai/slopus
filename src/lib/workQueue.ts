import { imageSettings } from "./imageSettings";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { createImageEditScene, createImageScene, imageScenePrompt } from "./imageScene";
import { compileImageEdits, imageEditDebugPrompt } from "./imageEditing";
import { compileImagePrompt } from "./imagePrompt";
import { compileExtendImage, type ExtendOptions } from "./extendImage";
import { CHARACTER_SHEET_ORDER, CHARACTER_SHEET_VIEWS, characterSheetDimensions, characterSheetViewIndices, characterSheetViews, compileCharacterSheet, type CharacterSheetOptions } from "./characterSheet";
import { completeImageDraft, createTemplateImageDraft, imageFamilyRoot, imageGenerationSnapshot, saveImageDraft } from "./imageHistory";
import type { ImageGenerationSnapshot, ProjectAsset } from "./project";
import { outputDimensions } from "./export";
import { projectItemPath, referenceDefinition, referenceImages, referenceRefmodInputs } from "./project";
import { engineProviderSetting, type GeneratorTemplate } from "./settings";
import { describeDiagnosticError, writeDiagnostic } from "./diagnostics";
import { GenerationTimingEstimator, type CompletedGenerationTiming, type GenerationTimingProgress } from "./generationTiming";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { isTauri, saveProject } from "./persistence";
import { generationAssetId, generationLatentPath, GENERATION_FRAME_RATE, sceneOutputFrames, sceneGenerationSnapshot, type GenerationJob, type ProjectRecord, type ProjectConfig } from "./project";
import { ProjectSession, type ProjectWriter } from "./projectSession";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan, type SlopfabGenerationRequest } from "./runtime";
import { generationStepsWithLoras, withEngineSettings } from "./settings";
import { remoteWorkerSelected } from "./workers";
import { purgeTimelineThumbnails } from "./timelineThumbnails";
import { ReferenceIconWork } from "./referenceIconWork";
import { prepareReferenceVideos, releaseReferenceVideos } from "./referenceVideo";
import { prepareReferenceAudios, releaseReferenceAudios } from "./referenceAudio";
import { joinedSceneSegments, sceneArchiveSegments } from "./continuationMedia";
import { bridgedSceneSegments, longShotBlocker, longShotInputs } from "./longShot";
import type { SceneMediaSegment } from "./project";
import { exportReferenceRefmod, refmodExportBlocker, refmodExportRequest, type RefmodExportTarget } from "./refmodExport";

export type WorkStatus = "queued" | "preparing" | "generating" | "encoding" | "completed" | "failed" | "cancelled";
export interface GenerationSubmission { job: GenerationJob; request: SlopfabGenerationRequest; snapshot: string }

function imageGenerationSeed(seed: number): number {
  if (seed !== -1) return seed;
  // Resolve before submission so history stores exactly what the engine uses.
  // Keep all 53 bits exactly representable in JSON and the editable seed field.
  const [high, low] = crypto.getRandomValues(new Uint32Array(2));
  return (high & 0x1fffff) * 0x100000000 + low;
}
export interface WorkItem {
  imageAssetId?: string | null;
  imageDraftId?: string;
  kind?: "reference-icons" | "image" | "refmod";
  id: string;
  projectKey: string;
  folderPath: string;
  projectName: string;
  sceneId: string;
  title: string;
  submittedAt: string;
  status: WorkStatus;
  progress: number;
  detail: string;
  error: string | null;
  completionAt: number | null;
  cancelling: boolean;
  needsSave: boolean;
  settings: { frames: number; steps: number; audioSteps?: number; latentUpscale?: boolean; seed: number; canvasWidth: number; canvasHeight: number };
}
interface PendingWork {
  extend?: { sourceId: string; name: string; options: ExtendOptions };
  characterSheet?: {
    views: ReturnType<typeof compileCharacterSheet>; sourceId: string; name: string; index: number;
    dimensions: ReturnType<typeof characterSheetDimensions>;
    order: number[];
    ready?: { resolve: () => void; reject: (reason: Error) => void };
  };
  outputFrames?: number;
  continuationSegments?: SceneMediaSegment[];
  bridgeSegments?: SceneMediaSegment[];
  imageDraftId?: string;
  /** The family a regenerated image joins. */
  imageParentId?: string;
  image?: boolean;
  imageGeneration?: ImageGenerationSnapshot;
  refmod?: RefmodExportTarget;
  id: string;
  session: ProjectSession;
  sceneId: string;
  request: SlopfabGenerationRequest;
  config: ProjectConfig;
  snapshot: string;
  cancelled: boolean;
  submitted: boolean;
  done: Promise<void>;
  finish: () => void;
}
interface JobEvent { jobId: string; state: string; detail: string; output?: CompletedGenerationTiming | null }

export const isWorkActive = (work: WorkItem) => !["completed", "failed", "cancelled"].includes(work.status);
export const projectQueueKey = (record: ProjectRecord) => {
  const path = record.folderPath.replaceAll("\\", "/").replace(/\/$/, "");
  const normalized = /^[a-z]:\//i.test(path) || path.startsWith("//") ? path.toLowerCase() : path;
  return `${normalized}::${record.config.id}`;
};

/** App-owned FIFO. A render includes encoding and saving before the next one
 * starts, so native frame buffers cannot evict work still being encoded. */
export class WorkQueue {
  private projects = new Map<string, ProjectSession>();
  private work = new Map<string, PendingWork>();
  private items: readonly WorkItem[] = [];
  private listeners = new Set<() => void>();
  private pumping = false;
  private timing = new GenerationTimingEstimator();
  private connections = 0;
  private disconnect: (() => void) | null = null;
  private icons = new ReferenceIconWork((item) => {
    this.items = this.items.some((current) => current.id === item.id)
      ? this.items.map((current) => current.id === item.id ? item : current)
      : [...this.items, item];
    this.publish();
  }, () => { void this.pump(); });
  ready: Promise<void> = Promise.resolve();

  constructor(private writer: ProjectWriter = saveProject) {}
  getSnapshot = () => this.items;
  projectRecord(key: string): ProjectRecord | undefined {
    const session = this.projects.get(key);
    return session ? { ...session.record, config: session.getSnapshot().config } : undefined;
  }
  updateBlockReason = (): string | null => {
    if (this.items.some(isWorkActive) || this.icons.confirmationCount() > 0) {
      return "Finish or cancel queued work before installing an update.";
    }
    if (this.items.some((item) => item.needsSave) || [...this.projects.values()].some((session) => {
      const state = session.getSnapshot();
      return state.dirty || state.saving || state.saveError;
    })) return "Save your project changes and generated videos before installing an update.";
    return null;
  };
  getIconConfirmationCount = () => this.icons.confirmationCount();
  answerIconConfirmation = (confirmed: boolean, remember: boolean) => this.icons.answerConfirmation(confirmed, remember);
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { this.listeners.forEach((listener) => listener()); }
  private patch(id: string, patch: Partial<WorkItem>) {
    this.items = this.items.map((item) => item.id === id ? { ...item, ...patch } : item);
    this.publish();
  }
  project(record: ProjectRecord): ProjectSession {
    const key = projectQueueKey(record);
    let session = this.projects.get(key);
    if (!session) {
      // The queue belongs to this app run. A persisted in-flight status from a
      // previous run has no worker behind it and must be restartable.
      const config = isTauri() ? { ...record.config, generationJobs: record.config.generationJobs.map((job) =>
        ["queued", "generating", "ready"].includes(job.status) ? { ...job, status: "failed" as const, stage: "failed" as const, error: "Generation was interrupted when Slopus closed. Generate again to restart." } : job) } : record.config;
      session = new ProjectSession({ ...record, config }, this.writer);
      this.projects.set(key, session);
    }
    this.icons.watch(session);
    return session;
  }
  hasActiveProject(record: ProjectRecord) {
    const session = this.projects.get(projectQueueKey(record));
    return Boolean(session && this.icons.hasActiveProject(session)) || this.items.some((item) => item.projectKey === projectQueueKey(record) && isWorkActive(item));
  }
  isReferenceIconPending(session: ProjectSession, referenceId: string) {
    return this.icons.isPending(session, referenceId);
  }
  regenerateReferenceIcon(session: ProjectSession, referenceId: string) {
    if (!isTauri()) throw new Error("Icon generation is available in the desktop app.");
    this.icons.regenerate(session, referenceId);
  }
  generateBuiltinReferenceIcons(session: ProjectSession) {
    if (!isTauri()) throw new Error("Icon generation is available in the desktop app.");
    this.icons.enqueueBuiltins(session);
  }
  regenerateBuiltinReferenceIcon(session: ProjectSession, presetId: string) {
    if (!isTauri()) throw new Error("Icon generation is available in the desktop app.");
    this.icons.regenerateBuiltin(session, presetId);
  }
  pendingBuiltinIconIds() { return this.icons.pendingBuiltinIds(); }
  forgetProject(record: ProjectRecord) {
    if (this.hasActiveProject(record)) throw new Error("Cancel or finish this project's work before deleting it.");
    const session = this.projects.get(projectQueueKey(record));
    if (session) this.icons.forget(session);
    this.projects.delete(projectQueueKey(record));
  }
  clearFinished() {
    const cleared = this.items.filter((item) => !isWorkActive(item) && !item.needsSave);
    cleared.forEach((item) => this.work.delete(item.id));
    cleared.forEach((item) => this.icons.clearFinished(item.id));
    this.items = this.items.filter((item) => isWorkActive(item) || item.needsSave);
    this.publish();
  }
  start = () => {
    this.connections += 1;
    this.projects.forEach((session) => this.icons.watch(session));
    if (this.connections === 1 && isTauri()) {
      let disposed = false;
      const stops: (() => void)[] = [];
      const subscribe = async <T,>(name: string, handler: (payload: T) => void) => {
        const stop = await listen<T>(name, ({ payload }) => { if (!disposed) handler(payload); });
        if (disposed) stop(); else stops.push(stop);
      };
      this.ready = Promise.all([
        subscribe<GenerationTimingProgress>("slopfab-progress", (event) => this.progress(event)),
        subscribe<JobEvent>("slopfab-job", (event) => this.event(event)),
      ]).then(() => undefined);
      void this.ready.catch((reason) => writeDiagnostic("error", "work-queue", "subscription.failed", describeDiagnosticError(reason), {}));
      this.disconnect = () => { disposed = true; stops.forEach((stop) => stop()); };
    }
    return () => {
      this.connections -= 1;
      if (this.connections === 0) { this.disconnect?.(); this.disconnect = null; this.icons.stop(); }
    };
  };

  enqueue(session: ProjectSession, submissions: GenerationSubmission[], template?: GeneratorTemplate): string[] {
    const projectKey = projectQueueKey(session.record);
    // Take every setting before the first await, including the selected engine
    // template. Planning and native submission consume this same private copy.
    const current = session.getSnapshot().config;
    const config = structuredClone(template ? { ...current, providerSettings: { ...current.providerSettings,
      slopfab: engineProviderSetting(template.paths, current.providerSettings.slopfab, template.attention, template.loras ?? [], template.mode ?? "prompt", template.additionalSafetensors ?? [], template.motionCache ?? false, template.sources ?? {}),
    } } : withEngineSettings(current));
    const ids: string[] = [];
    for (const submission of submissions) {
      if (this.items.some((item) => item.projectKey === projectKey && item.sceneId === submission.job.id && isWorkActive(item))) continue;
      const id = `work-${crypto.randomUUID()}`;
      ids.push(id);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const request = structuredClone({ ...submission.request, jobId: id, steps: generationStepsWithLoras(submission.request.steps, config) });
      this.work.set(id, { id, session, sceneId: submission.job.id, request, config, snapshot: submission.snapshot, cancelled: false, submitted: false, done, finish });
      this.items = [...this.items, {
        id, projectKey, folderPath: session.record.folderPath, projectName: config.name,
        sceneId: submission.job.id, title: submission.job.title, submittedAt: new Date().toISOString(),
        status: "queued", progress: 0, detail: "Waiting to generate", error: null, completionAt: null,
        cancelling: false, needsSave: false,
        settings: { frames: request.frames, steps: request.steps, audioSteps: request.audioSteps, latentUpscale: request.latentUpscale, seed: request.seed, canvasWidth: request.canvasWidth, canvasHeight: request.canvasHeight },
      }];
      this.updateScene(this.work.get(id)!, { status: "queued", stage: "queued", progress: 0, error: null, generationSnapshot: submission.snapshot });
    }
    this.publish();
    if (this.items.some((item) => item.status === "queued" && item.kind !== "reference-icons")) this.icons.yieldToVideo();
    void this.pump();
    return ids;
  }

  /** Wait for this exact run, including encoding and the project save. A saved
   * scene status alone could belong to an older render of the same scene. */
  waitFor(id: string, signal: AbortSignal, onProgress: (item: WorkItem) => void = () => {}): Promise<WorkItem> {
    const work = this.work.get(id);
    let latest = this.items.find((item) => item.id === id);
    if (!latest) return Promise.reject(new Error("Generation is no longer in the work queue."));
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Agent request cancelled."));
    if (!work && !isWorkActive(latest)) { onProgress(latest); return Promise.resolve(latest); }
    if (!work) return Promise.reject(new Error("Generation is no longer in the work queue."));
    return new Promise((resolve, reject) => {
      const stop = this.subscribe(() => {
        const item = this.items.find((candidate) => candidate.id === id);
        if (item && item !== latest) { latest = item; onProgress(item); }
      });
      const cleanup = () => { stop(); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(signal.reason ?? new Error("Agent request cancelled.")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      onProgress(latest!);
      void work.done.then(() => { cleanup(); resolve(latest!); });
    });
  }

  enqueueImage(session: ProjectSession, template: GeneratorTemplate) {
    if (!isTauri()) throw new Error("Image generation requires the desktop app and MiniMax H3 weights.");
    if (template.mode === "animate") throw new Error("Choose a MiniMax H3 prompt template for images.");
    session.update((config) => saveImageDraft(config, template.id));
    const current = session.getSnapshot().config;
    const scene = current.imageScene ?? createImageScene(current.brief.prompt);
    const edit = scene.rootType === "image" ? compileImageEdits(current) : null;
    if (!imageScenePrompt(scene)) throw new Error("Describe the image or add an object before generating.");
    const projectKey = projectQueueKey(session.record);
    if (this.items.some((item) => item.projectKey === projectKey && item.kind === "image" && item.imageAssetId === scene.outputAssetId && isWorkActive(item))) return;
    const config = structuredClone({ ...current, providerSettings: { ...current.providerSettings,
      slopfab: engineProviderSetting(template.paths, current.providerSettings.slopfab, template.attention, template.loras, "prompt", template.additionalSafetensors, false, template.sources) } });
    const { prompt, references } = edit ? edit.edits[0] : compileImagePrompt(current);
    const referencePaths = (selected: typeof references) => [
      ...(edit ? [projectItemPath(session.record.folderPath, edit.source)!] : []),
      ...selected.flatMap((reference) => referenceImages(reference).map((image) => projectItemPath(session.record.folderPath, image)!)),
    ];
    const { width, height } = edit?.source ?? outputDimensions(imageSettings(current).resolution, imageSettings(current).aspectRatio);
    const id = `image-${crypto.randomUUID()}`;
    const imageDraftId = current.assets.find((asset) => asset.id === scene.outputAssetId && asset.imageDraft)?.id;
    // Generating again from a finished image makes a new image in its family.
    const imageParentId = imageDraftId ? undefined : imageFamilyRoot(current.assets, scene.outputAssetId);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const request: SlopfabGenerationRequest = { jobId: id, stillImage: true, frames: 1, prompt: edit ? edit.edits[0].prompt : prompt,
      ...(edit ? { imageEdit: { sourceRelativePath: edit.source.relativePath, edits: edit.edits.map(({ references, ...step }) => ({
        ...step, referencePaths: referencePaths(references), refmods: referenceRefmodInputs(session.record.folderPath, references),
      })) } } : {}),
      canvasWidth: width, canvasHeight: height, steps: generationStepsWithLoras(scene.steps, config), seed: imageGenerationSeed(scene.seed),
      referencePaths: referencePaths(references),
      refmods: referenceRefmodInputs(session.record.folderPath, references),
    };
    this.work.set(id, { id, image: true, imageDraftId, imageParentId, imageGeneration: { ...imageGenerationSnapshot(config, edit ? imageEditDebugPrompt(edit.edits) : prompt, template.id), usedSeed: request.seed }, session, sceneId: scene.nodes.find((node) => node.kind === "root")!.id, config, snapshot: JSON.stringify(scene), request, submitted: false, cancelled: false, done, finish });
    this.items = [...this.items, { id, kind: "image", imageAssetId: scene.outputAssetId, imageDraftId, projectKey, folderPath: session.record.folderPath, projectName: config.name, sceneId: scene.nodes.find((node) => node.kind === "root")!.id,
      title: "Image · " + config.name, submittedAt: new Date().toISOString(), status: "queued", progress: 0, detail: "Waiting to generate image", error: null, completionAt: null, cancelling: false, needsSave: false,
      settings: { frames: 1, steps: request.steps, seed: request.seed, canvasWidth: width, canvasHeight: height } }];
    this.publish(); this.icons.yieldToVideo(); void this.pump();
  }
  enqueueExtendImage(session: ProjectSession, template: GeneratorTemplate, sourceId: string, options: ExtendOptions) {
    if (!isTauri()) throw new Error("Extend requires the desktop app.");
    if (template.mode === "animate") throw new Error("Choose a prompt generator for Extend.");
    const current = session.getSnapshot().config;
    const source = current.assets.find((asset) => asset.id === sourceId && asset.kind === "image" && !asset.imageDraft);
    if (!source || (!source.relativePath && !source.sourcePath)) throw new Error("Select a saved image to extend.");
    const projectKey = projectQueueKey(session.record);
    if (this.items.some((item) => item.projectKey === projectKey && item.kind === "image" && item.imageAssetId === sourceId && isWorkActive(item))) return;
    const config = structuredClone({ ...current, providerSettings: { ...current.providerSettings,
      slopfab: engineProviderSetting(template.paths, current.providerSettings.slopfab, template.attention, template.loras, "prompt", template.additionalSafetensors, false, template.sources) } });
    const id = `extend-${crypto.randomUUID()}`;
    const sourceRelativePath = `cache/extend-images/${id}/canvas.png`;
    const compiled = compileExtendImage(config, source, sourceRelativePath, options);
    // The inpainting canvas already supplies the original at its selected size
    // and position. A separate reference is resized independently by the model
    // and can reproduce the whole original scene inside the extension.
    const referencePaths = compiled.references.flatMap((reference) => referenceImages(reference).map((image) => projectItemPath(session.record.folderPath, image)!));
    const request: SlopfabGenerationRequest = { jobId: id, stillImage: true, frames: 1, prompt: compiled.prompt,
      canvasWidth: compiled.layout.output.width, canvasHeight: compiled.layout.output.height, steps: generationStepsWithLoras(options.steps, config), seed: imageGenerationSeed(options.seed),
      referencePaths, refmods: referenceRefmodInputs(session.record.folderPath, compiled.references),
      imageEdit: { sourceRelativePath, edits: compiled.edits } };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const imageGeneration: ImageGenerationSnapshot = {
      ...imageGenerationSnapshot({ ...config, imageScene: { ...createImageScene(options.prompt), steps: request.steps, seed: options.seed } }, compiled.prompt, template.id),
      usedSeed: request.seed,
      template: { kind: "extend", sourceId, sourceName: source.name, generatorName: template.name, ...structuredClone(options), steps: request.steps },
    };
    this.work.set(id, { id, image: true, imageDraftId: id, extend: { sourceId, name: `Extended - ${source.name}`, options: structuredClone(options) }, imageParentId: sourceId,
      imageGeneration,
      session, sceneId: current.imageScene?.nodes[0].id ?? "image-root", config, snapshot: JSON.stringify(current.imageScene), request, submitted: false, cancelled: false, done, finish });
    this.items = [...this.items, { id, kind: "image", imageAssetId: sourceId, imageDraftId: id, projectKey, folderPath: session.record.folderPath, projectName: config.name,
      sceneId: this.work.get(id)!.sceneId, title: `Extend · ${source.name}`, submittedAt: new Date().toISOString(), status: "queued", progress: 0,
      detail: "Waiting to extend image", error: null, completionAt: null, cancelling: false, needsSave: false,
      settings: { frames: 1, steps: request.steps, seed: request.seed, canvasWidth: request.canvasWidth, canvasHeight: request.canvasHeight } }];
    session.update((current) => createTemplateImageDraft(current, id, `Extended - ${source.name}`, imageGeneration, compiled.layout.output));
    this.publish(); this.icons.yieldToVideo(); void this.pump();
  }
  enqueueCharacterSheet(session: ProjectSession, template: GeneratorTemplate, sourceId: string, options?: CharacterSheetOptions) {
    if (!isTauri()) throw new Error("Character sheet generation requires the desktop app.");
    if (template.mode === "animate") throw new Error("Choose a prompt generator for the character sheet.");
    const current = session.getSnapshot().config;
    const source = current.assets.find((asset) => asset.id === sourceId && asset.kind === "image");
    if (!source || (!source.relativePath && !source.sourcePath)) throw new Error("Select an image with a saved file first.");
    const projectKey = projectQueueKey(session.record);
    if (this.items.some((item) => item.projectKey === projectKey && item.kind === "image" && item.imageAssetId === sourceId && isWorkActive(item))) return;
    const config = structuredClone({ ...current, providerSettings: { ...current.providerSettings,
      slopfab: engineProviderSetting(template.paths, current.providerSettings.slopfab, template.attention, template.loras, "prompt", template.additionalSafetensors, false, template.sources) } });
    const id = `character-sheet-${crypto.randomUUID()}`;
    const frontRelativePath = `cache/character-sheets/${id}/1.png`;
    const views = compileCharacterSheet(config, source, frontRelativePath, options);
    config.imageScene = { ...(config.imageScene ?? createImageScene()),
      steps: generationStepsWithLoras(options?.steps ?? current.imageScene?.steps ?? template.defaultSteps, config),
      seed: options?.seed ?? current.imageScene?.seed ?? -1 };
    const dimensions = characterSheetDimensions(imageSettings(config).resolution, options?.height);
    const indices = characterSheetViewIndices(options);
    const order = CHARACTER_SHEET_ORDER.filter((index) => indices.includes(index));
    const firstView = order[0];
    const { width, height } = dimensions[firstView];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const request: SlopfabGenerationRequest = { jobId: `${id}-view-${firstView + 1}`, stillImage: true, frames: 1, prompt: views[firstView].prompt,
      canvasWidth: width, canvasHeight: height, steps: config.imageScene.steps,
      seed: imageGenerationSeed(config.imageScene.seed),
      referencePaths: views[firstView].references.flatMap((reference) => referenceImages(reference).map((image) => projectItemPath(session.record.folderPath, image)!)),
      refmods: referenceRefmodInputs(session.record.folderPath, views[firstView].references) };
    const imageGeneration: ImageGenerationSnapshot = {
      ...imageGenerationSnapshot({ ...config, imageScene: { ...createImageScene(options?.prompt ?? ""), steps: request.steps, seed: config.imageScene.seed } }, indices.map((index) => views[index].prompt).join("\n\n"), template.id),
      usedSeed: request.seed,
      references: [...new Map(indices.flatMap((index) => views[index].references.slice(1)).map((reference) => [reference.id, reference])).values()],
      template: { kind: "character-sheet", sourceId, sourceName: source.name, generatorName: template.name, prompt: options?.prompt ?? "",
        height, steps: request.steps, seed: config.imageScene.seed, views: characterSheetViews(options) },
    };
    this.work.set(id, { id, image: true, imageDraftId: id, characterSheet: { views, dimensions, order, sourceId, name: `Character sheet - ${source.name}`, index: 0 },
      imageGeneration,
      session, sceneId: current.imageScene?.nodes[0].id ?? "image-root", config, snapshot: JSON.stringify(current.imageScene),
      request, submitted: false, cancelled: false, done, finish });
    this.items = [...this.items, { id, kind: "image", imageAssetId: sourceId, imageDraftId: id, projectKey, folderPath: session.record.folderPath, projectName: config.name,
      sceneId: this.work.get(id)!.sceneId, title: `Character sheet · ${source.name}`, submittedAt: new Date().toISOString(),
      status: "queued", progress: 0, detail: "Waiting to generate character sheet", error: null, completionAt: null, cancelling: false, needsSave: false,
      settings: { frames: order.length, steps: request.steps, seed: request.seed, canvasWidth: width, canvasHeight: height } }];
    session.update((current) => createTemplateImageDraft(current, id, `Character sheet - ${source.name}`, imageGeneration,
      { width: indices.reduce((total, index) => total + dimensions[index].width, 0), height }));
    this.publish(); this.icons.yieldToVideo(); void this.pump();
  }
  /** Queues encoding one reference's images, video or sound into a refmod file. */
  exportReferenceRefmod(session: ProjectSession, referenceId: string, outputPath: string) {
    if (!isTauri()) throw new Error("Refmod export is available in the desktop app.");
    const config = structuredClone(withEngineSettings(session.getSnapshot().config));
    const reference = config.references.find((candidate) => candidate.id === referenceId);
    if (!reference) throw new Error("The reference no longer exists.");
    const blocker = refmodExportBlocker(reference);
    if (blocker) throw new Error(blocker);
    const projectKey = projectQueueKey(session.record);
    if (this.items.some((item) => item.projectKey === projectKey && item.kind === "refmod" && item.sceneId === referenceId && isWorkActive(item))) {
      throw new Error("This reference is already being exported.");
    }
    const id = `refmod-${crypto.randomUUID()}`;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const request = refmodExportRequest(session.record.folderPath, reference, id);
    this.work.set(id, { id, session, sceneId: referenceId, request, config, snapshot: "", cancelled: false, submitted: false, done, finish,
      refmod: { outputPath, name: reference.name, description: referenceDefinition(reference) } });
    this.items = [...this.items, { id, kind: "refmod", projectKey, folderPath: session.record.folderPath, projectName: config.name, sceneId: referenceId,
      title: "Refmod · " + reference.name, submittedAt: new Date().toISOString(), status: "queued", progress: 0, detail: "Waiting to export refmod", error: null, completionAt: null, cancelling: false, needsSave: false,
      settings: { frames: 0, steps: 0, seed: 0, canvasWidth: 0, canvasHeight: 0 } }];
    this.publish(); this.icons.yieldToVideo(); void this.pump();
  }
  private updateScene(work: PendingWork, patch: Partial<GenerationJob>, dirty = true) {
    if (work.image || work.refmod) return;
    // The undo replay log retains this callback. Do not retain the submitted
    // project snapshot with every progress update.
    work.session.update(sceneUpdate(work.sceneId, patch), dirty);
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const next = this.items.find((item) => item.status === "queued" && item.kind !== "reference-icons");
        if (!next) {
          if (!this.icons.hasRunnable()) break;
          await this.icons.runNext(this.ready, () => this.items.some((item) => item.status === "queued" && item.kind !== "reference-icons"));
          continue;
        }
        const work = this.work.get(next.id)!;
        this.patch(work.id, { status: "preparing", detail: work.refmod ? "Preparing refmod" : "Preparing generation" });
        try {
          await this.ready;
          if (work.cancelled) continue;
          if (work.refmod) { await this.exportRefmod(work, next.folderPath); continue; }
          // Newly created scenes/references must exist on disk before any
          // background result can be attached to this project.
          await work.session.save();
          if (work.cancelled) continue;
          if (work.characterSheet) { await this.generateCharacterSheet(work); continue; }
          if (work.extend) {
            await invoke("prepare_extend_image", { folderPath: next.folderPath, jobId: work.id, sourceId: work.extend.sourceId, bounds: work.extend.options.bounds,
              output: { width: work.request.canvasWidth, height: work.request.canvasHeight } });
            if (work.cancelled) continue;
          }
          if (work.request.latentBridge) {
            const live = work.session.getSnapshot().config;
            const captured = work.config.generationJobs.find((job) => job.id === work.sceneId)!;
            const current = live.generationJobs.find((job) => job.id === work.sceneId);
            const inputs = current && longShotInputs({ ...current, bridgeLeftMargin: captured.bridgeLeftMargin, bridgeRightMargin: captured.bridgeRightMargin }, live);
            if (!inputs || inputs.bridge.leftSceneId !== work.request.latentBridge.leftSceneId || inputs.bridge.rightSceneId !== work.request.latentBridge.rightSceneId)
              throw new Error("The Long Shot neighbors changed while queued. Queue this scene again.");
            const blocker = longShotBlocker({ ...captured, latentUpscale: work.request.latentUpscale }, live);
            if (blocker) throw new Error(blocker);
            work.request.latentBridge = inputs.bridge;
            work.bridgeSegments = inputs.leftSegments;
            work.snapshot = sceneGenerationSnapshot(captured, work.request);
            this.updateScene(work, { generationSnapshot: work.snapshot });
          }
          if (work.request.previousSceneId) {
            const previous = work.session.getSnapshot().config.generationJobs.find((job) => job.id === work.request.previousSceneId);
            if (!previous?.latentRelativePath || previous.status !== "completed") {
              throw new Error("Generate the selected source scene successfully to save its latents before continuing it. You can also use Generate All.");
            }
            work.request.continuationRelativePath = previous.latentRelativePath;
            work.request.continuationSourceFrames = sceneOutputFrames(previous, work.session.getSnapshot().config);
            work.continuationSegments = sceneArchiveSegments(work.session.getSnapshot().config, previous);
            const captured = work.config.generationJobs.find((job) => job.id === work.sceneId)!;
            work.snapshot = sceneGenerationSnapshot(captured, work.request);
            this.updateScene(work, { generationSnapshot: work.snapshot });
          }
          if (!work.image) await purgeTimelineThumbnails(next.folderPath, work.sceneId).catch(() => undefined);
          if (work.cancelled) continue;
          await this.prepareReferences(work, next.folderPath);
          if (work.cancelled) continue;
          const plan = await resolveSlopfabPlan(work.request, work.config, next.folderPath);
          if (work.cancelled) continue;
          work.outputFrames = plan.alignedFrames;
          this.patch(work.id, { status: "generating", detail: `Generating ${work.image ? "image" : `${plan.alignedFrames} frames`} at ${plan.canvasWidth} × ${plan.canvasHeight}` });
          this.updateScene(work, { status: "generating", stage: "preparing" }, false);
          await enqueueSlopfabGeneration(work.request, work.config, next.folderPath);
          work.submitted = true;
          if (work.cancelled) await this.requestNativeCancellation(work);
          await work.done;
        } catch (reason) { this.fail(work, reason); }
        finally {
          if (work.extend) await invoke("discard_extend_image", { folderPath: next.folderPath, jobId: work.id }).catch((reason) =>
            writeDiagnostic("error", "work-queue", "extend.cleanup_failed", describeDiagnosticError(reason), { workId: work.id }));
          await releaseReferenceVideos(work.request.referenceVideoIds ?? []).catch((reason) =>
            writeDiagnostic("error", "work-queue", "references.release_failed", describeDiagnosticError(reason), { workId: work.id }));
          delete work.request.referenceVideoIds;
          await releaseReferenceAudios(work.request.referenceAudioIds ?? []).catch((reason) =>
            writeDiagnostic("error", "work-queue", "references.release_failed", describeDiagnosticError(reason), { workId: work.id }));
          delete work.request.referenceAudioIds;
          // Queue history only needs WorkItem; finished runs must not keep a
          // deep copy of the entire project and its image history alive.
          this.work.delete(work.id);
        }
      }
    } finally { this.pumping = false; }
  }
  private async prepareReferences(work: PendingWork, folderPath: string) {
    const report = (detail: string) => this.patch(work.id, { detail });
    if (work.request.referenceVideos?.length) {
      work.request.referenceVideoIds = await prepareReferenceVideos(folderPath, work.request, work.config, () => work.cancelled, report);
    }
    if (work.request.referenceAudios?.length) {
      work.request.referenceAudioIds = await prepareReferenceAudios(folderPath, work.request, () => work.cancelled, report);
    }
  }
  private async exportRefmod(work: PendingWork, folderPath: string) {
    await this.prepareReferences(work, folderPath);
    if (work.cancelled) return;
    // The runtime's export call is synchronous, so it cannot be cancelled.
    this.patch(work.id, { status: "encoding", progress: 0.5, detail: "Encoding refmod" });
    await exportReferenceRefmod(work.request, work.config, work.refmod!);
    this.patch(work.id, { status: "completed", progress: 1, detail: "Refmod saved" });
    work.finish();
  }
  async cancel(id: string): Promise<void> {
    if (this.icons.owns(id)) { await this.icons.cancel(); return; }
    const item = this.items.find((candidate) => candidate.id === id);
    const work = this.work.get(id);
    if (!item || !work || !isWorkActive(item) || item.status === "encoding" || item.cancelling) return;
    work.cancelled = true;
    if (item.status === "queued" || item.status === "preparing") {
      this.cancelled(work);
      if (item.status === "queued") this.work.delete(id);
      // Stops files that are still being sent to a LAN worker for this job.
      if (item.status === "preparing" && remoteWorkerSelected()) void cancelSlopfabGeneration(work.request.jobId).catch(() => undefined);
      return;
    }
    this.patch(id, { cancelling: true, detail: "Cancelling generation" });
    if (work.submitted) await this.requestNativeCancellation(work);
  }
  private async requestNativeCancellation(work: PendingWork) {
    try { await cancelSlopfabGeneration(work.request.jobId); }
    catch (reason) {
      work.cancelled = false;
      this.patch(work.id, { cancelling: false, detail: work.image ? "Generating image" : "Generating video", error: `Could not cancel: ${describeDiagnosticError(reason)}` });
    }
  }
  cancelScenes(session: ProjectSession, sceneIds: string[]) {
    return Promise.all(this.items.filter((item) => item.projectKey === projectQueueKey(session.record) && sceneIds.includes(item.sceneId) && isWorkActive(item)).map((item) => this.cancel(item.id))).then(() => undefined);
  }
  private cancelled(work: PendingWork, detail = "Generation cancelled before it started.") {
    this.timing.clear(work.id);
    this.patch(work.id, { status: "cancelled", detail, cancelling: false, completionAt: null });
    this.updateScene(work, { status: "cancelled", stage: "failed", error: detail });
    void work.session.save().catch(() => undefined);
    work.finish();
  }
  private fail(work: PendingWork, reason: unknown) {
    if (work.cancelled) {
      if (this.items.find((item) => item.id === work.id)?.status !== "cancelled") this.cancelled(work);
      work.finish();
      return;
    }
    const detail = describeDiagnosticError(reason);
    this.timing.clear(work.id);
    this.patch(work.id, { status: "failed", detail: work.refmod ? "Refmod export failed" : "Generation failed", error: detail, completionAt: null, cancelling: false });
    this.updateScene(work, { status: "failed", stage: "failed", error: detail });
    writeDiagnostic("error", "work-queue", "generation.failed", detail, { workId: work.id, sceneId: work.sceneId, folderPath: work.session.record.folderPath });
    void work.session.save().catch(() => undefined);
    work.finish();
  }
  private progress(event: GenerationTimingProgress) {
    if (this.icons.progressEvent(event)) return;
    const work = this.nativeWork(event.jobId);
    const item = this.items.find((candidate) => candidate.id === work?.id);
    // A refmod export sends its files to a LAN worker while it is encoding.
    if (!work || !item || !(["preparing", "generating"].includes(item.status) || (work.refmod && item.status === "encoding" && isWorkerTransfer(event)))) return;
    if (isWorkerTransfer(event)) {
      // Files moving to a LAN worker: say what is happening without moving
      // the generation bar or the time estimate.
      if (!item.cancelling) this.patch(work.id, { detail: workerTransferDetail(event) });
      return;
    }
    if (work.characterSheet) {
      const sheet = work.characterSheet;
      const fraction = event.totalSteps > 0 ? Math.max(0, Math.min(1, event.step / event.totalSteps)) : 0;
      this.patch(work.id, { progress: Math.max(item.progress, (sheet.index + fraction) / sheet.order.length * 0.9),
        detail: item.cancelling ? "Cancelling generation" : `Character sheet ${sheet.index + 1}/${sheet.order.length} · ${CHARACTER_SHEET_VIEWS[sheet.order[sheet.index]].label}` });
      return;
    }
    const progress = Math.max(item.progress, event.totalSteps > 0 ? Math.min(0.88, 0.12 + Math.max(0, event.step) / event.totalSteps * 0.76) : event.stage === "delivering" ? 0.88 : 0.08);
    this.patch(work.id, { status: "generating", progress, completionAt: this.timing.update(event), detail: item.cancelling ? "Cancelling generation" : event.stage === "upscaling" ? "Upscaling video latents" : work.request.imageEdit ? `Applying image edits (${Math.min(work.request.imageEdit.edits.length, Math.floor(event.step / Math.max(1, event.totalSteps) * work.request.imageEdit.edits.length) + 1)} of ${work.request.imageEdit.edits.length})` : event.stage === "starting" || event.stage === "transformerLoad" ? "Loading MiniMax H3" : work.image ? "Generating image" : "Generating video" });
    this.updateScene(work, { status: "generating", stage: event.stage === "starting" || event.stage === "transformerLoad" ? "preparing" : "generating", progress }, false);
  }
  private event(event: JobEvent) {
    if (this.icons.event(event)) return;
    const work = this.nativeWork(event.jobId);
    const item = this.items.find((candidate) => candidate.id === work?.id);
    if (!work || !item) {
      if (event.state === "framesReady" && this.items.some((candidate) => candidate.id === event.jobId && !isWorkActive(candidate))) void releaseRendered(event.jobId);
      return;
    }
    if (!isWorkActive(item)) { if (event.state === "framesReady") void releaseRendered(event.jobId); return; }
    if (item.status === "encoding") return;
    if (work.characterSheet) {
      if (event.state === "framesReady") work.characterSheet.ready?.resolve();
      else if (event.state === "failed" || event.state === "cancelled") {
        if (event.state === "cancelled") work.cancelled = true;
        work.characterSheet.ready?.reject(new Error(event.detail));
      }
      return;
    }
    if (event.state === "framesReady") {
      if (event.output) this.timing.record(event.output);
      this.timing.clear(work.id);
      if (work.cancelled) { void releaseRendered(work.id).then(() => this.cancelled(work)); return; }
      void this.encode(work);
    } else if (event.state === "failed") this.fail(work, event.detail);
    else if (event.state === "cancelled") this.cancelled(work, event.detail);
    // A queued acknowledgement can arrive after progress. It must not rewind it.
  }
  private nativeWork(jobId: string) {
    return [...this.work.values()].find((work) => work.request.jobId === jobId);
  }
  private async generateCharacterSheet(work: PendingWork) {
    const sheet = work.characterSheet!;
    const folderPath = work.session.record.folderPath;
    const dimensions = sheet.dimensions;
    try {
      for (let index = 0; index < sheet.order.length; index++) {
        if (work.cancelled) return;
        sheet.index = index;
        const viewIndex = sheet.order[index];
        const { width, height } = dimensions[viewIndex];
        work.submitted = false;
        const view = sheet.views[viewIndex];
        work.request = { ...work.request, jobId: `${work.id}-view-${viewIndex + 1}`, prompt: view.prompt,
          canvasWidth: width, canvasHeight: height,
          referencePaths: view.references.flatMap((reference) => referenceImages(reference).map((image) => projectItemPath(folderPath, image)!)),
          refmods: referenceRefmodInputs(folderPath, view.references) };
        this.patch(work.id, { status: "preparing", detail: `Preparing character sheet view ${index + 1}/${sheet.order.length}` });
        await resolveSlopfabPlan(work.request, work.config, folderPath);
        if (work.cancelled) return;
        const ready = new Promise<void>((resolve, reject) => { sheet.ready = { resolve, reject }; });
        // Events can arrive before native submission returns.
        void ready.catch(() => undefined);
        this.patch(work.id, { status: "generating", detail: `Character sheet ${index + 1}/${sheet.order.length} · ${CHARACTER_SHEET_VIEWS[viewIndex].label}` });
        await enqueueSlopfabGeneration(work.request, work.config, folderPath);
        work.submitted = true;
        if (work.cancelled) await this.requestNativeCancellation(work);
        await ready;
        sheet.ready = undefined;
        if (work.cancelled) { this.cancelled(work); return; }
        this.patch(work.id, { status: "encoding", detail: `Saving character sheet view ${index + 1}/${sheet.order.length}` });
        await invoke("save_character_sheet_view", { folderPath, sheetId: work.id, jobId: work.request.jobId, index: viewIndex });
        await releaseRendered(work.request.jobId);
      }
      this.patch(work.id, { status: "encoding", progress: 0.95, detail: "Combining character sheet", completionAt: null });
      const saved = await invoke<{ relativePath: string; width: number; height: number }>("combine_character_sheet", { folderPath, sheetId: work.id, indices: [...sheet.order].sort((a, b) => a - b) });
      const scene = createImageEditScene({ ...saved, name: sheet.name }, work.config.imageScene ?? undefined);
      scene.referenceIds = [];
      const generation = { ...work.imageGeneration!, scene };
      work.session.update(derivedImageUpdate(work.id, sheet.sourceId, { id: work.id, kind: "image", name: sheet.name,
        ...saved, mimeType: "image/png", imageGeneration: generation, createdAt: new Date().toISOString() }));
      try { await work.session.save(); this.patch(work.id, { status: "completed", progress: 1, detail: "Character sheet saved" }); }
      catch (reason) { this.patch(work.id, { status: "failed", progress: 1, needsSave: true, detail: "Character sheet created; project save failed", error: describeDiagnosticError(reason) }); }
    } finally {
      sheet.ready = undefined;
      await releaseRendered(work.request.jobId).catch(() => undefined);
      await invoke("discard_character_sheet_views", { folderPath, sheetId: work.id }).catch((reason) =>
        writeDiagnostic("error", "work-queue", "character-sheet.cleanup_failed", describeDiagnosticError(reason), { workId: work.id }));
      work.finish();
    }
  }
  private async encode(work: PendingWork) {
    if (work.image) { await this.saveImage(work); return; }
    this.patch(work.id, { status: "encoding", progress: 0.9, detail: "Saving video", completionAt: null });
    this.updateScene(work, { status: "ready", stage: "encoding", progress: 0.9, error: null }, false);
    try {
      const saved = await saveGeneratedScene({
        folderPath: work.session.record.folderPath, jobId: work.id, thumbnailJobId: work.sceneId,
        ...(work.request.latentUpscale ? { outputSize: { width: work.request.canvasWidth, height: work.request.canvasHeight } } : {}),
        onProgress: (encoded, total) => {
          if (total <= 0) return;
          const progress = Math.min(0.99, 0.9 + encoded / total * 0.1);
          this.patch(work.id, { progress });
          this.updateScene(work, { progress }, false);
        },
      });
      const assetId = generationAssetId(work.sceneId);
      const totalFrames = saved.durationMs ? Math.round(saved.durationMs * GENERATION_FRAME_RATE / 1000) : work.outputFrames ?? work.request.frames;
      const sceneSegments = work.request.latentBridge
        ? bridgedSceneSegments(work.sceneId, generationLatentPath(work.id), totalFrames, work.request.frames, work.request.latentBridge, work.bridgeSegments)
        : joinedSceneSegments(work.sceneId, generationLatentPath(work.id), totalFrames,
        Math.ceil(work.request.frames / 17) * 17, work.request.previousSceneId ? {
          sceneId: work.request.previousSceneId, latentRelativePath: work.request.continuationRelativePath!,
          frameCount: work.request.continuationSourceFrames ?? totalFrames - Math.ceil(work.request.frames / 17) * 17,
          segments: work.continuationSegments, from: work.request.continuationFrom,
        } : undefined);
      const media = { kind: "generated" as const, relativePath: saved.relativePath, sourcePath: null, mimeType: "video/mp4", hasAudio: saved.hasAudio ?? null, width: saved.width ?? work.request.canvasWidth, height: saved.height ?? work.request.canvasHeight, durationMs: saved.durationMs ?? Math.round(totalFrames / GENERATION_FRAME_RATE * 1000), sceneSegments };
      work.session.update(videoResultUpdate(work.sceneId, assetId, media, { status: "completed", stage: "completed", progress: 1,
        generationSnapshot: work.snapshot, outputRelativePath: saved.relativePath, latentRelativePath: generationLatentPath(work.id), error: saved.note }));
      try {
        await work.session.save();
        this.patch(work.id, { status: "completed", progress: 1, detail: "Video saved", error: saved.note });
      } catch (reason) {
        this.patch(work.id, { status: "failed", progress: 1, needsSave: true, detail: "Video created; project save failed", error: describeDiagnosticError(reason) });
      }
    } catch (reason) { this.fail(work, reason); }
    finally { await releaseRendered(work.id); work.finish(); }
  }
  async retrySave(id: string) {
    if (this.icons.owns(id)) { await this.icons.retrySave(); return; }
    const item = this.items.find((candidate) => candidate.id === id);
    const session = item && this.projects.get(item.projectKey);
    if (!item?.needsSave || !session) return;
    try { await session.save(); this.patch(id, { status: "completed", needsSave: false, error: null, detail: item.kind === "image" ? "Image saved" : "Video saved" }); }
    catch (reason) { this.patch(id, { error: describeDiagnosticError(reason) }); }
  }
  private async saveImage(work: PendingWork) {
    this.patch(work.id, { status: "encoding", progress: 0.9, detail: "Saving image", completionAt: null });
    try {
      const saved = await invoke<{ relativePath: string; width: number; height: number }>(work.extend ? "save_extended_image" : "save_generated_image", { folderPath: work.session.record.folderPath, jobId: work.id, ...(!work.extend && work.request.imageEdit ? { format: "png" } : {}) });
      if (work.extend) {
        const scene = createImageEditScene({ ...saved, name: work.extend.name }, { ...work.config.imageScene!, steps: work.request.steps, seed: work.request.seed });
        work.imageGeneration = { ...work.imageGeneration!, scene };
        work.session.update(derivedImageUpdate(work.id, work.extend.sourceId, { id: work.id, kind: "image", name: work.extend.name,
          ...saved, mimeType: "image/png", imageGeneration: work.imageGeneration, createdAt: new Date().toISOString() }));
      } else {
        work.session.update(imageResultUpdate({ id: work.id, imageDraftId: work.imageDraftId, imageParentId: work.imageParentId,
          imageGeneration: work.imageGeneration, snapshot: work.snapshot, outputAssetId: work.config.imageScene?.outputAssetId,
          imageEdit: Boolean(work.request.imageEdit), saved }));
      }
      try { await work.session.save(); this.patch(work.id, { status: "completed", progress: 1, detail: "Image saved" }); }
      catch (reason) { this.patch(work.id, { status: "failed", progress: 1, needsSave: true, detail: "Image created; project save failed", error: describeDiagnosticError(reason) }); }
    } catch (reason) { this.fail(work, reason); }
    finally {
      try { await releaseRendered(work.id); }
      finally { work.finish(); }
    }
  }
}

// These factories live outside the running job's closure scope: undo replay
// retains only the result fields, never its full submitted project snapshot.
function sceneUpdate(sceneId: string, patch: Partial<GenerationJob>) {
  return (current: ProjectConfig): ProjectConfig => ({ ...current,
    generationJobs: current.generationJobs.map((job) => job.id === sceneId ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job),
  });
}

function derivedImageUpdate(id: string, sourceId: string, asset: ProjectAsset) {
  return (current: ProjectConfig) => completeImageDraft(current, id, {
    ...asset, parentAssetId: imageFamilyRoot(current.assets, sourceId),
  });
}

function videoResultUpdate(sceneId: string, assetId: string, media: Omit<ProjectAsset, "id" | "name" | "createdAt">, patch: Partial<GenerationJob>) {
  const update = sceneUpdate(sceneId, patch);
  return (current: ProjectConfig): ProjectConfig => ({
    ...update(current),
    assets: current.assets.some((asset) => asset.id === assetId)
      ? current.assets.map((asset) => asset.id === assetId ? { ...asset, ...media } : asset)
      : current.generationJobs.some((job) => job.id === sceneId)
        ? [...current.assets, { id: assetId, name: current.generationJobs.find((job) => job.id === sceneId)!.title, createdAt: new Date().toISOString(), ...media }]
        : current.assets,
    timeline: { tracks: current.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.assetId === assetId ? { ...clip, status: "generated" } : clip) })) },
  });
}

function imageResultUpdate({ id, imageDraftId, imageParentId, imageGeneration, snapshot, outputAssetId, imageEdit, saved }: {
  id: string; imageDraftId?: string; imageParentId?: string; imageGeneration?: ImageGenerationSnapshot; snapshot: string;
  outputAssetId?: string | null; imageEdit: boolean; saved: { relativePath: string; width: number; height: number };
}) {
  const mimeType = imageEdit ? "image/png" : "image/jpeg";
  return (current: ProjectConfig): ProjectConfig => imageDraftId ? completeImageDraft(current, imageDraftId, {
    id: imageDraftId, kind: "image", name: `Image ${current.assets.filter((asset) => asset.kind === "image" && !asset.imageDraft).length + 1}`,
    ...saved, imageGeneration, mimeType, createdAt: new Date().toISOString(),
  }) : ({ ...current,
    ...(current.imageScene?.outputAssetId === outputAssetId ? {
      thumbnail: saved.relativePath,
      imageScene: { ...(imageEdit && JSON.stringify(current.imageScene) === snapshot ? createImageEditScene({ ...saved, name: "Edited image" }, current.imageScene ?? undefined) : current.imageScene ?? createImageScene()), outputAssetId: id },
    } : {}),
    assets: [...current.assets, { id, kind: "image", name: `Image ${current.assets.filter((asset) => asset.kind === "image").length + 1}`, ...saved, imageGeneration, mimeType, ...(imageParentId ? { parentAssetId: imageFamilyRoot(current.assets, imageParentId) } : {}), createdAt: new Date().toISOString() }],
  });
}

type WorkerTransfer = GenerationTimingProgress & { detail?: string; transferred?: number; transferTotal?: number | null };

function isWorkerTransfer(event: GenerationTimingProgress): event is WorkerTransfer {
  return event.stage === "workerUpload" || event.stage === "workerDownload";
}

function workerTransferDetail(event: WorkerTransfer): string {
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  const amount = event.transferTotal ? ` · ${Math.floor(100 * (event.transferred ?? 0) / event.transferTotal)}% of ${gb(event.transferTotal)}`
    : event.transferred ? ` · ${gb(event.transferred)}` : "";
  return `${event.detail ?? (event.stage === "workerUpload" ? "Sending files to the worker" : "Worker downloading weights")}${amount}`;
}
