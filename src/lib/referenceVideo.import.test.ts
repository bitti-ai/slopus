import { describe, expect, it, vi } from "vitest";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { readMediaFileBytes } from "./persistence";
import { inspectReferenceVideo } from "./referenceVideo";

vi.mock("./persistence", () => ({ readMediaFileBytes: vi.fn() }));

describe("importing long MP4 references", () => {
  it.each(["in-memory", "fragmented"] as const)("uses the first 15 seconds of a real %s MP4 container", async (fastStart) => {
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, video: { codec: "avc", width: 320, height: 180, frameRate: 30 }, fastStart });
    const sps = [0x67, 0x42, 0x00, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0x80];
    const pps = [0x68, 0xce, 0x3c, 0x80];
    const description = new Uint8Array([1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps]);
    for (let i = 0; i < 900; i++) {
      muxer.addVideoChunkRaw(new Uint8Array([0, 0, 0, 3, 0x65, i % 256, 0]), i % 30 === 0 ? "key" : "delta",
        Math.round(i * 1_000_000 / 30), Math.round(1_000_000 / 30), i === 0 ? { decoderConfig: { codec: "avc1.42001f", codedWidth: 320, codedHeight: 180, description } } : undefined);
    }
    muxer.finalize();
    vi.mocked(readMediaFileBytes).mockResolvedValue(target.buffer);
    await expect(inspectReferenceVideo("C:/project", "C:/30-seconds.mp4")).resolves.toEqual({ durationSeconds: 15, includeAudio: false });
  });
});
