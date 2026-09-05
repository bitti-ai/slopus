// @vitest-environment jsdom

import { listen } from "@tauri-apps/api/event";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveGeneratedScene } from "../../lib/generatedVideo";
import { createProjectConfig, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { useGenerationEvents } from "./useGenerationEvents";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../../lib/generatedVideo", () => ({ saveGeneratedScene: vi.fn() }));

const scope = globalThis as unknown as Record<string, unknown>;
/** Handlers the hook registered, by event name. */
const handlers = new Map<string, (event: { payload: unknown }) => void>();

beforeEach(() => {
  handlers.clear();
  localStorage.clear();
  scope.__TAURI_INTERNALS__ = {};
  // Cleared, not just re-implemented: one test asserts it was never called.
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }) as unknown as typeof listen);
  vi.mocked(saveGeneratedScene).mockReset();
});
afterEach(() => {
  cleanup();
  delete scope.__TAURI_INTERNALS__;
});

/** A project with one draft scene, and a harness that keeps whatever the hook
 *  writes — the same shape the workspace holds it in. */
function harness(onCompleted?: (jobId: string) => void, onEstimate?: (jobId: string, completionAt: number | null) => void) {
  const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
  const state = { config: fresh };
  function Harness() {
    useGenerationEvents({ folderPath: "C:\\Ceramic Lamp", onChange: (update) => { state.config = update(state.config); }, onCompleted, onEstimate });
    return null;
  }
  render(<Harness />);
  return { state, jobId: fresh.generationJobs[0].id, job: () => state.config.generationJobs[0] };
}

const emit = async (name: string, payload: unknown) => {
  await act(async () => {
    handlers.get(name)?.({ payload });
    await Promise.resolve();
  });
};

const timingProgress = (jobId: string, updates: Record<string, unknown> = {}) => ({
  jobId,
  stage: "denoising",
  step: 0,
  totalSteps: 4,
  plannedSteps: 4,
  elapsedSeconds: 20,
  frames: 360,
  canvasWidth: 416,
  canvasHeight: 416,
  referenceCount: 0,
  timingProfile: "slopfab=1.4.0|platform=CUDA 13|transformer=test.safetensors",
  ...updates,
});

describe("what the app does with the engine's events", () => {
  it("saves the frames the moment the engine says they are ready, and records the file", async () => {
    vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/job-01.mp4", bytes: 4_200_000, note: null });
    const completed = vi.fn();
    const { jobId, job, state } = harness(completed);
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "Frames and audio are ready to be encoded." });

    expect(saveGeneratedScene).toHaveBeenCalledWith(expect.objectContaining({ folderPath: "C:\\Ceramic Lamp", jobId }));
    expect(job()).toMatchObject({
      status: "completed",
      stage: "completed",
      progress: 1,
      outputRelativePath: "media/generated/job-01.mp4",
      error: null,
    });
    expect(completed).toHaveBeenCalledWith(jobId);
    // What was written has to survive a save and a reload, so it has to parse.
    expect(parseProjectConfig(state.config)).toBeTruthy();
  });

  it("keeps the note when something was left out of the file", async () => {
    vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/job-01.mp4", bytes: 10, note: "Saved without sound: this computer's encoder would not take the render's audio." });
    const { jobId, job } = harness();
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    // Finished, with the file — and still saying what is missing from it.
    expect(job().status).toBe("completed");
    expect(job().error).toMatch(/without sound/);
  });

  it("turns a scene placed before generation into playable generated media", async () => {
    vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/job-initial-brief.mp4", bytes: 10, note: null });
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const jobId = fresh.generationJobs[0].id;
    const assetId = `asset-${jobId}`;
    const state = { config: parseProjectConfig({
      ...fresh,
      assets: [{ id: assetId, kind: "generated", name: "First scene", relativePath: null, sourcePath: null, mimeType: "video/mp4", durationMs: 6000, width: null, height: null, createdAt: fresh.createdAt }],
      timeline: { tracks: fresh.timeline.tracks.map((track, index) => index === 0 ? { ...track, clips: [{ id: "clip-scene", assetId, trackId: track.id, startMs: 0, durationMs: 6000, sourceStartMs: 0, label: "First scene", color: null, status: "draft" }] } : track) },
    }) };
    function Harness() {
      useGenerationEvents({ folderPath: "C:\\Ceramic Lamp", onChange: (update) => { state.config = update(state.config); } });
      return null;
    }
    render(<Harness />);
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });

    expect(state.config.assets[0].relativePath).toBe("media/generated/job-initial-brief.mp4");
    expect(state.config.timeline.tracks[0].clips[0].status).toBe("generated");
    expect(parseProjectConfig(state.config)).toBeTruthy();
  });

  it("calls a render that could not be written a failure, not a finished scene", async () => {
    vi.mocked(saveGeneratedScene).mockRejectedValue(new Error("This computer's encoder refused every H.264 configuration."));
    const { jobId, job } = harness();
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    expect(job()).toMatchObject({ status: "failed", stage: "failed" });
    expect(job().error).toMatch(/rendered but could not be saved/);
    // Nothing to insert into a timeline, and the job must not claim otherwise.
    expect(job().outputRelativePath ?? null).toBeNull();
  });

  it("encodes one set of frames once, however many times the event arrives", async () => {
    let release = () => undefined as void;
    vi.mocked(saveGeneratedScene).mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ relativePath: "media/generated/job-01.mp4", bytes: 1, note: null });
    }));
    const { jobId } = harness();
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    expect(saveGeneratedScene).toHaveBeenCalledTimes(1);
    await act(async () => { release(); await Promise.resolve(); });
  });

  it("carries progress through the render and then through the encode", async () => {
    let report: ((encoded: number, total: number) => void) | undefined;
    vi.mocked(saveGeneratedScene).mockImplementation(async (options) => {
      report = options.onProgress;
      return { relativePath: "media/generated/job-01.mp4", bytes: 1, note: null };
    });
    const { jobId, job } = harness();

    await emit("slopfab-progress", { jobId, stage: "denoising", step: 25, totalSteps: 50 });
    const rendering = job().progress;
    expect(job().status).toBe("generating");
    // Rendering never reaches the part of the bar encoding owns, so a finished
    // render cannot look like a stalled one.
    expect(rendering).toBeGreaterThan(0.12);
    expect(rendering).toBeLessThan(0.9);

    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    await act(async () => { report?.(60, 120); await Promise.resolve(); });
    expect(job().status).toBe("completed");
  });

  it("never rolls overall progress back when a later stage reports a smaller local counter", async () => {
    const { jobId, job } = harness();
    await emit("slopfab-progress", { jobId, stage: "denoising", step: 40, totalSteps: 50 });
    const furthest = job().progress;
    await emit("slopfab-progress", { jobId, stage: "audioDecode", step: 0, totalSteps: 0 });
    expect(job().progress).toBe(furthest);
    expect(job().progress).toBeGreaterThan(0.7);
  });

  it("estimates render completion from slopfab elapsed time and completed steps", async () => {
    const onEstimate = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { jobId } = harness(undefined, onEstimate);

    await emit("slopfab-progress", timingProgress(jobId));
    expect(onEstimate).toHaveBeenLastCalledWith(jobId, null);

    now.mockReturnValue(11_000);
    await emit("slopfab-progress", timingProgress(jobId, { step: 1, elapsedSeconds: 30 }));
    const completionAt = onEstimate.mock.lastCall?.[1];
    // Ten measured seconds per step and two steps remain.
    expect(completionAt).toBe(31_000);

    vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/job-01.mp4", bytes: 1, note: null });
    await emit("slopfab-job", { jobId, state: "framesReady", detail: "" });
    expect(onEstimate).toHaveBeenLastCalledWith(jobId, null);
    now.mockRestore();
  });

  it("passes queued, failed and cancelled through as themselves", async () => {
    const { jobId, job } = harness();
    await emit("slopfab-job", { jobId, state: "queued", detail: "Queued behind any active slopfab generation." });
    expect(job()).toMatchObject({ status: "queued", stage: "queued" });

    await emit("slopfab-job", { jobId, state: "failed", detail: "The transformer weights could not be read." });
    expect(job()).toMatchObject({ status: "failed", stage: "failed", error: "The transformer weights could not be read." });

    await emit("slopfab-job", { jobId, state: "cancelled", detail: "Generation cancelled at the next slopfab checkpoint." });
    expect(job()).toMatchObject({ status: "cancelled", stage: "failed" });
    expect(saveGeneratedScene).not.toHaveBeenCalled();
  });

  it("listens for nothing in the browser preview, where there is no engine", () => {
    delete scope.__TAURI_INTERNALS__;
    harness();
    expect(listen).not.toHaveBeenCalled();
  });
});

/** The workspace holds the config this hook writes into; a stale copy would
 *  undo whatever else the app did while a render was running. */
describe("how the hook writes", () => {
  it("hands up an updater rather than a config it read minutes ago", async () => {
    vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/job-01.mp4", bytes: 1, note: null });
    const writes: Array<(current: ProjectConfig) => ProjectConfig> = [];
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    function Harness() {
      useGenerationEvents({ folderPath: "C:\\Ceramic Lamp", onChange: (update) => { writes.push(update); } });
      return null;
    }
    render(<Harness />);
    await emit("slopfab-job", { jobId: fresh.generationJobs[0].id, state: "framesReady", detail: "" });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => typeof write === "function")).toBe(true);
    // Applied to a config the hook never saw — a project renamed while the
    // render ran — the rename survives and the scene is still finished.
    const renamed = { ...fresh, name: "Renamed mid-render" };
    const result = writes.reduce((config, write) => write(config), renamed);
    expect(result.name).toBe("Renamed mid-render");
    expect(result.generationJobs[0].outputRelativePath).toBe("media/generated/job-01.mp4");
  });
});
