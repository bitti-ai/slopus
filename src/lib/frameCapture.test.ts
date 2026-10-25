// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureFrame, sourceCapturePlan } from "./frameCapture";
import { openLayerFrameReader } from "./exportPipeline";
import { captureTimelineFrame } from "./timelineCapture";
import { createDraftGenerationJob, createProjectConfig, type ProjectAsset, type ProjectReference } from "./project";
import { sceneInput } from "./sceneHistory";
import { emptyMotion, MOTION_MIME } from "./motion";

vi.mock("./exportPipeline", () => ({ openLayerFrameReader: vi.fn() }));
vi.mock("./timelineCapture", () => ({ captureTimelineFrame: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
function project() {
  return createProjectConfig({ name: "Capture", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
}
const media = (id: string): ProjectAsset => ({ id, name: id, kind: "generated", mimeType: "video/mp4", relativePath: `media/${id}.mp4`, durationMs: 10000, createdAt: new Date(0).toISOString() });
const reference = (id: string, fields: Partial<ProjectReference>): ProjectReference => ({ id, name: id, kind: "text", description: "", intendedUse: [], createdAt: new Date(0).toISOString(), ...fields });

it("captures primary or explicitly requested takes using saved shot timing and joined scene offsets", () => {
  const config = project();
  const job = createDraftGenerationJob("Scene", { id: "scene", shots: [
    { id: "first", startSeconds: 0, action: "First" }, { id: "second", startSeconds: 2, action: "Second" },
  ] });
  const primary = { id: "primary", createdAt: job.createdAt, scene: sceneInput(job), media: {
    ...media("asset-scene"), sceneSegments: [{ sceneId: "previous", latentRelativePath: "latents/a.safetensors", startFrame: 0, frameCount: 120 },
      { sceneId: "scene", latentRelativePath: "latents/b.safetensors", startFrame: 120, frameCount: 120 }],
  } };
  const older = { ...structuredClone(primary), id: "older", media: media("older") };
  older.scene.shots![1].startSeconds = 4;
  job.generationHistory = { versions: [older, primary], primaryId: "primary", selectedId: "older" };
  job.shots![1].startSeconds = 8; // Current UI input must not alter rendered shot coordinates.
  config.generationJobs = [job];
  const before = structuredClone(config);
  expect(sourceCapturePlan(config, { op: "scene.capture", scene: job.id, at: 1 }).sourceTimeUs).toBe(6_000_000);
  expect(sourceCapturePlan(config, { op: "shot.capture", scene: job.id, shot: "second", at: 0.5 }).sourceTimeUs).toBe(7_500_000);
  expect(sourceCapturePlan(config, { op: "shot.capture", scene: job.id, shot: "second", at: 0.5, generation: "older" })).toMatchObject({ asset: { id: "older" }, sourceTimeUs: 4_500_000 });
  expect(() => sourceCapturePlan(config, { op: "shot.capture", scene: job.id, shot: "first", at: 2 })).toThrow("end exclusive");
  expect(() => sourceCapturePlan(config, { op: "scene.capture", scene: job.id, at: 5 })).toThrow("end exclusive");
  expect(() => sourceCapturePlan(config, { op: "shot.capture", scene: job.id, shot: "missing" })).toThrow("does not exist");
  expect(() => sourceCapturePlan(config, { op: "scene.capture", scene: job.id, generation: "missing" })).toThrow("no generation");
  expect(config).toEqual(before);
});

it("supports legacy completed scenes but rejects unrendered scenes and invalid times", () => {
  const config = project();
  const job = createDraftGenerationJob("Legacy", { id: "legacy" });
  config.generationJobs = [job];
  expect(() => sourceCapturePlan(config, { op: "scene.capture", scene: job.id })).toThrow("no completed");
  job.outputRelativePath = "media/legacy.mp4";
  expect(sourceCapturePlan(config, { op: "scene.capture", scene: job.id })).toMatchObject({ asset: { relativePath: job.outputRelativePath }, sourceTimeUs: 0 });
  for (const at of [-1, NaN, Infinity]) expect(() => sourceCapturePlan(config, { op: "scene.capture", scene: job.id, at })).toThrow("nonnegative");
});

it("captures trimmed video references, specific saved frames and attached or legacy images", () => {
  const config = project();
  config.references = [reference("video", { kind: "video", sourcePath: "D:/video.mp4", video: {
    startSeconds: 7, durationSeconds: 3, includeAudio: false, mode: "frames",
    frames: [{ id: "frame", name: "Frame", relativePath: "references/frame.png", timeSeconds: 8 }],
  } }), reference("character", { images: [
    { id: "front", name: "Front", relativePath: "references/front.jpg" },
    { id: "side", name: "Side", sourcePath: "D:/side.webp" },
  ] }), reference("legacy", { kind: "image", relativePath: "references/legacy.png" })];
  expect(sourceCapturePlan(config, { op: "reference.capture", reference: "video", at: 1 })).toMatchObject({ sourceTimeUs: 8_000_000, asset: { sourcePath: "D:/video.mp4" } });
  expect(sourceCapturePlan(config, { op: "reference.capture", reference: "video", image: "frame" })).toMatchObject({ sourceTimeUs: 0, asset: { relativePath: "references/frame.png" } });
  expect(sourceCapturePlan(config, { op: "reference.capture", reference: "character" }).asset.id).toBe("front");
  expect(sourceCapturePlan(config, { op: "reference.capture", reference: "character", image: "side" }).asset.sourcePath).toBe("D:/side.webp");
  expect(sourceCapturePlan(config, { op: "reference.capture", reference: "legacy" }).asset.relativePath).toBe("references/legacy.png");
  expect(() => sourceCapturePlan(config, { op: "reference.capture", reference: "video", at: 3 })).toThrow("end exclusive");
  expect(() => sourceCapturePlan(config, { op: "reference.capture", reference: "character", image: "absent" })).toThrow("does not exist");
  expect(() => sourceCapturePlan(config, { op: "reference.capture", reference: "character", at: 1 })).toThrow("Still image");
});

it("resolves exact image variants and rejects drafts, missing images and references without pictures", () => {
  const config = project();
  config.assets = [{ ...media("original"), kind: "image", mimeType: "image/png" }, { ...media("edited"), kind: "image", mimeType: "image/png", parentAssetId: "original" }];
  expect(sourceCapturePlan(config, { op: "image.capture", image: "edited" }).asset.id).toBe("edited");
  config.assets[1].imageDraft = true;
  expect(() => sourceCapturePlan(config, { op: "image.capture", image: "edited" })).toThrow("no completed image");
  expect(() => sourceCapturePlan(config, { op: "image.capture", image: "missing" })).toThrow("no completed image");
  config.references = [reference("words", {}), reference("sound", { kind: "audio", sourcePath: "D:/sound.wav" })];
  for (const id of ["words", "sound"]) expect(() => sourceCapturePlan(config, { op: "reference.capture", reference: id })).toThrow("no image or video");
});

it("encodes actual decoded pixels with bounded dimensions and releases the borrowed frame via its reader", async () => {
  const config = project();
  config.references = [reference("video", { kind: "video", sourcePath: "D:/video.mp4", video: { startSeconds: 7, durationSeconds: 3, includeAudio: false } })];
  const frame = { displayWidth: 3840, displayHeight: 2160, timestamp: 8_000_000 } as VideoFrame;
  const reader = { frameAt: vi.fn().mockResolvedValue(frame), dispose: vi.fn(), durationUs: 10_000_000 };
  vi.mocked(openLayerFrameReader).mockResolvedValue(reader);
  const drawImage = vi.fn();
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage }; } convertToBlob = async () => new Blob(["png"], { type: "image/png" }); });
  const result = await captureFrame(config, "D:/Project", { op: "reference.capture", reference: "video", at: 1.01 }, new AbortController().signal);
  expect(reader.frameAt).toHaveBeenCalledWith(8_010_000);
  expect(drawImage).toHaveBeenCalledWith(frame, 0, 0, 1536, 864);
  expect(result).toEqual({ pngBase64: "cG5n", timeMs: 8000, width: 1536, height: 864 });
  expect(reader.dispose).toHaveBeenCalledOnce();
});

it("rejects requests past the actual file end and releases readers on decode failure or cancellation", async () => {
  const config = project();
  config.references = [reference("video", { kind: "video", sourcePath: "D:/video.mp4" })];
  const reader = { frameAt: vi.fn().mockRejectedValue(new Error("Unreadable video")), dispose: vi.fn(), durationUs: 2_000_000 };
  vi.mocked(openLayerFrameReader).mockResolvedValue(reader);
  await expect(captureFrame(config, "D:/Project", { op: "reference.capture", reference: "video", at: 2 }, new AbortController().signal)).rejects.toThrow("end exclusive");
  expect(reader.frameAt).not.toHaveBeenCalled();
  await expect(captureFrame(config, "D:/Project", { op: "reference.capture", reference: "video" }, new AbortController().signal)).rejects.toThrow("Unreadable video");
  const controller = new AbortController();
  vi.mocked(openLayerFrameReader).mockImplementation(async () => { controller.abort(); return reader; });
  await expect(captureFrame(config, "D:/Project", { op: "reference.capture", reference: "video" }, controller.signal)).rejects.toThrow();
  expect(reader.dispose).toHaveBeenCalledTimes(3);
});

it("dispatches timeline requests to the existing composited renderer", async () => {
  const config = project(), signal = new AbortController().signal;
  await captureFrame(config, "D:/Project", { op: "timeline.capture", at: 1.5 }, signal);
  expect(captureTimelineFrame).toHaveBeenCalledWith(config, "D:/Project", 1.5, signal);
  expect(openLayerFrameReader).not.toHaveBeenCalled();
});

it("renders inline Motions at exact times without requiring a media file", async () => {
  const config = project();
  const motion = emptyMotion(320, 180);
  config.assets = [{ id: "motion", name: "Motion", kind: "motion", mimeType: MOTION_MIME, motion, createdAt: config.createdAt }];
  const target = { op: "motion.capture" as const, motion: "motion", at: 1.25 };
  expect(sourceCapturePlan(config, target)).toMatchObject({ asset: { motion }, sourceTimeUs: 1_250_000 });
  expect(() => sourceCapturePlan(config, { ...target, at: motion.duration })).toThrow("end exclusive");
  const frame = { displayWidth: 320, displayHeight: 180, timestamp: 1_250_000 } as VideoFrame;
  const reader = { frameAt: vi.fn().mockResolvedValue(frame), dispose: vi.fn() };
  vi.mocked(openLayerFrameReader).mockResolvedValue(reader);
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { drawImage: vi.fn() }; } convertToBlob = async () => new Blob(["rendered motion"], { type: "image/png" }); });
  expect(await captureFrame(config, "D:/Project", target, new AbortController().signal)).toMatchObject({ width: 320, height: 180, timeMs: 1250 });
  expect(openLayerFrameReader).toHaveBeenCalledWith("D:/Project", config.assets[0], 1_250_000, expect.any(Function));
  expect(reader.frameAt).toHaveBeenCalledWith(1_250_000);
  expect(reader.dispose).toHaveBeenCalledOnce();
  reader.frameAt.mockRejectedValue(new Error("Motion script failed"));
  await expect(captureFrame(config, "D:/Project", target, new AbortController().signal)).rejects.toThrow("Motion script failed");
  expect(reader.dispose).toHaveBeenCalledTimes(2);
});
