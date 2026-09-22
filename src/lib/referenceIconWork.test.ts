// @vitest-environment jsdom
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, referenceImages, type ProjectRecord, type ProjectReference } from "./project";
import { REFERENCE_PRESETS } from "./reference-presets";
import { referenceIconPrompt } from "./referenceIcons";
import { loadReferenceIconAutomation, saveReferenceIconAutomation, saveReferenceIconGeneratorId } from "./referenceIconSettings";
import { createGeneratorTemplate, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "./settings";
import { saveLoras } from "./loras";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan, saveReferenceIcon } from "./runtime";
import { WorkQueue } from "./workQueue";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(async () => true), saveGeneratedScene: vi.fn() }));
vi.mock("./timelineThumbnails", () => ({ purgeTimelineThumbnails: vi.fn(async () => undefined) }));
vi.mock("./runtime", () => ({ enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn(), cancelSlopfabGeneration: vi.fn(), saveReferenceIcon: vi.fn() }));
const handlers = new Map<string, (event: { payload: any }) => void>();
let stop: () => void;
const reference = (id: string, type: "character" | "animal" | "product" | "location" | "style" = "character"): ProjectReference => ({
  id, kind: "text", name: id, description: `User description for ${id}.`, intendedUse: [type], createdAt: "2026-09-07T00:00:00.000Z",
});
const project = (name: string, references: ProjectReference[] = []): ProjectRecord => ({ folderPath: `C:/${name}`, config: {
  ...createProjectConfig({ name, prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 }), references,
} });
const setup = (references: ProjectReference[] = []) => {
  const saved = vi.fn(async (_record: ProjectRecord) => undefined);
  const queue = new WorkQueue(saved);
  stop = queue.start();
  const session = queue.project(project("First", references));
  return { queue, session, saved };
};
const flush = () => vi.advanceTimersByTimeAsync(0);
const finish = async (id: string, state = "framesReady", detail = "Ready") => {
  handlers.get("slopfab-job")?.({ payload: { jobId: id, state, detail } });
  await flush();
};
const requests = () => vi.mocked(enqueueSlopfabGeneration).mock.calls.map(([request]) => request);
const video = (queue: WorkQueue, session: ReturnType<WorkQueue["project"]>) => queue.enqueue(session, [{
  job: session.getSnapshot().config.generationJobs[0], snapshot: "test", request: {
    jobId: "video", prompt: "Video", frames: 120, steps: 12, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [],
  },
}]);

const originalPresetIcons = new Map(REFERENCE_PRESETS.map((preset) => [preset.id, preset.icon]));

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); handlers.clear();
  saveReferenceIconAutomation("enabled");
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: any }) => void) => { handlers.set(name, handler); return () => { handlers.delete(name); }; }) as typeof listen);
  vi.mocked(enqueueSlopfabGeneration).mockResolvedValue(undefined);
  vi.mocked(resolveSlopfabPlan).mockResolvedValue({ alignedFrames: 120, canvasWidth: 736, canvasHeight: 416 } as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
  vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/scene.mp4", bytes: 10, note: null });
  vi.mocked(saveReferenceIcon).mockImplementation(async (_folder, id) => `references/icons/${id}.jpg`);
  vi.mocked(cancelSlopfabGeneration).mockResolvedValue(true);
});
afterEach(() => {
  REFERENCE_PRESETS.forEach((preset) => { preset.icon = originalPresetIcons.get(preset.id); }); stop?.(); vi.restoreAllMocks(); vi.useRealTimers(); delete (window as any).__TAURI_INTERNALS__; });

it("renders a refmod icon without a description and rejects a result after its settings change", async () => {
  const ref = { ...reference("latent"), description: "", refmods: [{ id: "r", name: "Person", sourcePath: "D:/person.safetensors", strength: 0.7, copies: 2 }] };
  const { queue, session } = setup([ref]);
  queue.regenerateReferenceIcon(session, "latent");
  await flush();
  expect(requests()[0]).toMatchObject({ stillImage: true, referencePaths: [], refmods: [{ path: "D:/person.safetensors", strength: 0.7, copies: 2 }] });
  session.update((config) => ({ ...config, references: config.references.map((entry) => ({ ...entry, refmods: entry.refmods!.map((latent) => ({ ...latent, copies: 3 })) })) }));
  await finish(requests()[0].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBeUndefined();
  queue.regenerateReferenceIcon(session, "latent");
  await flush();
  expect(requests()[1].refmods![0].copies).toBe(3);
  await finish(requests()[1].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toContain("references/icons/");
});

it("renders automatic icons with the chosen template without changing the video generator", async () => {
  const videoTemplate = createGeneratorTemplate("Video"), icons = createGeneratorTemplate("Icons");
  icons.paths.transformer = "D:/icons.safetensors";
  icons.defaultSteps = 12;
  icons.attention = "exact";
  icons.motionCache = true;
  saveLoras([{ id: "style", name: "Style", path: "D:/style.safetensors", stepOverride: 6 }]);
  icons.loras = [{ loraId: "style", enabled: true, strength: 0.9 }];
  saveGeneratorTemplateSettings({ templates: [videoTemplate, icons], defaultTemplateId: videoTemplate.id, catalogVersion: 9 });
  saveReferenceIconGeneratorId(icons.id);
  const { session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  const [request, runtime] = vi.mocked(enqueueSlopfabGeneration).mock.calls[0];
  expect(request).toMatchObject({ stillImage: true, steps: 6 });
  expect(runtime.providerSettings.slopfab.options).toMatchObject({ transformer: "D:/icons.safetensors", attention: "exact", motionCache: true, stepOverride: 6 });
  expect(JSON.parse(runtime.providerSettings.slopfab.options.loras as string)).toEqual([{ path: "D:/style.safetensors", strength: 0.9 }]);
  expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe(videoTemplate.id);
  expect(session.getSnapshot().config.providerSettings).toEqual({});
  await finish(request.jobId);
});

it("waits for batch confirmation without blocking video generation", async () => {
  saveReferenceIconAutomation("ask");
  const { queue, session } = setup([reference("hero"), reference("place", "location")]);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  expect(queue.getIconConfirmationCount()).toBe(2);
  video(queue, session);
  await flush();
  expect(requests()).toHaveLength(1);
  expect(requests()[0].stillImage).not.toBe(true);
  queue.answerIconConfirmation(true, false);
  expect(queue.getIconConfirmationCount()).toBe(0);
  await finish(requests()[0].jobId);
  expect(requests()[1].stillImage).toBe(true);
  await finish(requests()[1].jobId);
  expect(requests()[2].stillImage).toBe(true);
  await finish(requests()[2].jobId);
  expect(loadReferenceIconAutomation()).toBe("ask");
});

it("cancels a pending batch without repeatedly asking for the same icons", async () => {
  saveReferenceIconAutomation("ask");
  const { queue, session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  queue.answerIconConfirmation(false, false);
  session.update((current) => ({ ...current, references: [...current.references] }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  expect(queue.getIconConfirmationCount()).toBe(0);
  expect(loadReferenceIconAutomation()).toBe("ask");
  session.update((current) => ({ ...current, references: [...current.references, reference("new")] }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(queue.getIconConfirmationCount()).toBe(1);
});

it("remembers Start and automatically generates subsequent references", async () => {
  saveReferenceIconAutomation("ask");
  const { queue, session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  queue.answerIconConfirmation(true, true);
  await flush();
  expect(loadReferenceIconAutomation()).toBe("enabled");
  await finish(requests()[0].jobId);
  session.update((current) => ({ ...current, references: [...current.references, reference("new")] }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(queue.getIconConfirmationCount()).toBe(0);
  expect(requests()).toHaveLength(2);
  await finish(requests()[1].jobId);
});

it("remembers Cancel as disabled but still allows manual icon generation", async () => {
  saveReferenceIconAutomation("ask");
  const { queue, session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  queue.answerIconConfirmation(false, true);
  expect(loadReferenceIconAutomation()).toBe("disabled");
  session.update((current) => ({ ...current, references: [...current.references, reference("new")] }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(queue.getIconConfirmationCount()).toBe(0);
  expect(requests()).toHaveLength(0);
  queue.regenerateReferenceIcon(session, "hero");
  await flush();
  expect(requests()).toHaveLength(1);
  await finish(requests()[0].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toMatch(/\.jpg$/);
});

it("reacts immediately to disabling and re-enabling automatic generation", async () => {
  saveReferenceIconAutomation("disabled");
  const { queue } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  expect(queue.getIconConfirmationCount()).toBe(0);
  saveReferenceIconAutomation("ask");
  expect(queue.getIconConfirmationCount()).toBe(1);
  saveReferenceIconAutomation("disabled");
  expect(queue.getIconConfirmationCount()).toBe(0);
  await flush();
  expect(requests()).toHaveLength(0);
  saveReferenceIconAutomation("ask");
  expect(queue.getIconConfirmationCount()).toBe(1);
});

it("disabling automation stops waiting icons but lets the active icon save", async () => {
  const { session } = setup([reference("hero"), reference("place")]);
  await vi.advanceTimersByTimeAsync(1001);
  saveReferenceIconAutomation("disabled");
  await finish(requests()[0].jobId);
  expect(requests()).toHaveLength(1);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toMatch(/\.jpg$/);
  expect(session.getSnapshot().config.references[1].iconRelativePath).toBeUndefined();
});

it("checks automation again after waiting for the project to save", async () => {
  const { saved } = setup([reference("hero")]);
  let finishSave!: () => void;
  saved.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishSave = () => resolve(undefined); }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  saveReferenceIconAutomation("disabled");
  finishSave();
  await flush();
  expect(requests()).toHaveLength(0);
});

it("groups icons across projects and gives waiting videos priority between icons", async () => {
  const { queue, session } = setup([reference("hero")]);
  const second = queue.project(project("Second", [reference("place", "location")]));
  video(queue, session);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(1);
  expect(queue.getSnapshot().filter((item) => item.kind === "reference-icons")).toHaveLength(1);
  expect(queue.hasActiveProject(second.record)).toBe(true);
  await finish(requests()[0].jobId);
  expect(requests()[1]).toMatchObject({ stillImage: true, frames: 1, canvasWidth: 768, canvasHeight: 768, steps: 20 });
  expect(queue.getSnapshot().find((item) => item.kind === "reference-icons")?.settings).toMatchObject({ canvasWidth: 768, canvasHeight: 768, steps: 20 });
  expect(requests()[1].prompt).toContain("User description for hero.");
  video(queue, second);
  await finish(requests()[1].jobId);
  expect(requests()[2].stillImage).not.toBe(true);
  await finish(requests()[2].jobId);
  expect(requests()[3].stillImage).toBe(true);
  await finish(requests()[3].jobId);
  expect(queue.getSnapshot().find((item) => item.kind === "reference-icons")).toMatchObject({ status: "completed", detail: "2/2 icons saved" });
  expect(parseProjectConfig(session.getSnapshot().config).references[0].iconRelativePath).toMatch(/\.jpg$/);
  expect(referenceImages(session.getSnapshot().config.references[0])).toEqual([]);
  expect(saveReferenceIcon).toHaveBeenLastCalledWith("C:/Second", requests()[3].jobId);
  expect(releaseRendered).toHaveBeenCalledWith(requests()[3].jobId);
});

it("waits for text and skips references that already have artwork", async () => {
  const preset = REFERENCE_PRESETS[0];
  preset.icon = "/test-preset.jpg";
  const { session } = setup([
    { ...reference("blank"), description: "" },
    { ...reference("existing"), iconRelativePath: "references/icons/existing.jpg" },
    { ...reference("photo"), images: [{ id: "photo", name: "Photo", relativePath: "references/photo.jpg" }] },
    { ...reference("preset", preset.type), description: preset.prompt },
  ]);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  session.update((current) => ({ ...current, references: current.references.map((ref) => ref.id === "blank" ? { ...ref, description: "A red toy car." } : ref) }));
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(1);
  expect(requests()[0].prompt).toContain("A red toy car.");
  await finish(requests()[0].jobId);
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests()).toHaveLength(1);
});

it("discards stale results and uses the updated prompt without overwriting edits", async () => {
  const { session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  session.update((current) => ({ ...current, name: "Renamed project", references: [{ ...current.references[0], description: "Changed user prompt." }] }));
  await finish(requests()[0].jobId);
  expect(saveReferenceIcon).not.toHaveBeenCalled();
  expect(requests()[1].prompt).toContain("Changed user prompt.");
  await finish(requests()[1].jobId);
  expect(session.getSnapshot().config.name).toBe("Renamed project");
  expect(session.getSnapshot().config.references[0].description).toBe("Changed user prompt.");
});

it("does not attach results to a deleted reference", async () => {
  const { session } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  session.update((current) => ({ ...current, references: [] }));
  await finish(requests()[0].jobId);
  expect(saveReferenceIcon).not.toHaveBeenCalled();
  expect(session.getSnapshot().config.references).toHaveLength(0);
});

it("saves duplicate native completion events only once and waits before the next icon", async () => {
  let written!: (path: string) => void;
  vi.mocked(saveReferenceIcon).mockImplementationOnce(() => new Promise((resolve) => { written = resolve; }));
  const { session } = setup([reference("hero"), reference("place", "location")]);
  await vi.advanceTimersByTimeAsync(1001);
  const id = requests()[0].jobId;
  await finish(id);
  await finish(id);
  expect(saveReferenceIcon).toHaveBeenCalledTimes(1);
  expect(requests()).toHaveLength(1);
  written("references/icons/hero.jpg");
  await flush();
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe("references/icons/hero.jpg");
  expect(requests()).toHaveLength(2);
  await finish(requests()[1].jobId);
});

it("cancels an icon even if its native enqueue acknowledgement arrives late", async () => {
  let accepted!: () => void;
  vi.mocked(enqueueSlopfabGeneration).mockImplementationOnce(() => new Promise((resolve) => { accepted = resolve; }));
  const { queue } = setup([reference("hero")]);
  await vi.advanceTimersByTimeAsync(1001);
  await queue.cancel(queue.getSnapshot()[0].id);
  expect(cancelSlopfabGeneration).not.toHaveBeenCalled();
  accepted(); await flush();
  expect(cancelSlopfabGeneration).toHaveBeenCalledWith(requests()[0].jobId);
  await finish(requests()[0].jobId, "cancelled", "Cancelled");
  expect(queue.getSnapshot()[0].status).toBe("cancelled");
});

it("cancels the entire icon batch and does not automatically requeue cancelled work", async () => {
  const { queue } = setup([reference("hero"), reference("place", "location")]);
  await vi.advanceTimersByTimeAsync(1001);
  await queue.cancel(queue.getSnapshot()[0].id);
  expect(cancelSlopfabGeneration).toHaveBeenCalledWith(requests()[0].jobId);
  await finish(requests()[0].jobId, "cancelled", "Cancelled");
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests()).toHaveLength(1);
  expect(queue.getSnapshot()[0].status).toBe("cancelled");
});

it("continues after a failed icon and retries persistence without generating again", async () => {
  const { queue, saved } = setup([reference("hero"), reference("place", "location")]);
  await vi.advanceTimersByTimeAsync(1001);
  await finish(requests()[0].jobId, "failed", "Runtime error");
  expect(requests()).toHaveLength(2);
  saved.mockRejectedValueOnce(new Error("Disk locked"));
  await finish(requests()[1].jobId);
  expect(queue.getSnapshot()[0]).toMatchObject({ status: "failed", needsSave: true });
  await queue.retrySave(queue.getSnapshot()[0].id);
  expect(queue.getSnapshot()[0].needsSave).toBe(false);
  expect(requests()).toHaveLength(2);
  expect(queue.getSnapshot()[0].error).toContain("Runtime error");
});

it("uses a distinct composition for every reference type and preserves the user's prompt", () => {
  const prompts = ["character", "animal", "product", "location", "style"].map((type) => referenceIconPrompt(reference("example", type as "character")));
  expect(new Set(prompts).size).toBe(5);
  for (const prompt of prompts) expect(prompt).toContain("User description for example.");
});

it("forces replacement of bundled and generated icons in one batch behind videos", async () => {
  const preset = REFERENCE_PRESETS[0];
  preset.icon = "/test-preset.jpg";
  const existing = { ...reference("existing", "animal"), iconRelativePath: "references/icons/old.jpg" };
  const { queue, session } = setup([existing, { ...reference("preset", preset.type), description: preset.prompt }]);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(0);
  video(queue, session);
  queue.regenerateReferenceIcon(session, "existing");
  queue.regenerateReferenceIcon(session, "existing");
  queue.regenerateReferenceIcon(session, "preset");
  await flush();
  expect(requests()).toHaveLength(1);
  expect(queue.isReferenceIconPending(session, "existing")).toBe(true);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe(existing.iconRelativePath);
  await finish(requests()[0].jobId);
  expect(requests()[1]).toMatchObject({ stillImage: true, canvasWidth: 768, canvasHeight: 768, steps: 20 });
  await finish(requests()[1].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe(`references/icons/${requests()[1].jobId}.jpg`);
  expect(queue.isReferenceIconPending(session, "existing")).toBe(false);
  await finish(requests()[2].jobId);
  expect(session.getSnapshot().config.references[1].iconRelativePath).toBe(`references/icons/${requests()[2].jobId}.jpg`);
  expect(queue.getSnapshot().filter((item) => item.kind === "reference-icons")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests()).toHaveLength(3);
});

it("keeps the previous icon after a failed refresh and allows retrying", async () => {
  const existing = { ...reference("hero"), iconRelativePath: "references/icons/old.jpg" };
  const { queue, session } = setup([existing]);
  queue.regenerateReferenceIcon(session, "hero");
  await flush();
  await finish(requests()[0].jobId, "failed", "Render failed");
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe(existing.iconRelativePath);
  expect(queue.isReferenceIconPending(session, "hero")).toBe(false);
  queue.clearFinished();
  queue.regenerateReferenceIcon(session, "hero");
  await flush();
  await finish(requests()[1].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe(`references/icons/${requests()[1].jobId}.jpg`);
});

it("regenerates with the latest prompt when a refresh result becomes stale", async () => {
  const { queue, session } = setup([{ ...reference("hero"), iconRelativePath: "references/icons/old.jpg" }]);
  queue.regenerateReferenceIcon(session, "hero");
  await flush();
  session.update((current) => ({ ...current, references: [{ ...current.references[0], description: "Updated animal prompt." }] }));
  await finish(requests()[0].jobId);
  expect(saveReferenceIcon).not.toHaveBeenCalled();
  expect(requests()[1].prompt).toContain("Updated animal prompt.");
  await finish(requests()[1].jobId);
  expect(session.getSnapshot().config.references[0].iconRelativePath).toBe(`references/icons/${requests()[1].jobId}.jpg`);
});
