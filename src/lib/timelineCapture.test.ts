// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureTimelineFrame, timelineCapturePlan } from "./timelineCapture";
import { createCaptureCompositor, openLayerFrameReader } from "./exportPipeline";
import { createProjectConfig, type ProjectAsset, type TimelineClip } from "./project";

vi.mock("./exportPipeline", () => ({ createCaptureCompositor: vi.fn(), openLayerFrameReader: vi.fn() }));

function project() {
  const config = createProjectConfig({ name: "Capture", prompt: "", aspectRatio: "16:9", resolution: "1344p", targetDurationSeconds: 10 });
  const asset = (id: string): ProjectAsset => ({ id, name: id, kind: "video", mimeType: "video/mp4", relativePath: `${id}.mp4`, createdAt: config.createdAt });
  const clip = (id: string, trackId: string): TimelineClip => ({ id, assetId: id, trackId, label: id, startMs: 1000, durationMs: 4000, sourceStartMs: 250, status: "approved" });
  config.assets = [asset("top"), asset("bottom")];
  config.timeline.tracks = [
    { id: "overlay", name: "Overlay", kind: "video", muted: false, locked: false, clips: [{ ...clip("top", "overlay"), look: { opacity: 50 }, transition: { type: "fade", durationMs: 1000 } }] },
    { id: "story", name: "Story", kind: "video", muted: false, locked: false, clips: [clip("bottom", "story")] },
  ];
  return config;
}

describe("timeline capture", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("resolves source trims, frame timing and compositing order without changing the project", () => {
    const config = project();
    const saved = structuredClone(config);
    const plan = timelineCapturePlan(config, 1.51);
    expect(plan.timeMs).toBe(1500);
    expect(plan.layers.map((layer) => layer.asset.id)).toEqual(["bottom", "top"]);
    expect(plan.layers.map((layer) => layer.sourceTimeUs)).toEqual([750000, 750000]);
    expect(plan.layers[1].style.opacity).toBe(0.25);
    expect(plan.width).toBe(1536);
    expect(plan.height).toBeLessThan(plan.width);
    expect(config).toEqual(saved);
  });

  it("distinguishes gaps, invalid times and missing media", () => {
    const config = project();
    expect(timelineCapturePlan(config, 0).layers).toEqual([]);
    for (const at of [-1, NaN, Infinity, 5, 10000]) expect(() => timelineCapturePlan(config, at)).toThrow("timeline");
    config.assets[0].relativePath = null;
    expect(() => timelineCapturePlan(config, 2)).toThrow("no generated or imported media");
  });

  it("uses joined continuation offsets", () => {
    const config = project();
    config.timeline.tracks = [config.timeline.tracks[1]];
    config.assets[1].sceneSegments = [{ sceneId: "bottom", latentRelativePath: "latents/b.safetensors", startFrame: 120, frameCount: 120 }];
    // With no scene binding, a segment can be resolved by its asset id.
    config.assets[1].id = "asset-bottom";
    config.timeline.tracks[0].clips[0].assetId = "asset-bottom";
    expect(timelineCapturePlan(config, 1.5).layers[0].sourceTimeUs).toBe(5750000);
  });

  it("renders into its own surface, encodes PNG and releases all frame resources", async () => {
    const config = project();
    const frames = [{ name: "bottom" }, { name: "top" }];
    const readers = frames.map((frame) => ({ frameAt: vi.fn().mockResolvedValue(frame), dispose: vi.fn() }));
    const close = vi.fn();
    const output = { close };
    const compositor = { kind: "webgpu" as const, clear: vi.fn(), draw: vi.fn(), take: vi.fn().mockReturnValue(output), dispose: vi.fn() };
    vi.mocked(openLayerFrameReader).mockResolvedValueOnce(readers[0]).mockResolvedValueOnce(readers[1]);
    vi.mocked(createCaptureCompositor).mockResolvedValue(compositor);
    const drawImage = vi.fn();
    const convertToBlob = vi.fn().mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage }; } convertToBlob = convertToBlob; });
    const result = await captureTimelineFrame(config, "D:/Project", 1.5, new AbortController().signal);
    expect(compositor.draw.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(drawImage).toHaveBeenCalledWith(output, 0, 0);
    expect(result).toMatchObject({ timeMs: 1500, width: 1536, pngBase64: "cG5n" });
    expect(close).toHaveBeenCalledOnce();
    expect(compositor.dispose).toHaveBeenCalledOnce();
    readers.forEach((reader) => expect(reader.dispose).toHaveBeenCalledOnce());
  });

  it("closes partial decoders on failure and cancellation without creating a compositor", async () => {
    const reader = { frameAt: vi.fn().mockRejectedValue(new Error("decode failed")), dispose: vi.fn() };
    vi.mocked(openLayerFrameReader).mockResolvedValue(reader);
    await expect(captureTimelineFrame(project(), "D:/Project", 2, new AbortController().signal)).rejects.toThrow("decode failed");
    expect(reader.dispose).toHaveBeenCalledOnce();
    expect(createCaptureCompositor).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(captureTimelineFrame(project(), "D:/Project", 2, controller.signal)).rejects.toThrow();
    expect(openLayerFrameReader).toHaveBeenCalledTimes(1);
  });
});
