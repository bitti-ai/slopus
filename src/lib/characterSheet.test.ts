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
import { characterSheetDimensions } from "./characterSheet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(async () => true), saveGeneratedScene: vi.fn() }));
vi.mock("./runtime", () => ({ cancelSlopfabGeneration: vi.fn(), enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn() }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
let stop: (() => void) | undefined;
const template: GeneratorTemplate = { id: "h3", name: "H3", modelType: "minimax-h3", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "C:/h3.safetensors" } };
const result = { relativePath: "media/generated/sheet.png", width: 2752, height: 1024 };
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks(); handlers.clear();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => {}; }) as typeof listen);
  vi.mocked(resolveSlopfabPlan).mockImplementation(async (request) => ({ alignedFrames: 1, canvasWidth: request.canvasWidth, canvasHeight: request.canvasHeight } as Awaited<ReturnType<typeof resolveSlopfabPlan>>));
  vi.mocked(enqueueSlopfabGeneration).mockResolvedValue(undefined);
  vi.mocked(cancelSlopfabGeneration).mockResolvedValue(true);
  vi.mocked(releaseRendered).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async (command) => command === "combine_character_sheet" ? result : undefined);
});
afterEach(() => { stop?.(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
function setup() {
  const config = createProjectConfig({ name: "Character", prompt: "A character", generationType: "image", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 });
  config.assets = [{ id: "source", kind: "image", name: "Hero", relativePath: "media/hero.png", mimeType: "image/png", createdAt: config.createdAt }];
  config.imageScene!.outputAssetId = "source";
  const writer = vi.fn(async (record: ProjectRecord) => record);
  const queue = new WorkQueue(writer);
  stop = queue.start();
  const session = queue.project({ folderPath: "C:/Character", config });
  return { queue, session, writer };
}
const emit = (state: string, jobId: string, detail = state) => handlers.get("slopfab-job")?.({ payload: { state, jobId, detail } });
async function requestAt(index: number) {
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(index + 1));
  return vi.mocked(enqueueSlopfabGeneration).mock.calls[index][0];
}

it.each([false, true])("uses a shared front-view outfit with square portrait and tall body views (source changed: %s)", async (changed) => {
  const { queue, session } = setup();
  const original = structuredClone(session.getSnapshot().config);
  queue.enqueueCharacterSheet(session, template, "source");
  queue.enqueueCharacterSheet(session, template, "source");
  expect(queue.getSnapshot()).toHaveLength(1);
  const id = queue.getSnapshot()[0].id;
  let seed: number | undefined;
  const order = [1, 0, 2, 3];
  for (let index = 0; index < 4; index++) {
    const request = await requestAt(index);
    seed ??= request.seed;
    const viewIndex = order[index];
    const referencePaths = ["C:/Character/media/hero.png", ...(index > 0 ? [`C:/Character/cache/character-sheets/${id}/1.png`] : [])];
    expect(request).toMatchObject({ stillImage: true, frames: 1, referencePaths, seed });
    expect(request.canvasWidth / request.canvasHeight).toBe(viewIndex === 0 ? 1 : 9 / 16);
    expect(request.canvasHeight).toBe(1024);
    if (index > 0) {
      expect(invoke).toHaveBeenCalledWith("save_character_sheet_view", { folderPath: "C:/Character", sheetId: id, jobId: `${id}-view-2`, index: 1 });
      expect(request.prompt).toContain("<Picture 2> is the full body front view of this same character and the fixed wardrobe reference");
      expect(request.prompt).toContain("Do not add, remove, replace, restyle or recolor any clothing");
    }
    expect(request.imageEdit).toBeUndefined();
    expect(request.prompt).toContain(["frontal close-up portrait", "full body front view", "full body side view", "full body back view"][viewIndex]);
    expect(request.prompt).toContain("clothing, footwear, accessories");
    expect(request.prompt).toContain("<Picture 1>");
    expect(request.prompt).not.toContain("A still photograph");
    expect(session.getSnapshot().config.assets).toEqual(original.assets);
    if (changed && index === 0) session.update((current) => ({ ...current, imageScene: { ...current.imageScene!, nodes: current.imageScene!.nodes.map((node) => ({ ...node, description: "Changed during generation" })) } }));
    emit("framesReady", request.jobId);
    if (index < 3) {
      await waitFor(() => expect(releaseRendered).toHaveBeenCalledWith(request.jobId));
      expect(invoke).toHaveBeenCalledWith("save_character_sheet_view", { folderPath: "C:/Character", sheetId: id, jobId: request.jobId, index: viewIndex });
    }
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(reopened.assets).toHaveLength(2);
  expect(reopened.assets[0]).toEqual(original.assets[0]);
  expect(reopened.assets[1]).toMatchObject({ id, name: "Character sheet - Hero", mimeType: "image/png", ...result, imageGeneration: { usedSeed: seed } });
  expect(reopened.assets[1].parentAssetId).toBeUndefined();
  expect(reopened.imageScene!.outputAssetId).toBe(changed ? "source" : id);
  expect(reopened.generationJobs).toEqual(original.generationJobs);
  expect(reopened.timeline).toEqual(original.timeline);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("discard_character_sheet_views", { folderPath: "C:/Character", sheetId: id }));
});

it.each(["416p", "768p", "1080p", "2048p", "4k"] as const)("keeps exact aspect ratios and aligned dimensions at %s", (resolution) => {
  const sizes = characterSheetDimensions(resolution);
  expect(sizes.map(({ width, height }) => width / height)).toEqual([1, 9 / 16, 9 / 16, 9 / 16]);
  expect(new Set(sizes.map(({ height }) => height)).size).toBe(1);
  expect(sizes.reduce((sum, { width }) => sum + width, 0)).toBeLessThanOrEqual(8192);
  for (const { width, height } of sizes) { expect(width % 32).toBe(0); expect(height % 32).toBe(0); }
});

it.each(["cancelled", "failed"])("discards partial views after the second render is %s", async (state) => {
  const { queue, session } = setup();
  queue.enqueueCharacterSheet(session, template, "source");
  const id = queue.getSnapshot()[0].id;
  emit("framesReady", (await requestAt(0)).jobId);
  const second = await requestAt(1);
  if (state === "cancelled") {
    await queue.cancel(id);
    expect(cancelSlopfabGeneration).toHaveBeenCalledWith(second.jobId);
  }
  emit(state, second.jobId, "Stopped second view");
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe(state));
  expect(session.getSnapshot().config.assets).toHaveLength(1);
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2);
  expect(invoke).not.toHaveBeenCalledWith("combine_character_sheet", expect.anything());
  expect(invoke).toHaveBeenCalledWith("discard_character_sheet_views", { folderPath: "C:/Character", sheetId: id });
  expect(releaseRendered).toHaveBeenCalledWith(second.jobId);
});

it("keeps the finished sheet available when project saving fails and retries without regenerating", async () => {
  const { queue, session, writer } = setup();
  queue.enqueueCharacterSheet(session, template, "source");
  const id = queue.getSnapshot()[0].id;
  for (let index = 0; index < 4; index++) {
    const request = await requestAt(index);
    if (index === 3) writer.mockRejectedValueOnce(new Error("Disk full"));
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", needsSave: true }));
  expect(session.getSnapshot().config.assets).toHaveLength(2);
  await queue.retrySave(id);
  expect(queue.getSnapshot()[0]).toMatchObject({ status: "completed", needsSave: false });
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(4);
});

it("rejects an empty source without queuing work", () => {
  const { queue, session } = setup();
  session.update((current) => ({ ...current, assets: current.assets.map((asset) => ({ ...asset, relativePath: null })) }));
  expect(() => queue.enqueueCharacterSheet(session, template, "source")).toThrow("saved file");
  expect(queue.getSnapshot()).toHaveLength(0);
});

it("does not publish a partial result when combining fails and lets the next job run", async () => {
  const { queue, session } = setup();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "combine_character_sheet") throw new Error("Could not combine views");
  });
  queue.enqueueCharacterSheet(session, template, "source");
  const id = queue.getSnapshot()[0].id;
  session.update((current) => ({ ...current, assets: [...current.assets, { ...current.assets[0], id: "another", name: "Another" }] }));
  queue.enqueueCharacterSheet(session, template, "another");
  for (let index = 0; index < 4; index++) emit("framesReady", (await requestAt(index)).jobId);
  await waitFor(() => expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", error: "Could not combine views" }));
  expect(session.getSnapshot().config.assets.map((asset) => asset.id)).toEqual(["source", "another"]);
  expect(invoke).toHaveBeenCalledWith("discard_character_sheet_views", { folderPath: "C:/Character", sheetId: id });
  const next = await requestAt(4);
  await queue.cancel(queue.getSnapshot()[1].id);
  emit("cancelled", next.jobId);
  await waitFor(() => expect(queue.getSnapshot()[1].status).toBe("cancelled"));
});
