import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { demux, type DemuxedSource } from "./exportPipeline";
import { inspectReferenceVideo, prepareReferenceVideos, referenceSoundtrack, referenceVideoRange, sourceVideoDuration, uploadReferenceVideoFrames } from "./referenceVideo";
import { createProjectConfig } from "./project";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./persistence", () => ({ readMediaFileBytes: vi.fn(async () => new ArrayBuffer(0)) }));
vi.mock("./exportPipeline", () => ({ demux: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockResolvedValue("video-1"));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

const input = { name: "Movement", sourcePath: "C:/movement.mp4", startSeconds: 1, durationSeconds: 2, includeAudio: false };
const source: DemuxedSource = { config: { codec: "avc1" }, durationSeconds: 4, hasAudio: false,
  samples: [0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000].map((timestampUs) => ({
    timestampUs, durationUs: 500_000, key: timestampUs === 0, data: new Uint8Array(1),
  })) };

it.each([0, NaN, .5, 120, undefined])("imports long sources with header duration %s using a capped selection", async (durationSeconds) => {
  const long = { ...source, durationSeconds, samples: [0, 59_000_000].map((timestampUs) => ({
    timestampUs, durationUs: 1_000_000, key: true, data: new Uint8Array(1),
  })) };
  vi.mocked(demux).mockResolvedValue(long);
  expect(sourceVideoDuration(long)).toBe(60);
  await expect(inspectReferenceVideo("C:/project", "C:/long.mp4")).resolves.toEqual({ durationSeconds: 15, includeAudio: false });
  expect(referenceVideoRange({ ...input, startSeconds: 45, durationSeconds: 15 }, sourceVideoDuration(long))).toEqual({ start: 45, duration: 15 });
});

function decoderMocks() {
  const frames: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const make = (timestamp: number) => {
    const frame = { timestamp, displayWidth: 1920, displayHeight: 1080, close: vi.fn(), clone: () => make(timestamp) };
    frames.push(frame); return frame;
  };
  const close = vi.fn();
  const configure = vi.fn();
  vi.stubGlobal("EncodedVideoChunk", class { constructor(public init: EncodedVideoChunkInit) {} });
  vi.stubGlobal("VideoDecoder", class {
    static async isConfigSupported(config: VideoDecoderConfig) { return { supported: true, config }; }
    state = "configured"; decodeQueueSize = 0;
    constructor(private init: VideoDecoderInit) {}
    configure = configure;
    decode(chunk: { init: EncodedVideoChunkInit }) { this.init.output(make(chunk.init.timestamp) as unknown as VideoFrame); }
    async flush() {}
    close = close;
  });
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(public width: number, public height: number) {}
    getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(this.width * this.height * 4) }) }; }
  });
  return { frames, close, configure };
}

it.each(["unsupported", "rejected"])("falls back when AV1 hardware decoding is %s", async (failure) => {
  const { configure, frames } = decoderMocks();
  const av1 = { ...source, config: { codec: "av01.0.08M.08", codedWidth: 544, codedHeight: 960,
    description: new Uint8Array([129, 8, 12, 0]) } };
  const probe = vi.spyOn(VideoDecoder, "isConfigSupported").mockImplementation(async (config) => {
    if (config.hardwareAcceleration === "prefer-hardware") {
      if (failure === "rejected") throw new DOMException("No hardware decoder", "NotSupportedError");
      return { supported: false, config };
    }
    return { supported: true, config };
  });
  await uploadReferenceVideoFrames(av1, "video-1", 1, 2, () => false);
  expect(probe.mock.calls.map(([config]) => config.hardwareAcceleration)).toEqual(["prefer-hardware", "no-preference"]);
  expect(configure).toHaveBeenCalledWith({ ...av1.config, hardwareAcceleration: "no-preference" });
  expect(invoke).toHaveBeenCalledWith("append_reference_video", expect.any(Uint8Array), expect.anything());
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
});

it("keeps hardware decoding when supported", async () => {
  const { configure } = decoderMocks();
  const probe = vi.spyOn(VideoDecoder, "isConfigSupported");
  await uploadReferenceVideoFrames(source, "video-1", 1, 2, () => false);
  expect(probe).toHaveBeenCalledOnce();
  expect(configure).toHaveBeenCalledWith({ ...source.config, hardwareAcceleration: "prefer-hardware" });
});

it("reports unavailable codecs only after both probes and releases the native reference", async () => {
  const { configure } = decoderMocks();
  const probe = vi.spyOn(VideoDecoder, "isConfigSupported").mockImplementation(async (config) => ({ supported: false, config }));
  vi.mocked(demux).mockResolvedValue(source);
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 20 });
  const request = { jobId: "job", prompt: "", frames: 120, steps: 4, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [], referenceVideos: [input] };
  await expect(prepareReferenceVideos("C:/project", request, config, () => false, () => undefined)).rejects.toThrow("hardware or automatic decoder selection");
  expect(probe).toHaveBeenCalledTimes(2);
  expect(configure).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledWith("release_reference_videos", { ids: ["video-1"] });
});

it("validates trim bounds and uses at most 15 seconds for an unspecified clip", () => {
  expect(referenceVideoRange(input, 4)).toEqual({ start: 1, duration: 2 });
  expect(referenceVideoRange({ ...input, durationSeconds: undefined }, 30).duration).toBe(15);
  expect(() => referenceVideoRange({ ...input, durationSeconds: 1 }, 4)).toThrow("2 to 15");
  expect(() => referenceVideoRange(input, 2)).toThrow("beyond");
  expect(() => referenceVideoRange({ ...input, startSeconds: NaN }, 4)).toThrow();
});

it("uploads the trimmed interval at clip-relative times and closes every frame", async () => {
  const { frames, close } = decoderMocks();
  await uploadReferenceVideoFrames(source, "video-1", 1, 2, () => false);
  const calls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "append_reference_video");
  expect(calls.map((call) => (call[2]?.headers as Record<string, string>)["x-reference-time"])).toEqual(["0", "0.5", "1", "1.5"]);
  expect(calls[0][2]?.headers).toMatchObject({ "x-reference-width": "768", "x-reference-height": "432" });
  expect(calls.every((call) => call[1] instanceof Uint8Array)).toBe(true);
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("prepares only a late selection from a long source", async () => {
  const { frames } = decoderMocks();
  const long = { ...source, durationSeconds: 0, samples: Array.from({ length: 60 }, (_, index) => ({
    timestampUs: index * 1_000_000, durationUs: 1_000_000, key: index % 5 === 0, data: new Uint8Array(1),
  })) };
  vi.mocked(demux).mockResolvedValue(long);
  const config = createProjectConfig({ name: "Long reference", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 20 });
  await prepareReferenceVideos("C:/project", {
    jobId: "job", prompt: "", frames: 120, steps: 4, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [],
    referenceVideos: [{ ...input, startSeconds: 45, durationSeconds: 15 }],
  }, config, () => false, () => {});
  expect(invoke).toHaveBeenCalledWith("create_reference_video", { durationSeconds: 15, config });
  const calls = vi.mocked(invoke).mock.calls.filter(([command]) => command === "append_reference_video");
  expect(calls.map((call) => Number((call[2]?.headers as Record<string, string>)["x-reference-time"]))).toEqual(Array.from({ length: 15 }, (_, i) => i));
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
});

it("releases native inputs and decoder frames after an upload failure", async () => {
  const { frames, close } = decoderMocks();
  vi.mocked(demux).mockResolvedValue(source);
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "append_reference_video") throw new Error("upload failed");
    return "video-1";
  });
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 20 });
  const request = { jobId: "job", prompt: "", frames: 120, steps: 12, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [], referenceVideos: [input] };
  await expect(prepareReferenceVideos("C:/project", request, config, () => false, () => undefined)).rejects.toThrow("upload failed");
  expect(invoke).toHaveBeenCalledWith("release_reference_videos", { ids: ["video-1"] });
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("stops decoding promptly when preparation is cancelled", async () => {
  const { frames, close } = decoderMocks();
  let cancelled = false;
  vi.mocked(invoke).mockImplementation(async () => { cancelled = true; });
  await expect(uploadReferenceVideoFrames(source, "video-1", 1, 2, () => cancelled)).rejects.toThrow("cancelled");
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it("trims and interleaves stereo sound without exceeding the video duration", () => {
  const audio = { sampleRate: 2, numberOfChannels: 2, length: 8,
    getChannelData: (channel: number) => new Float32Array(channel ? [0, 0, -0.5, -2, 0.5, 0, 0, 0] : [0, 0, 0.5, 2, -0.5, 0, 0, 0]) } as AudioBuffer;
  expect(Array.from(referenceSoundtrack(audio, 1, 2))).toEqual([0.5, -0.5, 1, -1, -0.5, 0.5, 0, 0]);
});
