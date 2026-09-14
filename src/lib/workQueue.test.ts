// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "./project";
import { ProjectSession } from "./projectSession";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan } from "./runtime";
import { saveEngineSettings, EMPTY_ENGINE_SETTINGS } from "./settings";
import { WorkQueue, type GenerationSubmission } from "./workQueue";
import { saveSceneLastFrame } from "./sceneLastFrame";
import { prepareReferenceVideos, releaseReferenceVideos } from "./referenceVideo";
import { downloadTemplateWeights, getWeightDownloadState } from "./weightDownloads";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ saveGeneratedScene: vi.fn(), releaseRendered: vi.fn(async () => true) }));
vi.mock("./timelineThumbnails", () => ({ purgeTimelineThumbnails: vi.fn(async () => undefined) }));
vi.mock("./sceneLastFrame", () => ({ saveSceneLastFrame: vi.fn(async () => "cache/scene-last/work-new.png") }));
vi.mock("./referenceVideo", () => ({ prepareReferenceVideos: vi.fn(async () => ["video-1"]), releaseReferenceVideos: vi.fn(async () => undefined) }));
vi.mock("./runtime", () => ({ cancelSlopfabGeneration: vi.fn(), enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn() }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const stops: (() => void)[] = [];
const plan = { alignedFrames: 120, canvasWidth: 736, canvasHeight: 416, boundary: "Test plan" };
beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  vi.clearAllMocks();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => { handlers.delete(name); }; }) as typeof listen);
  vi.mocked(resolveSlopfabPlan).mockResolvedValue(plan as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
  vi.mocked(enqueueSlopfabGeneration).mockResolvedValue(undefined);
  vi.mocked(cancelSlopfabGeneration).mockResolvedValue(true);
  vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/result.mp4", bytes: 100, hasAudio: true, note: null });
});
afterEach(() => { stops.splice(0).forEach((stop) => stop()); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.restoreAllMocks(); });
const project = (name: string): ProjectRecord => ({ folderPath: `C:/${name}`, config: createProjectConfig({ name, prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 }) });
const submission = (session: ProjectSession): GenerationSubmission => ({
  job: session.getSnapshot().config.generationJobs[0], snapshot: "submitted settings",
  request: { jobId: "job-initial-brief", prompt: "Original prompt", frames: 120, steps: 12, seed: 42, canvasWidth: 736, canvasHeight: 416, referencePaths: ["C:/reference.png"] },
});
const setup = () => {
  const saved = vi.fn(async (record: ProjectRecord) => record);
  const queue = new WorkQueue(saved);
  stops.push(queue.start());
  return { queue, saved, first: queue.project(project("First")), second: queue.project(project("Second")) };
};
const emit = (name: string, payload: unknown) => handlers.get(name)?.({ payload });
const finish = async (queue: WorkQueue, id: string) => {
  emit("slopfab-job", { jobId: id, state: "framesReady", detail: "Frames ready" });
  await waitFor(() => expect(queue.getSnapshot().find((item) => item.id === id)?.status).toBe("completed"));
};

describe("application work queue", () => {
  it("prepares video inputs for both planning and generation and releases them after completion", async () => {
    const { queue, first } = setup();
    const next = submission(first);
    next.request.referenceVideos = [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 1, durationSeconds: 2, includeAudio: true }];
    queue.enqueue(first, [next]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    expect(prepareReferenceVideos).toHaveBeenCalledOnce();
    expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0].referenceVideoIds).toEqual(["video-1"]);
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].referenceVideoIds).toEqual(["video-1"]);
    await finish(queue, queue.getSnapshot()[0].id);
    await waitFor(() => expect(releaseReferenceVideos).toHaveBeenCalledWith(["video-1"]));
  });

  it("releases prepared video inputs when planning fails", async () => {
    const { queue, first } = setup();
    const next = submission(first);
    next.request.referenceVideos = [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 0, durationSeconds: 2, includeAudio: false }];
    vi.mocked(resolveSlopfabPlan).mockRejectedValueOnce(new Error("Reference limit exceeded"));
    queue.enqueue(first, [next]);
    await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("failed"));
    expect(releaseReferenceVideos).toHaveBeenCalledWith(["video-1"]);
    expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  });

  it("continues from the newly saved latents after the previous scene finishes", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [config.generationJobs[0], { ...config.generationJobs[0], id: "linked", usePreviousSceneLastFrame: true }] }));
    const source = submission(first);
    const linked = { ...submission(first), job: first.getSnapshot().config.generationJobs[1], request: { ...source.request, previousSceneId: source.job.id, referencePaths: ["subject.png"] } };
    queue.enqueue(first, [source, linked]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    expect(saveSceneLastFrame).not.toHaveBeenCalled();
    await finish(queue, queue.getSnapshot()[0].id);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    expect(saveSceneLastFrame).not.toHaveBeenCalled();
    const latentPath = `latents/${queue.getSnapshot()[0].id}.safetensors`;
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0]).toMatchObject({ referencePaths: ["subject.png"], continuationRelativePath: latentPath });
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][2]).toBe("C:/First");
    await finish(queue, queue.getSnapshot()[1].id);
    const snapshot = JSON.parse(first.getSnapshot().config.generationJobs[1].generationSnapshot!);
    expect(snapshot.previousSceneId).toBe(source.job.id);
    expect(snapshot.continuationRelativePath).toBe(latentPath);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(first.getSnapshot().config))).generationJobs[1].latentRelativePath)
      .toBe(`latents/${queue.getSnapshot()[1].id}.safetensors`);
  });

  it("asks for regeneration when an older completed scene has no latent archive", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [
      { ...config.generationJobs[0], status: "completed", outputRelativePath: "media/generated/old.mp4" },
      { ...config.generationJobs[0], id: "linked", usePreviousSceneLastFrame: true },
    ] }));
    const source = submission(first);
    queue.enqueue(first, [{ ...source, job: first.getSnapshot().config.generationJobs[1], request: { ...source.request, previousSceneId: source.job.id } }]);
    await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("failed"));
    expect(queue.getSnapshot()[0].error).toContain("save its latents");
    expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  });

  it("fails a dependent scene if the previous generation fails, even when an older video exists", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [{ ...config.generationJobs[0], outputRelativePath: "media/generated/old.mp4" }, { ...config.generationJobs[0], id: "linked", usePreviousSceneLastFrame: true }] }));
    const source = submission(first);
    queue.enqueue(first, [source, { ...source, job: first.getSnapshot().config.generationJobs[1], request: { ...source.request, previousSceneId: source.job.id } }]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    emit("slopfab-job", { jobId: queue.getSnapshot()[0].id, state: "failed", detail: "Render failed" });
    await waitFor(() => expect(queue.getSnapshot()[1].status).toBe("failed"));
    expect(queue.getSnapshot()[1].error).toContain("previous scene");
    expect(saveSceneLastFrame).not.toHaveBeenCalled();
    expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
  });

  it("starts and advances generations while a weight download remains in progress", async () => {
    let finishDownload: () => void = () => undefined;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "weight_download_hardware") return [];
      if (command === "download_weight") return new Promise<string>((resolve) => { finishDownload = () => resolve("C:/weights/model"); });
    });
    const downloading = downloadTemplateWeights("minimax-h3-original");
    try {
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("download_weight", expect.anything()));
      const { queue, first, second } = setup();
      queue.enqueue(first, [submission(first)]);
      queue.enqueue(second, [submission(second)]);
      await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
      expect(getWeightDownloadState()?.active).toBe(true);
      expect(queue.getSnapshot()).toHaveLength(2);
      await finish(queue, queue.getSnapshot()[0].id);
      await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
      expect(getWeightDownloadState()?.active).toBe(true);
    } finally {
      vi.mocked(invoke).mockResolvedValue("C:/weights/model");
      finishDownload();
      await downloading;
    }
  });
  it("blocks app updates for unsaved sessions and allows them after a successful save", async () => {
    const { queue, first } = setup();
    expect(queue.updateBlockReason()).toBeNull();
    first.update((config) => ({ ...config, name: "Unsaved title" }));
    expect(queue.updateBlockReason()).toContain("Save your project");
    await first.save();
    expect(queue.updateBlockReason()).toBeNull();
  });
  it("isolates identical scene IDs across projects and freezes inputs before any asynchronous preparation", async () => {
    const { queue, first, second } = setup();
    saveEngineSettings({ ...EMPTY_ENGINE_SETTINGS, transformer: "C:/original-model" });
    const next = submission(second);
    queue.enqueue(first, [submission(first)]);
    queue.enqueue(second, [next]);
    const [a, b] = queue.getSnapshot();
    expect(a.id).not.toBe(b.id);
    expect(a.sceneId).toBe(b.sceneId);
    expect(b.status).toBe("queued");
    next.request.prompt = "Mutated input";
    next.request.referencePaths.push("C:/other.png");
    second.update((current) => ({ ...current, name: "Edited later", settings: { ...current.settings, resolution: "1344p" }, generationJobs: current.generationJobs.map((job) => ({ ...job, soundscape: "Rain added later", steps: 30 })) }));
    saveEngineSettings({ ...EMPTY_ENGINE_SETTINGS, transformer: "C:/different-model" });
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    await finish(queue, a.id);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    const [request, frozen] = vi.mocked(enqueueSlopfabGeneration).mock.calls[1];
    expect(request).toMatchObject({ jobId: b.id, prompt: "Original prompt", steps: 12, canvasWidth: 736, referencePaths: ["C:/reference.png"] });
    expect(frozen.name).toBe("Second");
    expect(frozen.settings.resolution).toBe("416p");
    expect(JSON.stringify(frozen.providerSettings)).toContain("C:/original-model");
    await finish(queue, b.id);
    expect(saveGeneratedScene).toHaveBeenLastCalledWith(expect.objectContaining({ folderPath: "C:/Second", jobId: b.id, thumbnailJobId: b.sceneId }));
    expect(second.getSnapshot().config.name).toBe("Edited later");
    expect(second.getSnapshot().config.generationJobs[0]).toMatchObject({ status: "completed", steps: 30, soundscape: "Rain added later", generationSnapshot: "submitted settings" });
    expect(second.getSnapshot().config.assets[0]).toMatchObject({ id: `asset-${b.sceneId}`, relativePath: "media/generated/result.mp4", width: 736, height: 416, durationMs: 5000 });
    expect(parseProjectConfig(second.getSnapshot().config)).toBeTruthy();
  });

  it("cancels queued work immediately and never submits it to the engine", async () => {
    const { queue, first, second } = setup();
    queue.enqueue(first, [submission(first)]);
    queue.enqueue(second, [submission(second)]);
    const [a, b] = queue.getSnapshot();
    await queue.cancel(b.id);
    expect(queue.getSnapshot()[1].status).toBe("cancelled");
    expect(second.getSnapshot().config.generationJobs[0].status).toBe("cancelled");
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    await finish(queue, a.id);
    expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
    expect(cancelSlopfabGeneration).not.toHaveBeenCalled();
  });

  it("cancels during planning without a late enqueue", async () => {
    let planned!: (value: Awaited<ReturnType<typeof resolveSlopfabPlan>>) => void;
    vi.mocked(resolveSlopfabPlan).mockImplementationOnce(() => new Promise((resolve) => { planned = resolve; }));
    const { queue, first } = setup();
    queue.enqueue(first, [submission(first)]);
    await waitFor(() => expect(resolveSlopfabPlan).toHaveBeenCalled());
    await queue.cancel(queue.getSnapshot()[0].id);
    planned(plan as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  });

  it("cancels a render even when cancellation races with the native enqueue acknowledgement", async () => {
    let accepted!: () => void;
    vi.mocked(enqueueSlopfabGeneration).mockImplementationOnce(() => new Promise((resolve) => { accepted = resolve; }));
    const { queue, first } = setup();
    queue.enqueue(first, [submission(first)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalled());
    const id = queue.getSnapshot()[0].id;
    await queue.cancel(id);
    accepted();
    await waitFor(() => expect(cancelSlopfabGeneration).toHaveBeenCalledWith(id));
    emit("slopfab-job", { jobId: id, state: "cancelled", detail: "Stopped" });
    expect(queue.getSnapshot()[0].status).toBe("cancelled");
  });

  it("waits for encoding and project persistence, and encodes duplicate completion events only once", async () => {
    let encoded!: (value: Awaited<ReturnType<typeof saveGeneratedScene>>) => void;
    vi.mocked(saveGeneratedScene).mockImplementationOnce(() => new Promise((resolve) => { encoded = resolve; }));
    const { queue, first, second, saved } = setup();
    queue.enqueue(first, [submission(first)]);
    queue.enqueue(second, [submission(second)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    const id = queue.getSnapshot()[0].id;
    emit("slopfab-job", { jobId: id, state: "framesReady" });
    emit("slopfab-job", { jobId: id, state: "framesReady" });
    expect(saveGeneratedScene).toHaveBeenCalledTimes(1);
    expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()[0].status).toBe("encoding");
    let persisted!: (record: ProjectRecord) => void;
    saved.mockImplementationOnce(() => new Promise((resolve) => { persisted = resolve; }));
    encoded({ relativePath: "media/generated/finished.mp4", bytes: 100, note: "Saved without sound" });
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
    persisted({ ...first.record, config: first.getSnapshot().config });
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    expect(first.getSnapshot().config.generationJobs[0].error).toBe("Saved without sound");
  });

  it("moves on after a failure, ignores stale events, and can retry a failed project save without rerendering", async () => {
    const { queue, first, second, saved } = setup();
    queue.enqueue(first, [submission(first)]);
    queue.enqueue(second, [submission(second)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    const [a, b] = queue.getSnapshot();
    emit("slopfab-job", { jobId: a.id, state: "failed", detail: "Missing weights" });
    emit("slopfab-progress", { jobId: a.id, step: 5, totalSteps: 10 });
    expect(first.getSnapshot().config.generationJobs[0].status).toBe("failed");
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    saved.mockRejectedValueOnce(new Error("Project file locked"));
    emit("slopfab-job", { jobId: b.id, state: "framesReady" });
    await waitFor(() => expect(queue.getSnapshot()[1].needsSave).toBe(true));
    queue.clearFinished();
    expect(queue.getSnapshot()).toHaveLength(1);
    await queue.retrySave(b.id);
    expect(queue.getSnapshot()[0]).toMatchObject({ status: "completed", needsSave: false });
    expect(saveGeneratedScene).toHaveBeenCalledTimes(1);
  });

  it("preserves monotonic progress and clears the estimate when encoding begins", async () => {
    const { queue, first } = setup();
    queue.enqueue(first, [submission(first)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    const id = queue.getSnapshot()[0].id;
    emit("slopfab-progress", { jobId: id, stage: "denoising", step: 40, totalSteps: 50 });
    const progress = queue.getSnapshot()[0].progress;
    emit("slopfab-progress", { jobId: id, stage: "audioDecode", step: 0, totalSteps: 0 });
    emit("slopfab-job", { jobId: id, state: "queued" });
    expect(queue.getSnapshot()[0]).toMatchObject({ progress, status: "generating" });
    expect(progress).toBeGreaterThan(0.7);
    await finish(queue, id);
    expect(queue.getSnapshot()[0].completionAt).toBeNull();
  });

  it("rejects duplicate submissions and prevents deletion of a project with unfinished work", () => {
    const { queue, first } = setup();
    queue.enqueue(first, [submission(first), submission(first)]);
    expect(queue.getSnapshot()).toHaveLength(1);
    expect(() => queue.forgetProject(first.record)).toThrow(/Cancel or finish/);
    expect(queue.project(first.record)).toBe(first);
  });

  it("does not revive cancelled work when a late rendered event arrives", async () => {
    const { queue, first, second } = setup();
    queue.enqueue(first, [submission(first)]);
    queue.enqueue(second, [submission(second)]);
    const id = queue.getSnapshot()[1].id;
    await queue.cancel(id);
    emit("slopfab-job", { jobId: id, state: "framesReady" });
    expect(releaseRendered).toHaveBeenCalledWith(id);
    expect(saveGeneratedScene).not.toHaveBeenCalled();
  });
  it("makes interrupted scenes restartable after the application has closed", () => {
    const record = project("Interrupted");
    record.config.generationJobs[0].status = "generating";
    const queue = new WorkQueue(async () => undefined);
    const job = queue.project(record).getSnapshot().config.generationJobs[0];
    expect(job.status).toBe("failed");
    expect(job.error).toContain("interrupted");
    expect(queue.getSnapshot()).toEqual([]);
  });
});

describe("project sessions", () => {
  it("orders saves and keeps edits made during a save dirty", async () => {
    let finish!: () => void;
    const writer = vi.fn((_record: ProjectRecord) => new Promise<void>((resolve) => { finish = resolve; }));
    const session = new ProjectSession(project("First"), writer);
    session.update((config) => ({ ...config, name: "Before save" }));
    const saving = session.save();
    await waitFor(() => expect(writer).toHaveBeenCalledTimes(1));
    session.update((config) => ({ ...config, name: "After save" }));
    finish(); await saving;
    expect(session.getSnapshot().dirty).toBe(true);
    expect(session.getSnapshot().config.name).toBe("After save");
    expect(writer.mock.calls[0][0].config.name).toBe("Before save");
    await session.discard();
    expect(session.getSnapshot().config.name).toBe("Before save");
    expect(session.getSnapshot().dirty).toBe(false);
  });
});
