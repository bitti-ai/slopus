// @vitest-environment jsdom
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { releaseRendered, saveGeneratedScene } from "./generatedVideo";
import { createProjectConfig, parseProjectConfig, referenceImages, type ProjectRecord, type ProjectReference } from "./project";
import { REFERENCE_PRESETS } from "./reference-presets";
import { referenceIconPrompt } from "./referenceIcons";
import { cancelSlopfabGeneration, enqueueSlopfabGeneration, resolveSlopfabPlan, saveReferenceIcon } from "./runtime";
import { WorkQueue } from "./workQueue";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./generatedVideo", () => ({ releaseRendered: vi.fn(async () => true), saveGeneratedScene: vi.fn() }));
vi.mock("./timelineThumbnails", () => ({ purgeTimelineThumbnails: vi.fn(async () => undefined) }));
vi.mock("./runtime", () => ({ enqueueSlopfabGeneration: vi.fn(), resolveSlopfabPlan: vi.fn(), cancelSlopfabGeneration: vi.fn(), saveReferenceIcon: vi.fn() }));
const handlers = new Map<string, (event: { payload: any }) => void>();
let stop: () => void;
const reference = (id: string, type: "character" | "product" | "location" | "style" = "character"): ProjectReference => ({
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

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear(); handlers.clear();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: any }) => void) => { handlers.set(name, handler); return () => { handlers.delete(name); }; }) as typeof listen);
  vi.mocked(enqueueSlopfabGeneration).mockResolvedValue(undefined);
  vi.mocked(resolveSlopfabPlan).mockResolvedValue({ alignedFrames: 120, canvasWidth: 736, canvasHeight: 416 } as Awaited<ReturnType<typeof resolveSlopfabPlan>>);
  vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/scene.mp4", bytes: 10, note: null });
  vi.mocked(saveReferenceIcon).mockImplementation(async (_folder, id) => `references/icons/${id}.jpg`);
  vi.mocked(cancelSlopfabGeneration).mockResolvedValue(true);
});
afterEach(() => { stop?.(); vi.useRealTimers(); delete (window as any).__TAURI_INTERNALS__; });

it("groups icons across projects and gives waiting videos priority between icons", async () => {
  const { queue, session } = setup([reference("hero")]);
  const second = queue.project(project("Second", [reference("place", "location")]));
  video(queue, session);
  await vi.advanceTimersByTimeAsync(1001);
  expect(requests()).toHaveLength(1);
  expect(queue.getSnapshot().filter((item) => item.kind === "reference-icons")).toHaveLength(1);
  expect(queue.hasActiveProject(second.record)).toBe(true);
  await finish(requests()[0].jobId);
  expect(requests()[1]).toMatchObject({ stillImage: true, frames: 1, canvasWidth: 256, canvasHeight: 256, steps: 30 });
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
  const preset = REFERENCE_PRESETS.find((preset) => preset.icon)!;
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
  const prompts = ["character", "product", "location", "style"].map((type) => referenceIconPrompt(reference("example", type as "character")));
  expect(new Set(prompts).size).toBe(4);
  for (const prompt of prompts) expect(prompt).toContain("User description for example.");
});
