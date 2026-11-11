// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { restoreGeneratedImage, saveImageDraft } from "./imageHistory";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseRendered } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "./project";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan } from "./runtime";
import { EMPTY_ENGINE_SETTINGS, type GeneratorTemplate } from "./settings";
import { WorkQueue } from "./workQueue";
import { CHARACTER_SHEET_HEIGHTS, CHARACTER_SHEET_VIEWS, characterSheetDimensions, compileCharacterSheet, type CharacterSheetViews } from "./characterSheet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(async () => true), saveGeneratedScene: vi.fn() }));
vi.mock("./runtime", () => ({ cancelSlopfabGeneration: vi.fn(), enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn() }));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
let stop: (() => void) | undefined;
const template: GeneratorTemplate = { id: "h3", name: "H3", modelType: "minimax-h3", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "C:/h3.safetensors" } };
const result = { relativePath: "media/generated/sheet.png", width: 2176, height: 1024 };
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

it.each(["minimax-h3", "h3_image"].flatMap((modelType) => [false, true].map((changed) => ({ modelType, changed }))))("uses a shared front-view outfit with square portrait and tall body views ($modelType, source changed: $changed)", async ({ modelType, changed }) => {
  const { queue, session } = setup();
  const original = structuredClone(session.getSnapshot().config);
  const selected = { ...template, modelType };
  const height = modelType === "h3_image" ? 1696 : 1024;
  const bodyWidth = modelType === "h3_image" ? 960 : 576;
  const saved = { ...result, width: height + 2 * bodyWidth, height };
  vi.mocked(invoke).mockImplementation(async (command) => command === "combine_character_sheet" ? saved : undefined);
  queue.enqueueCharacterSheet(session, selected, "source");
  queue.enqueueCharacterSheet(session, selected, "source");
  expect(queue.getSnapshot()).toHaveLength(1);
  const id = queue.getSnapshot()[0].id;
  const pending = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(pending.assets).toHaveLength(2);
  expect(pending.assets[1]).toMatchObject({ id, imageDraft: true, parentAssetId: "source", width: saved.width, height,
    imageGeneration: { template: { kind: "character-sheet", sourceId: "source", sourceName: "Hero", generatorName: template.name, prompt: "", height } } });
  expect(pending.assets[1].relativePath).toBeUndefined();
  expect(pending.imageScene!.outputAssetId).toBe(id);
  expect(queue.getSnapshot()[0].imageDraftId).toBe(id);
  expect(saveImageDraft(restoreGeneratedImage(pending, id)).assets).toEqual(pending.assets);
  let seed: number | undefined;
  const order = [1, 0, 3];
  expect(queue.getSnapshot()[0].settings.frames).toBe(3);
  for (let index = 0; index < 3; index++) {
    const request = await requestAt(index);
    seed ??= request.seed;
    const viewIndex = order[index];
    const referencePaths = ["C:/Character/media/hero.png", ...(index > 0 ? [`C:/Character/cache/character-sheets/${id}/1.png`] : [])];
    expect(request).toMatchObject({ stillImage: true, frames: 1, referencePaths, seed });
    expect(request.steps).toBe(modelType === "h3_image" ? 6 : original.imageScene!.steps);
    expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[index][1].providerSettings.slopfab?.options.modelType).toBe(modelType);
    expect(request.canvasWidth).toBe(viewIndex === 0 ? height : bodyWidth);
    expect(request.canvasHeight).toBe(height);
    if (index > 0) {
      expect(invoke).toHaveBeenCalledWith("save_character_sheet_view", { folderPath: "C:/Character", sheetId: id, jobId: `${id}-view-2`, index: 1 });
      expect(request.prompt).toContain("match the outfit in <Picture 2> from the requested angle");
    }
    expect(request.imageEdit).toBeUndefined();
    expect(request.prompt).toContain(["Waist-up front view", "Full body front view", "Full body side view", "Full body back view"][viewIndex]);
    expect(request.prompt).toContain("Keep the same character and visual style");
    expect(request.prompt).toContain("<Picture 1>");
    if (modelType === "h3_image") {
      expect(request.prompt).not.toMatch(/\[Shot 1\]|retention_analysis|overall_soundscape/);
      expect(request.prompt).toContain("the character (<Picture 1>");
    } else expect(request.prompt).toContain("<Subject 1> (appears in [Shot 1]): partially_preserved");
    if (viewIndex === 3) {
      expect(request.prompt).toContain("head and body facing away, face hidden");
    }
    expect(request.prompt).not.toContain("A still photograph");
    expect(session.getSnapshot().config.assets[0]).toEqual(original.assets[0]);
    expect(session.getSnapshot().config.assets[1]).toMatchObject({ id, imageDraft: true });
    if (changed && index === 0) session.update((current) => restoreGeneratedImage(current, "source"));
    emit("framesReady", request.jobId);
    if (index < 2) {
      await waitFor(() => expect(releaseRendered).toHaveBeenCalledWith(request.jobId));
      expect(invoke).toHaveBeenCalledWith("save_character_sheet_view", { folderPath: "C:/Character", sheetId: id, jobId: request.jobId, index: viewIndex });
    }
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  expect(invoke).toHaveBeenCalledWith("combine_character_sheet", { folderPath: "C:/Character", sheetId: id, indices: [0, 1, 3] });
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(3);
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(reopened.assets).toHaveLength(2);
  expect(reopened.assets[0]).toEqual(original.assets[0]);
  expect(reopened.assets[1]).toMatchObject({ id, name: "Character sheet - Hero", mimeType: "image/png", ...saved, imageGeneration: { usedSeed: seed } });
  expect(reopened.assets[1].parentAssetId).toBe("source");
  expect(reopened.assets[1].imageDraft).toBe(false);
  expect(reopened.assets[1].imageGeneration!.template).toEqual(pending.assets[1].imageGeneration!.template);
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

it.each([[0], [1], [2], [3], [0, 2, 3]].map((indices) => ({ indices })))("generates only selected views $indices without an implicit front view", async ({ indices }) => {
  const { queue, session } = setup();
  const views = Object.fromEntries(CHARACTER_SHEET_VIEWS.map((view, index) => [view.id, indices.includes(index)])) as CharacterSheetViews;
  queue.enqueueCharacterSheet(session, template, "source", { prompt: "Wear a red coat", views });
  const frozen = { ...views };
  views.front = !views.front;
  const id = queue.getSnapshot()[0].id;
  const pending = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(pending.assets[1].imageGeneration!.template).toMatchObject({ views: frozen });
  expect(pending.assets[1].width).toBe(indices.reduce((width, index) => width + (index === 0 ? 1024 : 576), 0));
  for (let index = 0; index < indices.length; index++) {
    const request = await requestAt(index);
    expect(request.jobId).toBe(`${id}-view-${indices[index] + 1}`);
    expect(request.referencePaths).toEqual(["C:/Character/media/hero.png"]);
    expect(request.prompt).not.toContain("<Picture 2>");
    expect(request.prompt).toContain("Wear a red coat");
    handlers.get("slopfab-progress")?.({ payload: { jobId: request.jobId, step: 1, totalSteps: 2 } });
    expect(queue.getSnapshot()[0].progress).toBeCloseTo((index + 0.5) / indices.length * 0.9);
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(indices.length);
  expect(invoke).toHaveBeenCalledWith("combine_character_sheet", { folderPath: "C:/Character", sheetId: id, indices });
});

it("rejects a sheet with every view disabled before queueing", () => {
  const { queue, session } = setup();
  expect(() => queue.enqueueCharacterSheet(session, template, "source", { prompt: "", views: { closeUp: false, front: false, side: false, back: false } })).toThrow("at least one");
  expect(queue.getSnapshot()).toHaveLength(0);
});

it.each(CHARACTER_SHEET_HEIGHTS.flatMap((height, index) => [
  { modelType: "minimax-h3", height, outputHeight: height, bodyWidth: height * 9 / 16 },
  { modelType: "h3_image", height, outputHeight: [832, 1696, 2560, 3424][index], bodyWidth: [480, 960, 1440, 1920][index] },
]))("generates and reopens all four $modelType views at preset $height", async ({ modelType, height, outputHeight, bodyWidth }) => {
  const { queue, session } = setup();
  const saved = { ...result, width: outputHeight + 3 * bodyWidth, height: outputHeight };
  vi.mocked(invoke).mockImplementation(async (command) => command === "combine_character_sheet" ? saved : undefined);
  const options = { prompt: "", height, views: { closeUp: true, front: true, side: true, back: true } };
  queue.enqueueCharacterSheet(session, { ...template, modelType }, "source", options);
  expect(queue.getSnapshot()[0].settings.canvasHeight).toBe(outputHeight);
  options.height = 512; // Queued dimensions must not follow later settings edits.
  for (let index = 0; index < 4; index++) {
    const request = await requestAt(index);
    expect(request.canvasHeight).toBe(outputHeight);
    expect(request.canvasWidth).toBe(index === 1 ? outputHeight : bodyWidth);
    expect(request.canvasWidth % 32).toBe(0);
    expect(request.canvasHeight % 32).toBe(0);
    expect(request.canvasWidth * request.canvasHeight).toBeLessThanOrEqual(20 * 1024 * 1024);
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(reopened.assets.at(-1)).toMatchObject({ ...saved, imageGeneration: { template: { height: outputHeight }, scene: { sourceImage: saved } } });
  expect(reopened.imageScene?.sourceImage).toMatchObject(saved);
  expect(session.getSnapshot().config.settings.resolution).toBe("768p");
});

it("rejects unsupported sheet heights before queueing generation", () => {
  const { queue, session } = setup();
  expect(() => queue.enqueueCharacterSheet(session, template, "source", { prompt: "", height: 8192 })).toThrow("supported character sheet height");
  expect(queue.getSnapshot()).toHaveLength(0);
});

it("keeps the required view after template instructions without repeating orientation details", () => {
  const { session } = setup();
  const config = session.getSnapshot().config;
  const snapshot = structuredClone(config);
  const views = compileCharacterSheet(config, config.assets[0], "cache/front.png", {
    prompt: "Wear a red coat with a chest badge, looking straight at the camera.",
    views: { closeUp: true, front: true, side: true, back: true },
  });
  const back = views[3].prompt;
  const retention = back.split("retention_analysis:\n")[1].split("\n\ndetailed_description:")[0];
  expect(retention).toContain("partially_preserved");
  expect(retention).toContain("use the requested outfit and view");
  expect(retention).not.toContain("fully_preserved");
  const afterTemplate = back.slice(back.indexOf("Template instructions:"));
  expect(afterTemplate).toContain("Required view: Full body back view, head and body facing away, face hidden");
  expect(views[2].prompt).toContain("head and body in left-facing profile");
  expect(config).toEqual(snapshot);
});

it.each([0, 12345, -1])("uses template steps and seed %s for every view and saved settings", async (seed) => {
  const { queue, session } = setup();
  const options = { prompt: "", steps: 37, seed };
  queue.enqueueCharacterSheet(session, template, "source", options);
  options.steps = 10; options.seed = 999;
  const usedSeed = queue.getSnapshot()[0].settings.seed;
  expect(Number.isSafeInteger(usedSeed)).toBe(true);
  expect(usedSeed).toBeGreaterThanOrEqual(0);
  if (seed !== -1) expect(usedSeed).toBe(seed);
  expect(queue.getSnapshot()[0].settings.steps).toBe(37);
  for (let index = 0; index < 3; index++) {
    const request = await requestAt(index);
    expect(request).toMatchObject({ steps: 37, seed: usedSeed });
    expect(session.getSnapshot().config.imageScene).toMatchObject({ outputAssetId: queue.getSnapshot()[0].id, steps: 37, seed });
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(reopened.assets.at(-1)?.imageGeneration).toMatchObject({ usedSeed, scene: { steps: 37, seed }, template: { steps: 37, seed } });
});

it.each([{ steps: 1 }, { steps: 1001 }, { steps: 2.5 }, { steps: NaN }, { seed: -2 }, { seed: 0.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 }])("rejects invalid template sampling settings %j", (settings) => {
  const { queue, session } = setup();
  expect(() => queue.enqueueCharacterSheet(session, template, "source", { prompt: "", ...settings })).toThrow();
  expect(queue.getSnapshot()).toHaveLength(0);
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
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
  expect(session.getSnapshot().config.assets).toHaveLength(2);
  expect(session.getSnapshot().config.assets[1]).toMatchObject({ id, imageDraft: true });
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(2);
  expect(invoke).not.toHaveBeenCalledWith("combine_character_sheet", expect.anything());
  expect(invoke).toHaveBeenCalledWith("discard_character_sheet_views", { folderPath: "C:/Character", sheetId: id });
  expect(releaseRendered).toHaveBeenCalledWith(second.jobId);
});

it("keeps the finished sheet available when project saving fails and retries without regenerating", async () => {
  const { queue, session, writer } = setup();
  queue.enqueueCharacterSheet(session, template, "source");
  const id = queue.getSnapshot()[0].id;
  for (let index = 0; index < 3; index++) {
    const request = await requestAt(index);
    if (index === 2) writer.mockRejectedValueOnce(new Error("Disk full"));
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", needsSave: true }));
  expect(session.getSnapshot().config.assets).toHaveLength(2);
  await queue.retrySave(id);
  expect(queue.getSnapshot()[0]).toMatchObject({ status: "completed", needsSave: false });
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(3);
});

it("rejects an empty source without queuing work", () => {
  const { queue, session } = setup();
  session.update((current) => ({ ...current, assets: current.assets.map((asset) => ({ ...asset, relativePath: null })) }));
  expect(() => queue.enqueueCharacterSheet(session, template, "source")).toThrow("saved file");
  expect(queue.getSnapshot()).toHaveLength(0);
});

it("conditions every view on prompt references and freezes the requested outfit at execution", async () => {
  const { queue, session } = setup();
  session.update((current) => ({ ...current, references: [{ id: "coat", name: "Red coat", kind: "image", description: "A red wool coat", relativePath: "references/coat.png", intendedUse: [], createdAt: current.createdAt,
    refmods: [{ id: "coat-style", name: "Coat style", relativePath: "references/coat.safetensors", strength: 0.75, copies: 1 }] }] }));
  const options = { prompt: "Soft studio lighting. Wear @[ref:coat] with black boots" };
  queue.enqueueCharacterSheet(session, template, "source", options);
  options.prompt = "Changed after execution";
  const id = queue.getSnapshot()[0].id;
  for (let index = 0; index < 3; index++) {
    const request = await requestAt(index);
    expect(request.referencePaths).toEqual(["C:/Character/media/hero.png", ...(index > 0 ? [`C:/Character/cache/character-sheets/${id}/1.png`] : []), "C:/Character/references/coat.png"]);
    expect(request.refmods).toEqual([{ path: "C:/Character/references/coat.safetensors", strength: 0.75, copies: 1 }]);
    expect(request.prompt).toContain("Template instructions: Soft studio lighting");
    expect(request.prompt).toContain("Wear <Subject 2> with black boots");
    expect(request.prompt).not.toContain("@[ref:");
    expect(request.prompt).not.toContain("Changed after execution");
    expect(request.prompt).toContain(`<Subject 2> is Red coat, providing appearance from <Picture ${index === 0 ? 2 : 3}>`);
    if (index === 0) expect(request.prompt).toContain("Keep the outfit from <Picture 1> unless the template instructions change it");
    emit("framesReady", request.jobId);
  }
  await waitFor(() => expect(queue.getSnapshot()[0].status).toBe("completed"));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
  expect(reopened.assets[1].imageGeneration!.references.map((reference) => reference.id)).toEqual(["coat"]);
  expect(reopened.assets[1].imageGeneration!.prompt).toContain("black boots");
});

it("rejects missing or excessive prompt references before starting a template", () => {
  const { queue, session } = setup();
  expect(() => queue.enqueueCharacterSheet(session, template, "source", { prompt: "@[ref:missing]" })).toThrow("no longer exists");
  session.update((current) => ({ ...current, references: Array.from({ length: 8 }, (_, index) => ({ id: `ref-${index}`, name: `Outfit ${index}`, kind: "image" as const, description: "", relativePath: `references/${index}.png`, intendedUse: [], createdAt: current.createdAt })) }));
  expect(() => queue.enqueueCharacterSheet(session, template, "source", { prompt: session.getSnapshot().config.references.map((reference) => `@[ref:${reference.id}]`).join(" ") })).toThrow("at most nine");
  expect(queue.getSnapshot()).toHaveLength(0);
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
});

it("validates H3 Image's reference limit including the source and generated front view, and rejects refmods", () => {
  const { queue, session } = setup();
  const h3 = { ...template, modelType: "h3_image" };
  session.update((current) => ({ ...current, references: Array.from({ length: 15 }, (_, index) => ({ id: `ref-${index}`, name: `Outfit ${index}`, kind: "image" as const, description: "", relativePath: `references/${index}.png`, intendedUse: [], createdAt: current.createdAt })) }));
  const config = session.getSnapshot().config;
  const prompt = config.references.map((reference) => `@[ref:${reference.id}]`).join(" ");
  const valid = compileCharacterSheet(config, config.assets[0], "cache/front.png", { prompt: config.references.slice(0, 14).map((reference) => `@[ref:${reference.id}]`).join(" ") }, h3.modelType);
  expect(valid[3].prompt).toContain("Outfit 13 (<Picture 16>)");
  expect(() => queue.enqueueCharacterSheet(session, h3, "source", { prompt })).toThrow("at most 16 pictures");
  session.update((current) => ({ ...current, references: [{ ...current.references[0], refmods: [{ id: "style", name: "Style", relativePath: "references/style.safetensors", strength: 1, copies: 1 }] }] }));
  expect(() => queue.enqueueCharacterSheet(session, h3, "source", { prompt: "@[ref:ref-0]" })).toThrow("does not support refmods");
  expect(queue.getSnapshot()).toHaveLength(0);
  expect(session.getSnapshot().config.assets).toHaveLength(1);
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
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
  for (let index = 0; index < 3; index++) emit("framesReady", (await requestAt(index)).jobId);
  await waitFor(() => expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", error: "Could not combine views" }));
  expect(session.getSnapshot().config.assets.map((asset) => asset.id)).toEqual(["source", id, "another", queue.getSnapshot()[1].id]);
  expect(session.getSnapshot().config.assets.filter((asset) => asset.imageDraft)).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith("discard_character_sheet_views", { folderPath: "C:/Character", sheetId: id });
  const next = await requestAt(3);
  await queue.cancel(queue.getSnapshot()[1].id);
  emit("cancelled", next.jobId);
  await waitFor(() => expect(queue.getSnapshot()[1].status).toBe("cancelled"));
});
