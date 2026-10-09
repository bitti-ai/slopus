// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "./project";
import { ProjectSession } from "./projectSession";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan } from "./runtime";
import { saveEngineSettings, saveGeneratorTemplateSettings, loadGeneratorTemplateSettings, EMPTY_ENGINE_SETTINGS, type GeneratorTemplate } from "./settings";
import { generateAgentScene } from "./agentGeneration";
import { LATENT_UPSCALER_URL, saveLocalOtherWeightPaths } from "./upscalers";
import { WorkQueue, type GenerationSubmission } from "./workQueue";
import { saveSceneLastFrame } from "./sceneLastFrame";
import { prepareReferenceVideos, releaseReferenceVideos } from "./referenceVideo";
import { downloadTemplateWeights, getWeightDownloadState } from "./weightDownloads";
import { compileImagePrompt } from "./imagePrompt";
import { addImageNode, createImageEditScene } from "./imageScene";
import { createEmptyImage, makeImagePrimary, restoreGeneratedImage } from "./imageHistory";
import { sceneGenerationRequest } from "./sceneGeneration";
import { bridgeGapFrames } from "./longShot";

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
  vi.mocked(resolveSlopfabPlan).mockImplementation(async (request) => ({ ...plan,
    alignedFrames: request.continuationRelativePath ? (request.continuationFrom === "start" ? request.continuationOverlapFrames ?? 22 : request.continuationSourceFrames ?? 120) + Math.ceil(request.frames / 17) * 17 : plan.alignedFrames,
  }) as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
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

it("releases submitted snapshots after each generation while keeping completed results available", async () => {
  const { queue, first } = setup();
  const pending = (queue as unknown as { work: Map<string, unknown> }).work;
  for (let index = 0; index < 3; index++) {
    const [id] = queue.enqueue(first, [submission(first)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(index + 1));
    await finish(queue, id);
    await waitFor(() => expect(pending.size).toBe(0));
    const progress = vi.fn();
    await expect(queue.waitFor(id, new AbortController().signal, progress)).resolves.toMatchObject({ id, status: "completed" });
    expect(progress).toHaveBeenCalledOnce();
  }
  expect(queue.getSnapshot()).toHaveLength(3);
  const id = queue.getSnapshot()[0].id;
  vi.mocked(releaseRendered).mockClear();
  emit("slopfab-job", { jobId: id, state: "framesReady", detail: "Late result" });
  expect(releaseRendered).toHaveBeenCalledWith(id);
  expect(saveGeneratedScene).toHaveBeenCalledTimes(3);
});

it("resolves queued Long Shot dependencies after encoding and extends the joined archive", async () => {
  const { queue, first } = setup();
  first.update((config) => ({ ...config, generationJobs: Array.from({ length: 5 }, (_, i) => ({ ...config.generationJobs[0], id: String(i + 1), sceneType: "long-shot" as const })) }));
  vi.mocked(resolveSlopfabPlan).mockImplementation(async (request) => ({ ...plan, alignedFrames: request.latentBridge
    ? request.latentBridge.leftFrames! + bridgeGapFrames(request.frames) + request.latentBridge.rightFrames! : 124 }) as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
  const config = first.getSnapshot().config;
  const submissions = [0, 2, 1, 4, 3].map((i) => ({ job: config.generationJobs[i], snapshot: "queued",
    request: sceneGenerationRequest(config.generationJobs[i], config, first.record.folderPath, 8) }));
  const ids = queue.enqueue(first, submissions);
  // Later UI edits must not change the queued margin.
  first.update((current) => ({ ...current, generationJobs: current.generationJobs.map((job) => job.id === "2" ? { ...job, bridgeLeftMargin: 34 } : job) }));
  for (let index = 0; index < ids.length; index++) {
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(index + 1));
    await finish(queue, ids[index]);
  }
  const requests = vi.mocked(enqueueSlopfabGeneration).mock.calls.map(([request]) => request);
  expect(requests[2].latentBridge).toMatchObject({ leftRelativePath: `latents/${ids[0]}.safetensors`, rightRelativePath: `latents/${ids[1]}.safetensors`, leftFrames: 124, rightFrames: 124, leftMarginFrames: 17 });
  const bridgeGap = bridgeGapFrames(requests[2].frames);
  expect(requests[4].latentBridge).toMatchObject({ leftRelativePath: `latents/${ids[2]}.safetensors`, rightRelativePath: `latents/${ids[3]}.safetensors`, leftFrames: 248 + bridgeGap });
  const saved = parseProjectConfig(JSON.parse(JSON.stringify(first.getSnapshot().config)));
  expect(saved.assets.find((asset) => asset.id === "asset-4")?.sceneSegments?.map((part) => part.sceneId)).toEqual(["1", "2", "3", "4", "5"]);
  expect(saved.assets.find((asset) => asset.id === "asset-3")?.sceneSegments).toHaveLength(1);
  expect(JSON.parse(saved.generationJobs[1].generationSnapshot!).latentBridge.leftMarginFrames).toBe(17);
});

it.each(["failure", "reorder"])("refuses a queued Long Shot bridge after anchor %s", async (reason) => {
  const { queue, first } = setup();
  first.update((config) => ({ ...config, generationJobs: Array.from({ length: 3 }, (_, i) => ({ ...config.generationJobs[0], id: String(i + 1), sceneType: "long-shot" as const })) }));
  const config = first.getSnapshot().config;
  const ids = queue.enqueue(first, [0, 2, 1].map((i) => ({ job: config.generationJobs[i], snapshot: "queued",
    request: sceneGenerationRequest(config.generationJobs[i], config, first.record.folderPath, 8) })));
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  if (reason === "failure") emit("slopfab-job", { jobId: ids[0], state: "failed", detail: "Anchor failed" });
  else {
    first.update((current) => ({ ...current, generationJobs: [...current.generationJobs].reverse() }));
    await finish(queue, ids[0]);
  }
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
  await finish(queue, ids[1]);
  await waitFor(() => expect(queue.getSnapshot().find((item) => item.id === ids[2])?.status).toBe("failed"));
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2);
  expect(queue.getSnapshot().find((item) => item.id === ids[2])?.error).toMatch(reason === "failure" ? /Generate/ : /neighbors changed/);
});

it("releases a cancelled queued snapshot before the running job finishes", async () => {
  const { queue, first, second } = setup();
  const [running] = queue.enqueue(first, [submission(first)]);
  const [cancelled] = queue.enqueue(second, [submission(second)]);
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  await queue.cancel(cancelled);
  expect((queue as unknown as { work: Map<string, unknown> }).work.has(cancelled)).toBe(false);
  await expect(queue.waitFor(cancelled, new AbortController().signal)).resolves.toMatchObject({ status: "cancelled" });
  await finish(queue, running);
});

it.each([undefined, 17])("freezes audio steps %s independently of video steps through the queue", async (audioSteps) => {
  const { queue, first } = setup();
  const item = submission(first);
  item.request.audioSteps = audioSteps;
  queue.enqueue(first, [item]);
  item.request.audioSteps = 99;
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0]).toMatchObject({ steps: 12, audioSteps });
  expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0]).toMatchObject({ steps: 12, audioSteps });
  expect(queue.getSnapshot()[0].settings).toMatchObject({ steps: 12, audioSteps });
  await finish(queue, queue.getSnapshot()[0].id);
});

describe("agent scene generation", () => {
  const templates = () => {
    const chosen: GeneratorTemplate = { id: "chosen", name: "Chosen engine", modelType: "minimax-h3", defaultSteps: 8, attention: "exact",
      paths: { transformer: "C:/chosen.safetensors", textEncoder: "C:/text.safetensors", tokenizer: "C:/tokenizer", videoVae: "C:/video.safetensors", audioVae: "C:/audio.safetensors" } };
    saveGeneratorTemplateSettings({ defaultTemplateId: "default", templates: [
      { ...chosen, id: "default", name: "User selection", motionCache: true, paths: { ...chosen.paths, transformer: "C:/default.safetensors" } }, chosen,
    ] });
    return chosen;
  };

  it("uses the requested template without changing the default and waits through encoding and saving", async () => {
    const chosen = templates();
    const { queue, first, saved } = setup();
    let encoded!: (value: Awaited<ReturnType<typeof saveGeneratedScene>>) => void;
    vi.mocked(saveGeneratedScene).mockImplementationOnce(() => new Promise((resolve) => { encoded = resolve; }));
    const command = { op: "scene.generate" as const, scene: first.getSnapshot().config.generationJobs[0].id, template: chosen.id };
    const complete = vi.fn();
    const pending = generateAgentScene(queue, first, command, new AbortController().signal, vi.fn()).then((result) => { complete(result); return result; });
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const [request, config] = vi.mocked(enqueueSlopfabGeneration).mock.calls[0];
    expect(config.providerSettings.slopfab.options).toMatchObject({ transformer: "C:/chosen.safetensors", attention: "exact" });
    expect(config.providerSettings.slopfab.options.motionCache).toBeUndefined();
    expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("default");
    expect(first.getSnapshot().config.providerSettings.slopfab?.options.transformer).not.toBe("C:/chosen.safetensors");
    first.edit((current) => ({ ...current, name: "User edit during generation" }));
    emit("slopfab-job", { jobId: request.jobId, state: "framesReady" });
    expect(complete).not.toHaveBeenCalled();
    let persisted!: (record: ProjectRecord) => void;
    saved.mockImplementationOnce(() => new Promise((resolve) => { persisted = resolve; }));
    encoded({ relativePath: "media/generated/agent.mp4", bytes: 100, note: null });
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(complete).not.toHaveBeenCalled();
    persisted({ ...first.record, config: first.getSnapshot().config });
    await expect(pending).resolves.toMatchObject({ status: "completed", scene: command.scene, template: chosen.id, workId: request.jobId, outputRelativePath: "media/generated/agent.mp4" });
    expect(first.getSnapshot().config.name).toBe("User edit during generation");
  });

  it.each(["failed", "cancelled"] as const)("returns terminal %s state instead of waiting forever", async (status) => {
    templates();
    const { queue, first } = setup();
    const pending = generateAgentScene(queue, first, { op: "scene.generate", scene: first.getSnapshot().config.generationJobs[0].id, template: "chosen" }, new AbortController().signal, vi.fn());
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const id = queue.getSnapshot()[0].id;
    emit("slopfab-job", { jobId: id, state: status, detail: "Generation stopped" });
    await expect(pending).resolves.toMatchObject({ status, workId: id });
  });

  it("reports failed persistence separately from successfully rendered output", async () => {
    templates();
    const { queue, first, saved } = setup();
    const pending = generateAgentScene(queue, first, { op: "scene.generate", scene: first.getSnapshot().config.generationJobs[0].id, template: "chosen" }, new AbortController().signal, vi.fn());
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    saved.mockRejectedValueOnce(new Error("Disk full"));
    emit("slopfab-job", { jobId: queue.getSnapshot()[0].id, state: "framesReady" });
    await expect(pending).resolves.toMatchObject({ status: "failed", needsSave: true, error: "Disk full", outputRelativePath: "media/generated/result.mp4" });
  });

  it("cancels only its own queued generation when the agent is stopped", async () => {
    templates();
    const { queue, first, second } = setup();
    queue.enqueue(second, [submission(second)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const pending = generateAgentScene(queue, first, { op: "scene.generate", scene: first.getSnapshot().config.generationJobs[0].id, template: "chosen" }, controller.signal, vi.fn());
    controller.abort(new Error("Agent stopped"));
    await expect(pending).rejects.toThrow("Agent stopped");
    expect(queue.getSnapshot().map((item) => item.status)).toEqual(["generating", "cancelled"]);
    expect(cancelSlopfabGeneration).not.toHaveBeenCalled();
    await finish(queue, queue.getSnapshot()[0].id);
  });

  it("rejects unknown targets, incompatible templates and duplicate active scenes before enqueueing", async () => {
    const chosen = templates();
    const { queue, first } = setup();
    const scene = first.getSnapshot().config.generationJobs[0].id;
    const run = (sceneId: string, template: string) => generateAgentScene(queue, first, { op: "scene.generate", scene: sceneId, template }, new AbortController().signal, vi.fn());
    await expect(run("missing", "chosen")).rejects.toThrow("no longer exists");
    await expect(run(scene, "missing")).rejects.toThrow("no longer exists");
    saveGeneratorTemplateSettings({ defaultTemplateId: "chosen", templates: [{ ...chosen, mode: "animate" }] });
    await expect(run(scene, "chosen")).rejects.toThrow("prompt generator");
    expect(queue.getSnapshot()).toHaveLength(0);
    templates();
    queue.enqueue(first, [submission(first)]);
    await expect(run(scene, "chosen")).rejects.toThrow("already has generation in progress");
    expect(queue.getSnapshot()).toHaveLength(1);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    await finish(queue, queue.getSnapshot()[0].id);
  });
});

describe("image generation work", () => {
  const template: GeneratorTemplate = { id: "image-test", name: "MiniMax H3", modelType: "minimax-h3", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "C:/h3.safetensors" } };
  const imageProject = (): ProjectRecord => ({ folderPath: "C:/Image", config: createProjectConfig({ name: "Poster", prompt: "An ocean poster", generationType: "image", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 }) });
  it("generates an image at its own resolution and preserves the video generation canvas after reopening", async () => {
    const { queue, first } = setup();
    const original = first.getSnapshot().config;
    first.update((current) => ({ ...current, imageSettings: { resolution: "768p", aspectRatio: "1:1" } }));
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/poster.jpg", width: 768, height: 768 });
    queue.enqueueImage(first, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(request).toMatchObject({ stillImage: true, frames: 1, canvasWidth: 768, canvasHeight: 768 });
    await finish(queue, request.jobId);
    const reopened = parseProjectConfig(JSON.parse(JSON.stringify(first.getSnapshot().config)));
    expect(reopened.imageScene?.outputAssetId).toBeTruthy();
    expect(reopened.assets.some((asset) => asset.relativePath === "media/generated/poster.jpg")).toBe(true);
    expect(reopened.generationJobs).toEqual(original.generationJobs);
    expect(reopened.timeline).toEqual(original.timeline);
    expect(reopened.settings).toEqual(original.settings);
    expect(reopened.brief).toEqual(original.brief);
    expect(reopened.assets[0].imageGeneration).toMatchObject({ resolution: "768p", aspectRatio: "1:1" });
    expect(sceneGenerationRequest(reopened.generationJobs[0], reopened, "C:/First", 20))
      .toMatchObject({ canvasWidth: 736, canvasHeight: 416 });
  });
  it.each([-1, 0, Number.MAX_SAFE_INTEGER])("saves the exact submitted image seed without changing the authored seed (%s)", async (seed) => {
    const { queue, saved } = setup();
    const record = imageProject();
    record.config.imageScene!.seed = seed;
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/seed.jpg", width: 768, height: 768 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(Number.isSafeInteger(request.seed)).toBe(true);
    expect(request.seed).toBeGreaterThanOrEqual(0);
    if (seed !== -1) expect(request.seed).toBe(seed);
    expect(queue.getSnapshot()[0].settings.seed).toBe(request.seed);
    await finish(queue, request.jobId);
    const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
    expect(reopened.assets[0].imageGeneration).toMatchObject({ usedSeed: request.seed, scene: { seed } });
    expect(reopened.imageScene!.seed).toBe(seed);
    expect(saved.mock.calls.at(-1)![0].config.assets[0].imageGeneration!.usedSeed).toBe(request.seed);
  });
  it.each([false, true])("queues distinct images in order without changing the viewed image (draft: %s)", async (imageDraft) => {
    const { queue } = setup();
    const record = imageProject();
    record.config.assets = ["first", "second", "third"].map((id) => ({ id, kind: "image", name: id, imageDraft,
      relativePath: `media/${id}.jpg`, mimeType: "image/jpeg", createdAt: record.config.createdAt }));
    record.config.imageScene!.outputAssetId = "first";
    const session = queue.project(record);
    vi.mocked(invoke).mockImplementation(async (_command, args) => ({ relativePath: `media/${(args as { jobId: string }).jobId}.jpg`, width: 768, height: 768 }));
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    session.update((current) => restoreGeneratedImage(current, "second"));
    queue.enqueueImage(session, template);
    queue.enqueueImage(session, template);
    const [first, second] = queue.getSnapshot();
    expect(queue.getSnapshot()).toHaveLength(2);
    expect(second).toMatchObject({ imageAssetId: "second", status: "queued" });
    expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce();
    session.update((current) => restoreGeneratedImage(current, "third"));
    await finish(queue, first.id);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0].jobId).toBe(second.id);
    await finish(queue, second.id);
    const result = session.getSnapshot().config;
    expect(result.imageScene!.outputAssetId).toBe("third");
    expect(result.thumbnail).toBe("media/third.jpg");
    expect(result.assets.filter((asset) => [first, second].some((item) => asset.relativePath === `media/${item.id}.jpg`))).toHaveLength(2);
    // Generating again from a finished image adds to its family; a draft
    // becomes the image itself.
    expect([first, second].map((item) => result.assets.find((asset) => asset.relativePath === `media/${item.id}.jpg`)!.parentAssetId))
      .toEqual(imageDraft ? [undefined, undefined] : ["first", "second"]);
  });
  it("finishes regeneration in the current primary's family after promotion and undo", async () => {
    const { queue } = setup();
    const record = imageProject();
    record.config.assets = ["original", "chosen"].map((id) => ({ id, name: id, kind: "image", relativePath: `media/${id}.jpg`, mimeType: "image/jpeg",
      createdAt: record.config.createdAt, ...(id === "chosen" ? { parentAssetId: "original" } : {}) }));
    record.config.imageScene!.outputAssetId = "original";
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/result.jpg", width: 768, height: 768 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    session.edit((current) => ({ ...current, assets: makeImagePrimary(current.assets, "chosen") }));
    const work = queue.getSnapshot()[0];
    await finish(queue, work.id);
    expect(session.getSnapshot().config.assets.find((asset) => asset.id === work.id)?.parentAssetId).toBe("chosen");
    session.undo();
    expect(session.getSnapshot().config.assets.find((asset) => asset.id === "chosen")?.parentAssetId).toBe("original");
    expect(session.getSnapshot().config.assets.find((asset) => asset.id === work.id)?.parentAssetId).toBe("original");
    session.redo();
    expect(session.getSnapshot().config.assets.find((asset) => asset.id === work.id)?.parentAssetId).toBe("chosen");
  });

  it("submits whole-image and local edits with separate reference pictures and refmods", async () => {
    const { queue } = setup();
    const record = imageProject();
    let scene = createImageEditScene({ name: "Source", relativePath: "media/generated/source.jpg", width: 101, height: 77 });
    scene.nodes[0].description = "Make the light warmer like @[ref:Lighting]";
    scene = addImageNode(scene, "image-root", "object");
    Object.assign(scene.nodes[1], { name: "Edit", description: "Add a red @[ref:Balloon]" });
    record.config.imageScene = scene;
    record.config.references = ["Lighting", "Balloon"].map((name) => ({ id: name, name, kind: "image", description: name,
      relativePath: `references/${name}.png`, intendedUse: [], createdAt: record.config.createdAt,
      refmods: [{ id: name, name, relativePath: `references/${name}.safetensors`, strength: 0.75, copies: 2 }] }));
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/edited.png", width: 101, height: 77 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    const steps = request.imageEdit!.edits;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ x: 0, y: 0, width: 101, height: 77 });
    for (const [index, name] of ["Lighting", "Balloon"].entries()) {
      expect(steps[index].referencePaths).toEqual(["C:/Image/media/generated/source.jpg", `C:/Image/references/${name}.png`]);
      expect(steps[index].refmods).toEqual([{ path: `C:/Image/references/${name}.safetensors`, strength: 0.75, copies: 2 }]);
      expect(steps[index].prompt).toContain(`<Subject 1> is ${name}, providing appearance from <Picture 2>`);
    }
    expect(request.referencePaths).toEqual(steps[0].referencePaths);
    expect(request.refmods).toEqual(steps[0].refmods);
    expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0].imageEdit).toEqual(request.imageEdit);
    await finish(queue, request.jobId);
    const result = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
    expect(result.assets[0].imageGeneration!.references.map((reference) => reference.id)).toEqual(["Lighting", "Balloon"]);
    expect(result.imageScene!.nodes).toHaveLength(1);
    expect(result.imageScene!.nodes[0].description).toBe("");
  });
  it("submits ordered inpainting as one job, saves PNG, and leaves a clean edit root", async () => {
    const { queue } = setup();
    const record = imageProject();
    let scene = createImageEditScene({ name: "Source", relativePath: "media/generated/source.jpg", width: 101, height: 77 });
    for (const description of ["A red balloon like @[ref:balloon]", "A blue boat beside @[ref:balloon]"]) {
      scene = addImageNode(scene, "image-root", "object");
      scene.nodes.at(-1)!.description = description;
    }
    record.config.imageScene = scene;
    record.config.references = [{ id: "balloon", kind: "image", name: "Balloon", description: "Red satin", relativePath: "references/balloon.png", intendedUse: [], createdAt: record.config.createdAt }];
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/edited.png", width: 101, height: 77 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(request.referencePaths).toEqual(["C:/Image/media/generated/source.jpg", "C:/Image/references/balloon.png"]);
    expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0].referencePaths).toEqual(request.referencePaths);
    for (const edit of request.imageEdit!.edits) {
      expect(edit.prompt).toContain("<Picture 1> is the original source image");
      expect(edit.prompt).toContain("<Subject 1> is Balloon, providing appearance from <Picture 2>");
    }
    const draftId = session.getSnapshot().config.imageScene!.outputAssetId!;
    expect(session.getSnapshot().config.assets[0]).toMatchObject({ id: draftId, imageDraft: true });
    expect(request).toMatchObject({ stillImage: true, frames: 1, canvasWidth: 101, canvasHeight: 77, imageEdit: { sourceRelativePath: "media/generated/source.jpg", edits: [
      { prompt: expect.stringContaining("A red balloon"), x: 25, y: 19, width: 51, height: 39 },
      { prompt: expect.stringContaining("A blue boat"), x: 25, y: 19, width: 51, height: 39 },
    ] } });
    await finish(queue, request.jobId);
    expect(invoke).toHaveBeenCalledWith("save_generated_image", { folderPath: record.folderPath, jobId: request.jobId, format: "png" });
    const result = session.getSnapshot().config;
    expect(result.imageScene!.nodes).toHaveLength(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ id: draftId, imageDraft: false, relativePath: "media/generated/edited.png" });
    expect(result.imageScene!.outputAssetId).toBe(draftId);
    expect(result.imageScene).toMatchObject({ rootType: "image", sourceImage: { relativePath: "media/generated/edited.png", width: 101, height: 77 } });
    expect(result.assets[0]).toMatchObject({ mimeType: "image/png", imageGeneration: { scene, prompt: expect.stringContaining("Edit 2 (25, 19, 51, 39)") } });
    expect(restoreGeneratedImage(result, draftId).imageScene!.nodes).toHaveLength(1);
    expect(releaseRendered).toHaveBeenCalledWith(request.jobId);
  });
  it.each(["browse", "modify", "cancel"])("keeps editing versions available during generation: %s", async (action) => {
    const { queue } = setup();
    const record = imageProject();
    record.config.imageScene = addImageNode(createImageEditScene({ name: "Source", relativePath: "media/generated/source.jpg", width: 101, height: 77 }), "image-root", "object");
    record.config.imageScene.nodes[1].description = "A red balloon";
    record.config.assets = [{ id: "original", name: "Original", kind: "image", relativePath: "media/generated/source.jpg", width: 101, height: 77, mimeType: "image/jpeg", createdAt: record.config.createdAt }];
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/edited.png", width: 101, height: 77 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const id = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].jobId;
    const draftId = session.getSnapshot().config.imageScene!.outputAssetId!;
    if (action === "modify") session.update((config) => ({ ...config, imageScene: { ...config.imageScene!, nodes: config.imageScene!.nodes.map((node) => node.kind === "object" ? { ...node, description: "A blue balloon" } : node) } }));
    else session.update((config) => restoreGeneratedImage(config, "original"));
    if (action === "cancel") {
      await queue.cancel(id);
      emit("slopfab-job", { jobId: id, state: "cancelled", detail: "Cancelled" });
      expect(session.getSnapshot().config.assets.find((asset) => asset.id === draftId)?.imageDraft).toBe(true);
      session.update((config) => restoreGeneratedImage(config, draftId));
      expect(session.getSnapshot().config.imageScene!.nodes[1].description).toBe("A red balloon");
      expect(invoke).not.toHaveBeenCalledWith("save_generated_image", expect.anything());
      return;
    }
    await finish(queue, id);
    const config = session.getSnapshot().config;
    expect(config.assets.find((asset) => asset.id === draftId)).toMatchObject({ imageDraft: false, relativePath: "media/generated/edited.png" });
    if (action === "browse") {
      expect(config.imageScene!.outputAssetId).toBe("original");
      expect(config.assets).toHaveLength(2);
      session.update((current) => restoreGeneratedImage(current, draftId));
      expect(session.getSnapshot().config.imageScene!.nodes).toHaveLength(1);
    } else {
      expect(config.imageScene!.outputAssetId).not.toBe(draftId);
      expect(config.assets.filter((asset) => asset.imageDraft)).toHaveLength(1);
      expect(config.imageScene!.nodes[1].description).toBe("A blue balloon");
    }
    expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).assets).toEqual(config.assets);
  });
  it("replaces an empty-image draft with its generated JPEG", async () => {
    const { queue } = setup();
    const record = imageProject();
    record.config = createEmptyImage(record.config, template.id);
    record.config.imageScene!.nodes[0].description = "A forest";
    const draftId = record.config.imageScene!.outputAssetId;
    const session = queue.project(record);
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/forest.jpg", width: 768, height: 768 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(request.imageEdit).toBeUndefined();
    await finish(queue, request.jobId);
    const config = session.getSnapshot().config;
    expect(config.assets).toHaveLength(1);
    expect(config.assets[0]).toMatchObject({ id: draftId, imageDraft: false, relativePath: "media/generated/forest.jpg", mimeType: "image/jpeg" });
    expect(config.imageScene!.nodes[0].description).toBe("A forest");
    expect(config.imageScene!.outputAssetId).toBe(draftId);
  });
  it("forwards selected refmods to still-image planning and generation with their strength and copies", async () => {
    const { queue } = setup();
    const project = imageProject();
    project.config.references = [{ id: "person", kind: "text", name: "Person", description: "", intendedUse: [], createdAt: project.config.createdAt, refmods: [
      { id: "identity", name: "Identity", relativePath: "references/person.safetensors", strength: 0.75, copies: 2 },
      { id: "outfit", name: "Outfit", sourcePath: "D:/Refmods/outfit.safetensors", strength: 1, copies: 1 },
      { id: "disabled", name: "Disabled", sourcePath: "D:/Refmods/off.safetensors", strength: 0, copies: 3 },
    ] }];
    project.config.imageScene!.nodes[0].description += " with @[ref:person]";
    queue.enqueueImage(queue.project(project), template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(request).toMatchObject({ stillImage: true, frames: 1, referencePaths: [], refmods: [
      { path: "C:/Image/references/person.safetensors", strength: 0.75, copies: 2 },
      { path: "D:/Refmods/outfit.safetensors", strength: 1, copies: 1 },
    ] });
    expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0].refmods).toEqual(request.refmods);
    await queue.cancel(request.jobId);
  });
  it("submits the complete debug prompt with project look and ordered reference pictures", async () => {
    const { queue } = setup();
    const project = imageProject();
    project.config.settings.defaultLook = "watercolor";
    project.config.references = [{ id: "ocean", kind: "image", name: "Ocean", description: "Turquoise water", relativePath: "references/ocean.png", intendedUse: [], createdAt: project.config.createdAt }];
    project.config.imageScene!.nodes[0].description += " over @[ref:ocean]";
    const preview = compileImagePrompt(project.config).prompt;
    queue.enqueueImage(queue.project(project), template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const request = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
    expect(request.prompt).toBe(preview);
    expect(request.prompt).toContain("Watercolor visual style");
    expect(request.prompt).toContain("<Subject 1> is Ocean, providing appearance from <Picture 1>. Turquoise water.");
    expect(request.prompt).toMatch(/overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/);
    expect(request.referencePaths).toEqual(["C:/Image/references/ocean.png"]);
    await queue.cancel(request.jobId);
  });
  it("generates one native still, preserves ongoing edits, saves full-size JPEG, and releases frames", async () => {
    const { queue } = setup(); const session = queue.project(imageProject());
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/still.jpg", width: 768, height: 768 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    const [request, config] = vi.mocked(enqueueSlopfabGeneration).mock.calls[0];
    expect(request).toMatchObject({ stillImage: true, frames: 1, canvasWidth: 768, canvasHeight: 768 });
    expect(config.providerSettings.slopfab.options.transformer).toBe("C:/h3.safetensors");
    session.update((current) => ({ ...current, settings: { ...current.settings, resolution: "1344p", aspectRatio: "1:1" }, imageScene: { ...current.imageScene!, background: "Edited during generation" } }));
    await finish(queue, queue.getSnapshot().find((item) => item.kind === "image")!.id);
    expect(invoke).toHaveBeenCalledWith("save_generated_image", { folderPath: "C:/Image", jobId: request.jobId });
    const saved = session.getSnapshot().config;
    expect(saved.imageScene?.background).toBe("Edited during generation");
    expect(saved.imageScene?.outputAssetId).toBe(request.jobId);
    expect(saved.assets[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg", relativePath: "media/generated/still.jpg", width: 768, height: 768 });
    expect(saved.assets[0].imageGeneration).toMatchObject({ resolution: "768p", aspectRatio: "1:1", prompt: request.prompt, generatorTemplateId: template.id });
    expect(saved.assets[0].imageGeneration!.scene.background).not.toBe("Edited during generation");
    expect(saved.assets[0].imageGeneration!.scene.outputAssetId).toBeNull();
    expect(saved.settings.resolution).toBe("1344p");
    expect(saved.generationJobs).toHaveLength(0);
    expect(saveGeneratedScene).not.toHaveBeenCalled();
    expect(releaseRendered).toHaveBeenCalledWith(request.jobId);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(saved))).imageScene).toEqual(saved.imageScene);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(saved))).assets[0]).toMatchObject({ width: 768, height: 768 });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(saved))).assets[0].imageGeneration).toEqual(saved.assets[0].imageGeneration);
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    const nextRequest = vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0];
    expect(nextRequest).toMatchObject({ canvasWidth: 1344, canvasHeight: 1344 });
    await queue.cancel(nextRequest.jobId);
  });
  it("serializes image and video work and allows cancellation before native submission", async () => {
    const { queue, first } = setup(); const session = queue.project(imageProject());
    queue.enqueue(first, [submission(first)]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    queue.enqueueImage(session, template);
    const image = queue.getSnapshot().find((item) => item.kind === "image")!;
    expect(image.status).toBe("queued");
    await queue.cancel(image.id);
    expect(queue.getSnapshot().find((item) => item.id === image.id)?.status).toBe("cancelled");
    await finish(queue, queue.getSnapshot()[0].id);
    expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce();
    expect(session.getSnapshot().config.assets).toHaveLength(0);
  });
  it("retains the saved image for retry when writing the project fails", async () => {
    const { queue, saved } = setup(); const session = queue.project(imageProject());
    vi.mocked(invoke).mockResolvedValue({ relativePath: "media/generated/still.jpg", width: 768, height: 768 });
    queue.enqueueImage(session, template);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
    saved.mockRejectedValueOnce(new Error("Disk unavailable"));
    const id = queue.getSnapshot().find((item) => item.kind === "image")!.id;
    emit("slopfab-job", { jobId: id, state: "framesReady", detail: "Ready" });
    await waitFor(() => expect(queue.getSnapshot().find((item) => item.id === id)?.needsSave).toBe(true));
    expect(session.getSnapshot().config.imageScene?.outputAssetId).toBe(id);
    expect(releaseRendered).toHaveBeenCalledWith(id);
    await queue.retrySave(id);
    expect(queue.getSnapshot().find((item) => item.id === id)).toMatchObject({ status: "completed", needsSave: false });
  });
});

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

  it("keeps the captured source, overlap and edge after reordering, and uses freshly saved latents", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [config.generationJobs[0], { ...config.generationJobs[0], id: "linked", sceneType: "continue", continuationSceneId: config.generationJobs[0].id }] }));
    const source = submission(first);
    const linked = { ...submission(first), job: first.getSnapshot().config.generationJobs[1], request: { ...source.request, previousSceneId: source.job.id, continuationFrom: "start" as const, continuationOverlapFrames: 39, referencePaths: ["subject.png"] } };
    queue.enqueue(first, [source, linked]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    first.update((config) => ({ ...config, generationJobs: [...config.generationJobs].reverse() }));
    expect(saveSceneLastFrame).not.toHaveBeenCalled();
    await finish(queue, queue.getSnapshot()[0].id);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    expect(saveSceneLastFrame).not.toHaveBeenCalled();
    const latentPath = `latents/${queue.getSnapshot()[0].id}.safetensors`;
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0]).toMatchObject({ referencePaths: ["subject.png"], continuationRelativePath: latentPath,
      continuationFrom: "start", continuationOverlapFrames: 39, continuationSourceFrames: 120 });
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][2]).toBe("C:/First");
    await finish(queue, queue.getSnapshot()[1].id);
    const snapshot = JSON.parse(first.getSnapshot().config.generationJobs[0].generationSnapshot!);
    expect(snapshot.previousSceneId).toBe(source.job.id);
    expect(snapshot.continuationRelativePath).toBe(latentPath);
    expect(snapshot).toMatchObject({ continuationFrom: "start", continuationOverlapFrames: 39, continuationSourceFrames: 120 });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(first.getSnapshot().config))).generationJobs[0].latentRelativePath)
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

  it("saves the full End continuation and its exact scene ranges without replacing the original source", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [config.generationJobs[0], { ...config.generationJobs[0], id: "continued" }] }));
    const source = submission(first);
    vi.mocked(resolveSlopfabPlan).mockResolvedValueOnce({ ...plan, alignedFrames: 124 } as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
    vi.mocked(saveGeneratedScene).mockResolvedValueOnce({ relativePath: "media/source.mp4", durationMs: 5167, bytes: 10, hasAudio: true, note: null })
      .mockResolvedValueOnce({ relativePath: "media/joined.mp4", durationMs: 10125, bytes: 20, hasAudio: true, note: null });
    queue.enqueue(first, [source, { ...source, job: first.getSnapshot().config.generationJobs[1], request: {
      ...source.request, frames: 119, previousSceneId: source.job.id, continuationFrom: "end", continuationOverlapFrames: 39,
    } }]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    await finish(queue, queue.getSnapshot()[0].id);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2));
    const sourceLatents = `latents/${queue.getSnapshot()[0].id}.safetensors`;
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[1][0]).toMatchObject({ continuationRelativePath: sourceLatents, continuationFrom: "end", continuationOverlapFrames: 39 });
    await finish(queue, queue.getSnapshot()[1].id);
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(first.getSnapshot().config)));
    expect(saved.assets[0]).toMatchObject({ relativePath: "media/source.mp4", durationMs: 5167 });
    expect(saved.assets[1]).toMatchObject({ relativePath: "media/joined.mp4", durationMs: 10125, hasAudio: true, sceneSegments: [
      { sceneId: source.job.id, latentRelativePath: sourceLatents, startFrame: 0, frameCount: 124 },
      { sceneId: "continued", startFrame: 124, frameCount: 119 },
    ] });
  });

  it("fails a dependent scene if the previous generation fails, even when an older video exists", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, generationJobs: [{ ...config.generationJobs[0], outputRelativePath: "media/generated/old.mp4" }, { ...config.generationJobs[0], id: "linked", usePreviousSceneLastFrame: true }] }));
    const source = submission(first);
    queue.enqueue(first, [source, { ...source, job: first.getSnapshot().config.generationJobs[1], request: { ...source.request, previousSceneId: source.job.id } }]);
    await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
    emit("slopfab-job", { jobId: queue.getSnapshot()[0].id, state: "failed", detail: "Render failed" });
    await waitFor(() => expect(queue.getSnapshot()[1].status).toBe("failed"));
    expect(queue.getSnapshot()[1].error).toContain("selected source scene");
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
  it("exports a reference as a refmod after preparing its clip, without planning a generation", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, references: [{
      id: "ref-walk", kind: "video", name: "Walk", description: "A brisk walk", intendedUse: [], createdAt: config.createdAt,
      sourcePath: "D:/clips/walk.mp4", video: { startSeconds: 1, durationSeconds: 4, includeAudio: true },
      images: [{ id: "front", name: "front", relativePath: "references/front.png" }],
    }] }));
    let exported: Record<string, unknown> | undefined;
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
      if (command === "export_reference_refmod") exported = structuredClone(payload as Record<string, unknown>);
    });
    queue.exportReferenceRefmod(first, "ref-walk", "D:/out/walk.safetensors");
    const item = () => queue.getSnapshot().find((candidate) => candidate.kind === "refmod")!;
    expect(item()).toMatchObject({ title: "Refmod · Walk", sceneId: "ref-walk" });
    await waitFor(() => expect(item()).toMatchObject({ status: "completed", detail: "Refmod saved" }));
    expect(exported).toMatchObject({
      outputPath: "D:/out/walk.safetensors", name: "Walk", description: "A brisk walk",
      request: { jobId: item().id, referencePaths: ["C:/First/references/front.png"], referenceVideoIds: ["video-1"] },
    });
    expect(resolveSlopfabPlan).not.toHaveBeenCalled();
    expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
    await waitFor(() => expect(releaseReferenceVideos).toHaveBeenCalledWith(["video-1"]));
  });
  it("refuses refmod exports without media and reports a failed export", async () => {
    const { queue, first } = setup();
    first.update((config) => ({ ...config, references: [
      { id: "ref-text", kind: "text", name: "Mood", description: "Warm light", intendedUse: [], createdAt: config.createdAt },
      { id: "ref-face", kind: "text", name: "Face", description: "", intendedUse: [], createdAt: config.createdAt, images: [{ id: "front", name: "front", relativePath: "references/front.png" }] },
    ] }));
    expect(() => queue.exportReferenceRefmod(first, "ref-gone", "D:/out/gone.safetensors")).toThrow("no longer exists");
    expect(() => queue.exportReferenceRefmod(first, "ref-text", "D:/out/mood.safetensors")).toThrow("Add an image, video or sound");
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "export_reference_refmod") throw new Error("refmod export: required video/audio VAE path is missing");
    });
    queue.exportReferenceRefmod(first, "ref-face", "D:/out/face.safetensors");
    expect(() => queue.exportReferenceRefmod(first, "ref-face", "D:/out/again.safetensors")).toThrow("already being exported");
    const item = () => queue.getSnapshot().find((candidate) => candidate.kind === "refmod")!;
    await waitFor(() => expect(item()).toMatchObject({ status: "failed", detail: "Refmod export failed" }));
    expect(item().error).toContain("VAE path is missing");
    expect(prepareReferenceVideos).not.toHaveBeenCalled();
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

it.each([false, true])("freezes latent upscale %s and saves the selected output size", async (latentUpscale) => {
  const { queue, first } = setup();
  const item = submission(first);
  item.request.latentUpscale = latentUpscale;
  saveLocalOtherWeightPaths({ [LATENT_UPSCALER_URL]: "C:/weights/upscaler.safetensors" });
  queue.enqueue(first, [item]);
  item.request.latentUpscale = !latentUpscale;
  saveLocalOtherWeightPaths({ [LATENT_UPSCALER_URL]: "C:/changed.safetensors" });
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledOnce());
  expect(vi.mocked(resolveSlopfabPlan).mock.calls[0][0]).toMatchObject({ latentUpscale, canvasWidth: 736, canvasHeight: 416 });
  expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0]).toMatchObject({ latentUpscale, canvasWidth: 736, canvasHeight: 416 });
  expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][1].providerSettings.slopfab.options.latentUpscaler).toBe("C:/weights/upscaler.safetensors");
  const work = queue.getSnapshot()[0];
  expect(work.settings.latentUpscale).toBe(latentUpscale);
  emit("slopfab-progress", { jobId: work.id, stage: "upscaling", step: 1, totalSteps: 2 });
  expect(queue.getSnapshot()[0].detail).toBe("Upscaling video latents");
  await finish(queue, work.id);
  expect(vi.mocked(saveGeneratedScene).mock.calls[0][0].outputSize).toEqual(latentUpscale ? { width: 736, height: 416 } : undefined);
});
