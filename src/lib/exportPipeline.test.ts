// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import externalFixture from "../../fixtures/project-v1-external-media.json";
import { buildExportPlan, defaultExportSettings } from "./export";
import { parseProjectConfig, type ProjectAsset } from "./project";
import { demux, ExportCancelled, PreviewSources, probeCompositor, runExport } from "./exportPipeline";

// Every IPC call is captured rather than performed: what the export DISPATCHES
// is the thing under test.
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

/* ---------------------------------------------------------------------------
   The export against media the project does NOT contain.

   Every earlier export test built its assets as `relativePath: media/<id>.mp4`,
   which is a shape imported video has not had since media stopped being copied
   into the project folder. That is why a broken read shipped green: the export
   asked `read_project_file` for a null relative path, the call died inside IPC
   argument deserialisation, and no test had an external asset to notice with.

   These run on `fixtures/project-v1-external-media.json` — the same file the
   schema tests and six Rust tests use — so the shape here is the shape on disk.
   --------------------------------------------------------------------------- */

const invoked = invoke as unknown as Mock;
const FOLDER = "D:\\tmp\\news\\News broadcast";
const EXTERNAL_VIDEO = "D:\\tmp\\news\\News broadcast\\rush-01.mp4";

const externalProject = () => parseProjectConfig(externalFixture);
const assetNamed = (id: string): ProjectAsset => {
  const found = externalProject().assets.find((asset) => asset.id === id);
  if (!found) throw new Error(`fixture has no asset ${id}`);
  return found;
};

/** Every call the export made, in the shape a reader of the failing IPC log
 *  would see it. */
const callLog = () => invoked.mock.calls.map(([cmd, args]) => ({ cmd, args }));

beforeEach(() => {
  invoked.mockReset();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("reading the media an export needs", () => {
  it("fetches an imported .mp4 from where it actually lives", async () => {
    invoked.mockResolvedValue(await sampleFile(5, 30));
    const sources = new PreviewSources(FOLDER);
    await sources.url(assetNamed("asset-external-video"));

    expect(callLog()).toEqual([
      { cmd: "read_external_media_file", args: { folderPath: FOLDER, sourcePath: EXTERNAL_VIDEO } },
    ]);
  });

  it("never asks read_project_file for a path the asset does not have", async () => {
    invoked.mockResolvedValue(await sampleFile(5, 30));
    const sources = new PreviewSources(FOLDER);
    await sources.url(assetNamed("asset-external-video"));
    await sources.url(assetNamed("asset-external-audio"));

    // The exact failure this class of bug produces: a String parameter handed a
    // null, rejected by IPC argument deserialisation before Rust runs at all.
    for (const call of callLog()) {
      expect(call.cmd).not.toBe("read_project_file");
      expect(call.args).not.toHaveProperty("relativePath");
    }
  });

  it("still fetches a copied still from inside the project folder", async () => {
    invoked.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    const sources = new PreviewSources(FOLDER);
    await sources.url(assetNamed("asset-copied-image"));

    expect(callLog()).toEqual([
      { cmd: "read_project_file", args: { folderPath: FOLDER, relativePath: "media/title-card.png" } },
    ]);
  });

  it("reads each asset once, however many frames want it", async () => {
    invoked.mockResolvedValue(await sampleFile(5, 30));
    const sources = new PreviewSources(FOLDER);
    const asset = assetNamed("asset-external-video");
    await Promise.all([sources.url(asset), sources.url(asset), sources.url(asset)]);
    expect(invoked).toHaveBeenCalledTimes(1);
  });
});

describe("planning an export of external media", () => {
  it("raises no blocker: the file is reachable, it just is not in the folder", () => {
    const config = externalProject();
    const plan = buildExportPlan(config, defaultExportSettings(config));
    expect(plan.blockers).toEqual([]);
    expect(plan.clipCount).toBe(1);
    expect(plan.frameCount).toBe(360);
    expect(plan.segments).toEqual([
      expect.objectContaining({ kind: "clip", assetId: "asset-external-video", startFrame: 0, endFrame: 360 }),
    ]);
  });

  it("blocks when an asset records no file at all, instead of offering the run", () => {
    const config = externalProject();
    const stripped = {
      ...config,
      assets: config.assets.map((asset) =>
        asset.id === "asset-external-video" ? { ...asset, sourcePath: null, relativePath: null } : asset,
      ),
    };
    const plan = buildExportPlan(stripped, defaultExportSettings(config));
    expect(plan.blockers.join(" ")).toMatch(/no file recorded/i);
  });
});

/* WebCodecs and OffscreenCanvas do not exist in jsdom, so the run below stands
   them up. They do only what the pipeline asks of them and nothing more: the
   decoder deliberately emits no frames, which makes the run fail at a known
   point AFTER the source file has been read. What is asserted is the read. */
function installWebCodecs(): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const saved = {
    VideoEncoder: scope.VideoEncoder,
    VideoDecoder: scope.VideoDecoder,
    VideoFrame: scope.VideoFrame,
    EncodedVideoChunk: scope.EncodedVideoChunk,
    OffscreenCanvas: scope.OffscreenCanvas,
  };
  scope.VideoEncoder = class {
    static async isConfigSupported(config: unknown) {
      return { supported: true, config };
    }
    state = "configured";
    encodeQueueSize = 0;
    configure() {}
    encode() {}
    async flush() {}
    close() {
      this.state = "closed";
    }
  };
  scope.VideoDecoder = class {
    state = "configured";
    decodeQueueSize = 0;
    configure() {}
    decode() {}
    async flush() {}
    close() {
      this.state = "closed";
    }
  };
  scope.VideoFrame = class {
    timestamp: number;
    duration: number;
    displayWidth = 320;
    displayHeight = 180;
    constructor(_source: unknown, init: { timestamp: number; duration?: number }) {
      this.timestamp = init.timestamp;
      this.duration = init.duration ?? 0;
    }
    close() {}
  };
  scope.EncodedVideoChunk = class {
    constructor(init: Record<string, unknown>) {
      Object.assign(this, init);
    }
  };
  scope.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(kind: string) {
      return kind === "2d" ? { fillStyle: "", fillRect() {}, drawImage() {} } : null;
    }
  };
  return () => Object.assign(scope, saved);
}

describe("running an export of external media", () => {
  it("dispatches the external read, not a project-relative one", async () => {
    const restore = installWebCodecs();
    try {
      invoked.mockResolvedValue(await sampleFile(5, 30));
      const config = externalProject();
      const settings = defaultExportSettings(config);
      await expect(
        runExport({
          folderPath: FOLDER,
          config,
          settings,
          plan: buildExportPlan(config, settings),
          bitrate: 5_000_000,
          onProgress: () => {},
          cancelled: () => false,
        }),
        // The stub decoder produces nothing, so the run ends here — well past
        // the read, which is the step this test exists for.
      ).rejects.toThrow(/no picture/i);

      expect(callLog()).toEqual([
        { cmd: "read_external_media_file", args: { folderPath: FOLDER, sourcePath: EXTERNAL_VIDEO } },
      ]);
    } finally {
      restore();
    }
  });

  it("stops on cancel without ever touching the file", async () => {
    const restore = installWebCodecs();
    try {
      const config = externalProject();
      const settings = defaultExportSettings(config);
      await expect(
        runExport({
          folderPath: FOLDER,
          config,
          settings,
          plan: buildExportPlan(config, settings),
          bitrate: 5_000_000,
          onProgress: () => {},
          cancelled: () => true,
        }),
      ).rejects.toBeInstanceOf(ExportCancelled);
      expect(invoked).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("which compositor will really run", () => {
  it("answers from the adapter, and says why when there is none", async () => {
    // jsdom has no navigator.gpu at all — the honest answer is canvas2d with
    // that as the stated reason, not a WebGPU claim from a present object.
    const probe = await probeCompositor();
    expect(probe.kind).toBe("canvas2d");
    expect(probe.detail).toMatch(/navigator\.gpu/);
  });

});
