import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { demux } from "./exportPipeline";
import { saveSceneLastFrame } from "./sceneLastFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./persistence", () => ({ readMediaFileBytes: vi.fn(async () => new ArrayBuffer(0)) }));
vi.mock("./exportPipeline", () => ({ demux: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("decodes the final GOP, captures the last presentation frame at full size and releases every frame", async () => {
  vi.mocked(demux).mockResolvedValue({ config: { codec: "avc1" }, samples: [0, 100, 200, 400, 300].map((timestampUs) => ({
    timestampUs, key: timestampUs === 0 || timestampUs === 200, durationUs: 100, data: new Uint8Array(1),
  })) });
  const frames: Array<{ timestamp: number; displayWidth: number; displayHeight: number; close: ReturnType<typeof vi.fn> }> = [];
  const close = vi.fn();
  const draw = vi.fn();
  const canvas = vi.fn();
  vi.stubGlobal("EncodedVideoChunk", class { constructor(public init: EncodedVideoChunkInit) {} });
  vi.stubGlobal("VideoDecoder", class {
    state = "configured";
    decodeQueueSize = 0;
    constructor(private init: VideoDecoderInit) {}
    configure() {}
    decode(chunk: { init: EncodedVideoChunkInit }) {
      const frame = { timestamp: chunk.init.timestamp, displayWidth: 1920, displayHeight: 1080, close: vi.fn() };
      frames.push(frame);
      this.init.output(frame as unknown as VideoFrame);
    }
    async flush() {}
    close = close;
  });
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(width: number, height: number) { canvas(width, height); }
    getContext() { return { drawImage: draw }; }
    async convertToBlob() { return { arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }; }
  });
  expect(await saveSceneLastFrame("C:/project", "media/generated/work-source.mp4")).toBe("cache/scene-last/work-source.png");
  expect(frames.map((frame) => frame.timestamp)).toEqual([200, 400, 300]);
  expect(draw).toHaveBeenCalledWith(frames[1], 0, 0);
  expect(canvas).toHaveBeenCalledWith(1920, 1080);
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("write_scene_last_frame", expect.any(Uint8Array), { headers: {
    "x-generated-folder": "C%3A%2Fproject", "x-generated-job": "work-source",
  } });
});

it("rejects a video with no decoded samples before creating an image", async () => {
  vi.mocked(demux).mockResolvedValue({ config: { codec: "avc1" }, samples: [] });
  await expect(saveSceneLastFrame("C:/project", "media/generated/work-source.mp4")).rejects.toThrow("no video frames");
  expect(invoke).not.toHaveBeenCalled();
});
