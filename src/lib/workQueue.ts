import { listen } from "@tauri-apps/api/event";
import { describeDiagnosticError, writeDiagnostic } from "./diagnostics";
import { GenerationTimingEstimator, type CompletedGenerationTiming, type GenerationTimingProgress } from "./generationTiming";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { isTauri, saveProject } from "./persistence";
import { generationAssetId, GENERATION_FRAME_RATE, projectItemPath, sceneGenerationSnapshot, type GenerationJob, type ProjectRecord, type ProjectConfig } from "./project";
import { saveSceneLastFrame } from "./sceneLastFrame";
import { ProjectSession, type ProjectWriter } from "./projectSession";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan, type SlopfabGenerationRequest } from "./runtime";
import { generationStepsWithLoras, withEngineSettings } from "./settings";
import { purgeTimelineThumbnails } from "./timelineThumbnails";
import { ReferenceIconWork } from "./referenceIconWork";
import { prepareReferenceVideos, releaseReferenceVideos } from "./referenceVideo";

export type WorkStatus = "queued" | "preparing" | "generating" | "encoding" | "completed" | "failed" | "cancelled";
export interface GenerationSubmission { job: GenerationJob; request: SlopfabGenerationRequest; snapshot: string }
export interface WorkItem {
  kind?: "reference-icons";
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
  settings: { frames: number; steps: number; seed: number; canvasWidth: number; canvasHeight: number };
}
interface PendingWork {
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

  enqueue(session: ProjectSession, submissions: GenerationSubmission[]) {
    const projectKey = projectQueueKey(session.record);
    // Take every setting before the first await, including the selected engine
    // template. Planning and native submission consume this same private copy.
    const config = structuredClone(withEngineSettings(session.getSnapshot().config));
    for (const submission of submissions) {
      if (this.items.some((item) => item.projectKey === projectKey && item.sceneId === submission.job.id && isWorkActive(item))) continue;
      const id = `work-${crypto.randomUUID()}`;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      const request = structuredClone({ ...submission.request, jobId: id, steps: generationStepsWithLoras(submission.request.steps, config) });
      this.work.set(id, { id, session, sceneId: submission.job.id, request, config, snapshot: submission.snapshot, cancelled: false, submitted: false, done, finish });
      this.items = [...this.items, {
        id, projectKey, folderPath: session.record.folderPath, projectName: config.name,
        sceneId: submission.job.id, title: submission.job.title, submittedAt: new Date().toISOString(),
        status: "queued", progress: 0, detail: "Waiting to generate", error: null, completionAt: null,
        cancelling: false, needsSave: false,
        settings: { frames: request.frames, steps: request.steps, seed: request.seed, canvasWidth: request.canvasWidth, canvasHeight: request.canvasHeight },
      }];
      this.updateScene(this.work.get(id)!, { status: "queued", stage: "queued", progress: 0, error: null, generationSnapshot: submission.snapshot });
    }
    this.publish();
    if (this.items.some((item) => item.status === "queued" && item.kind !== "reference-icons")) this.icons.yieldToVideo();
    void this.pump();
  }
  private updateScene(work: PendingWork, patch: Partial<GenerationJob>, dirty = true) {
    work.session.update((current) => ({
      ...current, generationJobs: current.generationJobs.map((job) => job.id === work.sceneId ? { ...job, ...patch, updatedAt: new Date().toISOString() } : job),
    }), dirty);
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
        this.patch(work.id, { status: "preparing", detail: "Preparing generation" });
        try {
          await this.ready;
          if (work.cancelled) continue;
          // Newly created scenes/references must exist on disk before any
          // background result can be attached to this project.
          await work.session.save();
          if (work.cancelled) continue;
          if (work.request.previousSceneId) {
            const previous = work.session.getSnapshot().config.generationJobs.find((job) => job.id === work.request.previousSceneId);
            if (!previous?.outputRelativePath || previous.status !== "completed") {
              throw new Error("Generate the previous scene successfully before using its last frame.");
            }
            const relativePath = await saveSceneLastFrame(next.folderPath, previous.outputRelativePath);
            if (work.cancelled) continue;
            work.request.referencePaths[0] = projectItemPath(next.folderPath, { relativePath })!;
            const captured = work.config.generationJobs.find((job) => job.id === work.sceneId)!;
            work.snapshot = sceneGenerationSnapshot(captured, work.request);
            this.updateScene(work, { generationSnapshot: work.snapshot });
          }
          await purgeTimelineThumbnails(next.folderPath, work.sceneId).catch(() => undefined);
          if (work.cancelled) continue;
          if (work.request.referenceVideos?.length) {
            work.request.referenceVideoIds = await prepareReferenceVideos(next.folderPath, work.request, work.config,
              () => work.cancelled, (detail) => this.patch(work.id, { detail }));
          }
          if (work.cancelled) continue;
          const plan = await resolveSlopfabPlan(work.request, work.config);
          if (work.cancelled) continue;
          this.patch(work.id, { status: "generating", detail: `Generating ${plan.alignedFrames} frames at ${plan.canvasWidth} × ${plan.canvasHeight}` });
          this.updateScene(work, { status: "generating", stage: "preparing" }, false);
          await enqueueSlopfabGeneration(work.request, work.config);
          work.submitted = true;
          if (work.cancelled) await this.requestNativeCancellation(work);
          await work.done;
        } catch (reason) { this.fail(work, reason); }
        finally {
          await releaseReferenceVideos(work.request.referenceVideoIds ?? []).catch((reason) =>
            writeDiagnostic("error", "work-queue", "references.release_failed", describeDiagnosticError(reason), { workId: work.id }));
          delete work.request.referenceVideoIds;
        }
      }
    } finally { this.pumping = false; }
  }
  async cancel(id: string): Promise<void> {
    if (this.icons.owns(id)) { await this.icons.cancel(); return; }
    const item = this.items.find((candidate) => candidate.id === id);
    const work = this.work.get(id);
    if (!item || !work || !isWorkActive(item) || item.status === "encoding" || item.cancelling) return;
    work.cancelled = true;
    if (item.status === "queued" || item.status === "preparing") {
      this.cancelled(work);
      return;
    }
    this.patch(id, { cancelling: true, detail: "Cancelling generation" });
    if (work.submitted) await this.requestNativeCancellation(work);
  }
  private async requestNativeCancellation(work: PendingWork) {
    try { await cancelSlopfabGeneration(work.id); }
    catch (reason) {
      work.cancelled = false;
      this.patch(work.id, { cancelling: false, detail: "Generating video", error: `Could not cancel: ${describeDiagnosticError(reason)}` });
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
    this.patch(work.id, { status: "failed", detail: "Generation failed", error: detail, completionAt: null, cancelling: false });
    this.updateScene(work, { status: "failed", stage: "failed", error: detail });
    writeDiagnostic("error", "work-queue", "generation.failed", detail, { workId: work.id, sceneId: work.sceneId, folderPath: work.session.record.folderPath });
    void work.session.save().catch(() => undefined);
    work.finish();
  }
  private progress(event: GenerationTimingProgress) {
    if (this.icons.progressEvent(event)) return;
    const work = this.work.get(event.jobId);
    const item = this.items.find((candidate) => candidate.id === event.jobId);
    if (!work || !item || !["preparing", "generating"].includes(item.status)) return;
    const progress = Math.max(item.progress, event.totalSteps > 0 ? Math.min(0.88, 0.12 + Math.max(0, event.step) / event.totalSteps * 0.76) : event.stage === "delivering" ? 0.88 : 0.08);
    this.patch(work.id, { status: "generating", progress, completionAt: this.timing.update(event), detail: item.cancelling ? "Cancelling generation" : event.stage === "starting" || event.stage === "transformerLoad" ? "Loading video engine" : "Generating video" });
    this.updateScene(work, { status: "generating", stage: event.stage === "starting" || event.stage === "transformerLoad" ? "preparing" : "generating", progress }, false);
  }
  private event(event: JobEvent) {
    if (this.icons.event(event)) return;
    const work = this.work.get(event.jobId);
    const item = this.items.find((candidate) => candidate.id === event.jobId);
    if (!work || !item) return;
    if (!isWorkActive(item)) { if (event.state === "framesReady") void releaseRendered(work.id); return; }
    if (item.status === "encoding") return;
    if (event.state === "framesReady") {
      if (event.output) this.timing.record(event.output);
      this.timing.clear(work.id);
      if (work.cancelled) { void releaseRendered(work.id).then(() => this.cancelled(work)); return; }
      void this.encode(work);
    } else if (event.state === "failed") this.fail(work, event.detail);
    else if (event.state === "cancelled") this.cancelled(work, event.detail);
    // A queued acknowledgement can arrive after progress. It must not rewind it.
  }
  private async encode(work: PendingWork) {
    this.patch(work.id, { status: "encoding", progress: 0.9, detail: "Saving video", completionAt: null });
    this.updateScene(work, { status: "ready", stage: "encoding", progress: 0.9, error: null }, false);
    try {
      const saved = await saveGeneratedScene({
        folderPath: work.session.record.folderPath, jobId: work.id, thumbnailJobId: work.sceneId,
        onProgress: (encoded, total) => {
          if (total <= 0) return;
          const progress = Math.min(0.99, 0.9 + encoded / total * 0.1);
          this.patch(work.id, { progress });
          this.updateScene(work, { progress }, false);
        },
      });
      const assetId = generationAssetId(work.sceneId);
      const media = { kind: "generated" as const, relativePath: saved.relativePath, sourcePath: null, mimeType: "video/mp4", hasAudio: saved.hasAudio ?? null, width: saved.width ?? work.request.canvasWidth, height: saved.height ?? work.request.canvasHeight, durationMs: saved.durationMs ?? Math.round(work.request.frames / GENERATION_FRAME_RATE * 1000) };
      work.session.update((current) => ({
        ...current,
        generationJobs: current.generationJobs.map((job) => job.id === work.sceneId ? { ...job, status: "completed", stage: "completed", progress: 1, generationSnapshot: work.snapshot, outputRelativePath: saved.relativePath, error: saved.note, updatedAt: new Date().toISOString() } : job),
        assets: current.assets.some((asset) => asset.id === assetId)
          ? current.assets.map((asset) => asset.id === assetId ? { ...asset, ...media } : asset)
          : current.generationJobs.some((job) => job.id === work.sceneId)
            ? [...current.assets, { id: assetId, name: current.generationJobs.find((job) => job.id === work.sceneId)!.title, createdAt: new Date().toISOString(), ...media }]
            : current.assets,
        timeline: { tracks: current.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.assetId === assetId ? { ...clip, status: "generated" } : clip) })) },
      }));
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
    const work = this.work.get(id);
    if (!work) return;
    try { await work.session.save(); this.patch(id, { status: "completed", needsSave: false, error: null, detail: "Video saved" }); }
    catch (reason) { this.patch(id, { error: describeDiagnosticError(reason) }); }
  }
}
