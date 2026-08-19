import { describe, expect, it, vi } from "vitest";
import { demux } from "./exportPipeline";

// The module reaches for Tauri's IPC at import time; nothing here invokes it.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/* Stage 1 of the pipeline, checked against a real MP4 rather than a mock.
   mp4-muxer builds the file, mp4box takes it apart again, and what comes back
   has to be exactly what went in — sample times, keyframe flags and the codec
   configuration record the decoder cannot start without.

   The frame payloads are not real H.264 (nothing here can encode), which is why
   this stops at the demuxer: everything it asserts is container structure, and
   container structure is what this stage is responsible for. */

/** A minimal, structurally valid AVCDecoderConfigurationRecord. */
const sps = new Uint8Array([0x67, 0x42, 0x00, 0x1f, 0xda, 0x02, 0x80, 0xf6, 0x80]);
const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
const description = new Uint8Array([
  1, 0x42, 0x00, 0x1f, 0xff, 0xe1, 0, sps.length, ...sps, 1, 0, pps.length, ...pps,
]);

async function sampleFile(frames: number, frameRate: number): Promise<ArrayBuffer> {
  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: 320, height: 180, frameRate },
    fastStart: "in-memory",
  });
  const meta = { decoderConfig: { codec: "avc1.42001f", codedWidth: 320, codedHeight: 180, description } };
  const step = 1_000_000 / frameRate;
  for (let index = 0; index < frames; index += 1) {
    muxer.addVideoChunkRaw(
      new Uint8Array([0, 0, 0, 3, 0x65, index, 0]),
      index % 3 === 0 ? "key" : "delta",
      Math.round(index * step),
      Math.round(step),
      index === 0 ? meta : undefined,
    );
  }
  muxer.finalize();
  return target.buffer;
}

describe("demuxing a real MP4", () => {
  it("recovers the decoder configuration the file was written with", async () => {
    const source = await demux(await sampleFile(5, 30), "sample.mp4");
    expect(source.config.codec).toBe("avc1.42001f");
    expect(source.config.codedWidth).toBe(320);
    expect(source.config.codedHeight).toBe(180);
    // Byte for byte: a decoder handed a re-serialised record refuses to start.
    expect(Array.from(source.config.description as Uint8Array)).toEqual(Array.from(description));
  });

  it("recovers every frame with its time, length and keyframe flag", async () => {
    const source = await demux(await sampleFile(5, 30), "sample.mp4");
    expect(source.samples).toHaveLength(5);
    expect(source.samples.map((sample) => sample.timestampUs)).toEqual([0, 33333, 66667, 100000, 133333]);
    expect(source.samples.map((sample) => sample.key)).toEqual([true, false, false, true, false]);
    expect(source.samples.every((sample) => sample.durationUs === 33333)).toBe(true);
    expect(source.samples.every((sample) => sample.data.byteLength === 7)).toBe(true);
  });

  it("converts the file's own timescale, not an assumed one", async () => {
    const source = await demux(await sampleFile(3, 25), "sample.mp4");
    expect(source.samples.map((sample) => sample.timestampUs)).toEqual([0, 40000, 80000]);
  });

  it("names the file it could not read instead of failing silently", async () => {
    const rubbish = new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112, 9, 9, 9, 9]).buffer;
    await expect(demux(rubbish, "broken.mp4")).rejects.toThrow(/broken\.mp4/);
  });
});
