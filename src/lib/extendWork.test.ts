// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseRendered } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "./project";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan } from "./runtime";
import { EMPTY_ENGINE_SETTINGS, type GeneratorTemplate } from "./settings";
import { WorkQueue } from "./workQueue";
import type { ExtendOptions } from "./extendImage";
import { restoreGeneratedImage, saveImageDraft } from "./imageHistory";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(), saveGeneratedScene: vi.fn() }));
vi.mock("./runtime", () => ({ cancelSlopfabGeneration: vi.fn(), enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn() }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const template: GeneratorTemplate = { id: "h3", name: "H3", modelType: "minimax-h3", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "C:/h3.safetensors" } };
const options = (): ExtendOptions => ({ bounds: { x: -64, y: -32, width: 256, height: 160 }, prompt: "Continue the forest", steps: 25, seed: 0 });
const result = { relativePath: "media/generated/extended.png", width: 960, height: 576 };
let stop: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks(); handlers.clear();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => {}; }) as typeof listen);
  vi.mocked(resolveSlopfabPlan).mockImplementation(async (request) => ({ alignedFrames: 1, canvasWidth: request.canvasWidth, canvasHeight: request.canvasHeight } as Awaited<ReturnType<typeof resolveSlopfabPlan>>));
  vi.mocked(enqueueSlopfabGeneration).mockResolvedValue(undefined);
  vi.mocked(cancelSlopfabGeneration).mockResolvedValue(true);
  vi.mocked(releaseRendered).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => command === "save_extended_image" ? result : undefined);
});
afterEach(() => { stop?.(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
function setup() {
  const config = createProjectConfig({ name: "Extend", prompt: "Forest", generationType: "image", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 });
  config.assets = ["root", "source"].map((id) => ({ id, kind: "image", name: id, relativePath: `media/${id}.png`, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt, ...(id === "source" ? { parentAssetId: "root" } : {}) }));
  config.imageScene!.outputAssetId = "source";
  const writer = vi.fn(async (record: ProjectRecord) => record);
  const queue = new WorkQueue(writer); stop = queue.start();
  return { queue, session: queue.project({ folderPath: "C:/Extend", config }), writer };
}
const emit = (state: string, jobId: string) => handlers.get("slopfab-job")?.({ payload: { state, jobId, detail: state } });
async function submitted() {
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
  return vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0];
}

it.each([false, true])("extends a frozen source and saves a child with a durable snapshot (scene changed: %s)", async (changed) => {
  const { queue, session } = setup();
  const initial = structuredClone(session.getSnapshot().config);
  const input = options();
  queue.enqueueExtendImage(session, template, "source", input);
  queue.enqueueExtendImage(session, template, "source", input);
  input.bounds.width = 999; input.prompt = "Changed";
  expect(queue.getSnapshot()).toHaveLength(1);
  const pending = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  const entry = pending.assets.at(-1)!;
  expect(entry).toMatchObject({ id: queue.getSnapshot()[0].id, imageDraft: true, parentAssetId: "root", width: 960, height: 576,
    imageGeneration: { template: { kind: "extend", sourceId: "source", sourceName: "source", generatorName: "H3", ...options() } } });
  expect(entry.relativePath).toBeUndefined();
  expect(pending.imageScene!.outputAssetId).toBe(entry.id);
  expect(queue.getSnapshot()[0].imageDraftId).toBe(entry.id);
  expect(saveImageDraft(restoreGeneratedImage(pending, entry.id)).assets).toEqual(pending.assets);
  const request = await submitted();
  const { jobId } = request;
  expect(request).toMatchObject({ stillImage: true, frames: 1, seed: 0, steps: 25, canvasWidth: 960, canvasHeight: 576,
    imageEdit: { sourceRelativePath: `cache/extend-images/${jobId}/canvas.png` }, referencePaths: [] });
  expect(request.imageEdit!.edits).toEqual([{ x: 266, y: 131, width: 429, height: 314, invertMask: true, feather: 0, prompt: request.prompt }]);
  expect(request.prompt).toContain("Source scene's setting");
  expect(request.prompt).not.toContain("<Picture");
  expect(request.prompt).not.toContain("composition anchor");
  expect(request.prompt).toContain("Continue the forest");
  expect(request.prompt).not.toContain("Changed");
  expect(invoke).toHaveBeenCalledWith("prepare_extend_image", { folderPath: "C:/Extend", jobId, sourceId: "source", bounds: options().bounds, output: { width: 960, height: 576 } });
  if (changed) session.update((config) => restoreGeneratedImage(config, "source"));
  emit("framesReady", jobId);
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  const asset = reopened.assets.at(-1)!;
  expect(asset).toMatchObject({ id: jobId, name: "Extended - source", parentAssetId: "root", mimeType: "image/png", ...result,
    imageGeneration: { usedSeed: 0, scene: { steps: 25, seed: 0, sourceImage: { ...result } } } });
  expect(reopened.assets.slice(0, 2)).toEqual(initial.assets);
  expect(reopened.assets).toHaveLength(3);
  expect(asset.imageDraft).toBe(false);
  expect(asset.imageGeneration!.template).toEqual(entry.imageGeneration!.template);
  expect(reopened.imageScene!.outputAssetId).toBe(changed ? "source" : jobId);
  expect(JSON.stringify(asset)).not.toContain("cache/extend-images");
  expect(invoke).toHaveBeenCalledWith("save_extended_image", { folderPath: "C:/Extend", jobId });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("discard_extend_image", { folderPath: "C:/Extend", jobId }));
  expect(releaseRendered).toHaveBeenCalledWith(jobId);
});

it("passes prompt reference images and refmods to the extension", async () => {
  const { queue, session } = setup();
  session.update((config) => ({ ...config, references: [{ id: "trees", name: "Trees", kind: "image", description: "Tall pines", relativePath: "references/trees.png", intendedUse: [], createdAt: config.createdAt,
    refmods: [{ id: "forest", name: "Forest", relativePath: "references/forest.safetensors", strength: 1, copies: 1 }] }] }));
  queue.enqueueExtendImage(session, template, "source", { ...options(), prompt: "More @[ref:trees]" });
  const request = await submitted();
  expect(request.referencePaths).toEqual(["C:/Extend/references/trees.png"]);
  expect(request.prompt).toContain("<Subject 1> is Trees, providing appearance from <Picture 1>");
  expect(request.prompt).not.toContain("<Picture 2>");
  expect(request.refmods).toEqual([{ path: "C:/Extend/references/forest.safetensors", strength: 1, copies: 1 }]);
  expect(request.prompt).not.toContain("@[ref:");
  emit("framesReady", request.jobId);
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  expect(session.getSnapshot().config.assets.at(-1)!.imageGeneration!.references[0].id).toBe("trees");
});

it.each(["failed", "cancelled"])("does not publish a result after generation is %s", async (state) => {
  const { queue, session } = setup();
  queue.enqueueExtendImage(session, template, "source", options());
  const request = await submitted();
  if (state === "cancelled") { await queue.cancel(request.jobId); expect(cancelSlopfabGeneration).toHaveBeenCalledWith(request.jobId); }
  emit(state, request.jobId);
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe(state));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("discard_extend_image", { folderPath: "C:/Extend", jobId: request.jobId }));
  expect(session.getSnapshot().config.assets).toHaveLength(3);
  expect(session.getSnapshot().config.assets.at(-1)).toMatchObject({ id: request.jobId, imageDraft: true });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "save_extended_image")).toBe(false);
});

it("cleans preparation failures and lets the next extension proceed", async () => {
  const { queue, session } = setup();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Source missing"));
  queue.enqueueExtendImage(session, template, "source", options());
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("failed"));
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  queue.enqueueExtendImage(session, template, "source", options());
  const request = await submitted(); emit("framesReady", request.jobId);
  await waitFor(() => expect(queue.getSnapshot()[1].status).toBe("completed"));
});

it("retains the finished image when saving the project fails and retries without regenerating", async () => {
  const { queue, session, writer } = setup();
  queue.enqueueExtendImage(session, template, "source", options());
  const request = await submitted();
  writer.mockRejectedValueOnce(new Error("Disk full")); emit("framesReady", request.jobId);
  await waitFor(() => expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", needsSave: true }));
  expect(session.getSnapshot().config.assets).toHaveLength(3);
  await queue.retrySave(request.jobId);
  expect(queue.getSnapshot()[0]).toMatchObject({ status: "completed", needsSave: false });
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
});

it("rejects invalid bounds, seeds and missing references before queueing", () => {
  const { queue, session } = setup();
  for (const input of [{ ...options(), bounds: { x: 0, y: 0, width: 128, height: 96 } }, { ...options(), seed: -2 }, { ...options(), prompt: "@[ref:missing]" }]) {
    expect(() => queue.enqueueExtendImage(session, template, "source", input)).toThrow();
  }
  expect(queue.getSnapshot()).toHaveLength(0);
});
