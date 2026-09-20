// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import audioFixture from "../../fixtures/project-v1-audio-mix.json";
import externalFixture from "../../fixtures/project-v1-external-media.json";
import { audioMixBytes, buildExportPlan, defaultExportSettings } from "./export";
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

/* ---------------------------------------------------------------------------
   A real .wav, built here.

   The sound half of the pipeline decodes through `decodeAudioData` rather than
   through mp4box, so what it has to survive is a container it did not write.
   These bytes are a genuine RIFF/WAVE file — header, `fmt ` chunk, interleaved
   16-bit samples — and the harness decoder below parses them as one, including
   the detach `decodeAudioData` performs on its input. Nothing here hands the
   pipeline a pre-decoded buffer.
   --------------------------------------------------------------------------- */

const WAV_SAMPLE_RATE = 48_000;

function wavFile(options: {
  seconds: number;
  channels?: number;
  sampleRate?: number;
  /** The value of channel `channel` at frame `frame`, in -1..1. */
  sample: (frame: number, channel: number) => number;
}): ArrayBuffer {
  const channels = options.channels ?? 2;
  const sampleRate = options.sampleRate ?? WAV_SAMPLE_RATE;
  const frames = Math.round(options.seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); // byte rate
  view.setUint16(32, channels * 2, true); // block align
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.max(-1, Math.min(1, options.sample(frame, channel)));
      view.setInt16(offset, Math.max(-32768, Math.min(32767, Math.round(value * 32768))), true);
      offset += 2;
    }
  }
  return buffer;
}

/** 16-bit PCM back to planar floats, the way an audio decoder does it. Throws
 *  on anything that is not a WAVE, which is how the "could not be decoded"
 *  branch gets exercised with a real failure rather than a stubbed one. */
function parseWav(bytes: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } {
  const view = new DataView(bytes);
  const tag = (offset: number) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (bytes.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("The data is not a RIFF/WAVE file.");
  }
  let cursor = 12;
  let channelCount = 0;
  let sampleRate = 0;
  let data: { start: number; length: number } | null = null;
  while (cursor + 8 <= bytes.byteLength) {
    const name = tag(cursor);
    const size = view.getUint32(cursor + 4, true);
    if (name === "fmt ") {
      channelCount = view.getUint16(cursor + 10, true);
      sampleRate = view.getUint32(cursor + 12, true);
    } else if (name === "data") {
      data = { start: cursor + 8, length: size };
    }
    cursor += 8 + size + (size % 2);
  }
  if (!data || channelCount === 0) throw new Error("The WAVE file has no fmt or data chunk.");
  const frames = Math.floor(data.length / (channelCount * 2));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      /* 32767.5, not 32768: measured in Chrome, int16 16384 decodes to
         0.50001525878906250, so the range maps symmetrically onto -1..1 and
         two half-scale clips sum to one 16-bit step OVER full scale. Getting
         this wrong here hid exactly that case. */
      channels[channel][frame] = view.getInt16(data.start + (frame * channelCount + channel) * 2, true) / 32767.5;
    }
  }
  return { channels, sampleRate };
}

/* ---------------------------------------------------------------------------
   WebCodecs, OffscreenCanvas and the offline audio graph, stood up for jsdom.

   These do what the browser does and nothing more — the audio graph really
   sums overlapping sources, really refuses to play past the end of a buffer,
   and `decodeAudioData` really detaches the ArrayBuffer it is handed. The
   numbers the mixing tests assert were measured in headless Chrome against the
   same timeline first; this harness reproduces them.
   --------------------------------------------------------------------------- */

interface HarnessRecord {
  /** Every AudioData the pipeline handed the encoder, with its samples. */
  audioData: Array<{ format: string; timestamp: number; numberOfFrames: number; numberOfChannels: number; samples: Float32Array }>;
  audioConfig: AudioEncoderConfig | null;
  audioChunks: number;
  videoChunks: number;
  decoderLiveFrames: number;
  decoderPeakFrames: number;
}

class HarnessAudioBuffer {
  constructor(
    readonly data: Float32Array[],
    readonly sampleRate: number,
  ) {}
  get numberOfChannels() {
    return this.data.length;
  }
  get length() {
    return this.data[0]?.length ?? 0;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData(index: number) {
    return this.data[index];
  }
}

/** Options the harness needs to stand in for a browser. */
interface HarnessOptions {
  /** True: the decoder emits a frame per chunk, so a run reaches the muxer and
   *  produces a real file. False: it emits nothing, which is what the read
   *  tests want — they assert on the IPC log, not on a picture. */
  decodes?: boolean;
  /** False: no AudioEncoder/AudioData/OfflineAudioContext at all, which is the
   *  webview `detectExportSupport().audio` has to answer false for. */
  audio?: boolean;
  decoderPool?: number;
  decodeOnFlush?: boolean;
}

function installWebCodecs(options: HarnessOptions = {}): { restore: () => void; recorded: HarnessRecord } {
  const { decodes = false, audio = true } = options;
  const scope = globalThis as unknown as Record<string, unknown>;
  const names = [
    "VideoEncoder",
    "VideoDecoder",
    "VideoFrame",
    "EncodedVideoChunk",
    "OffscreenCanvas",
    "AudioEncoder",
    "AudioData",
    "EncodedAudioChunk",
    "OfflineAudioContext",
  ] as const;
  const saved: Record<string, unknown> = {};
  for (const name of names) saved[name] = scope[name];
  const recorded: HarnessRecord = { audioData: [], audioConfig: null, audioChunks: 0, videoChunks: 0, decoderLiveFrames: 0, decoderPeakFrames: 0 };

  class HarnessChunk {
    readonly type: "key" | "delta";
    readonly timestamp: number;
    readonly duration: number;
    private readonly payload: Uint8Array;
    constructor(init: { type: "key" | "delta"; timestamp: number; duration?: number; data: BufferSource }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration ?? 0;
      this.payload =
        init.data instanceof Uint8Array ? new Uint8Array(init.data) : new Uint8Array(init.data as ArrayBuffer);
    }
    get byteLength() {
      return this.payload.byteLength;
    }
    copyTo(destination: Uint8Array) {
      destination.set(this.payload);
    }
  }
  scope.EncodedVideoChunk = HarnessChunk;
  scope.EncodedAudioChunk = class extends HarnessChunk {};
  const EncodedVideoChunkClass = scope.EncodedVideoChunk as typeof HarnessChunk;
  const EncodedAudioChunkClass = scope.EncodedAudioChunk as typeof HarnessChunk;

  scope.VideoEncoder = class {
    static async isConfigSupported(config: unknown) {
      return { supported: true, config };
    }
    state = "configured";
    encodeQueueSize = 0;
    private readonly emit: (chunk: unknown, meta?: unknown) => void;
    private first = true;
    constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (reason: unknown) => void }) {
      this.emit = init.output;
    }
    configure() {}
    encode(frame: { timestamp: number; duration: number }, options?: { keyFrame?: boolean }) {
      // A payload derived from the frame time, so the muxed file is real bytes
      // rather than a run of zeros nothing could tell apart.
      const chunk = new EncodedVideoChunkClass({
        type: options?.keyFrame ? "key" : "delta",
        timestamp: frame.timestamp,
        duration: frame.duration,
        data: new Uint8Array([0, 0, 0, 3, 0x65, frame.timestamp & 0xff, 0]),
      });
      recorded.videoChunks += 1;
      this.emit(chunk, this.first ? { decoderConfig: { codec: "avc1.42001f", codedWidth: 320, codedHeight: 180, description } } : undefined);
      this.first = false;
    }
    async flush() {}
    close() {
      this.state = "closed";
    }
  };

  scope.VideoDecoder = class {
    state = "configured";
    private inputs: { timestamp: number; duration: number }[] = [];
    private liveFrames = 0;
    private scheduled = false;
    private flushing = false;
    private flushed: (() => void) | null = null;
    get decodeQueueSize() { return options.decodeOnFlush && !this.flushing ? 0 : this.inputs.length; }
    private readonly emit: (frame: unknown) => void;
    constructor(init: { output: (frame: unknown) => void; error: (reason: unknown) => void }) {
      this.emit = init.output;
    }
    configure() {}
    decode(chunk: { timestamp: number; duration: number }) {
      if (!decodes) return;
      if (options.decoderPool) { this.inputs.push(chunk); this.schedule(); return; }
      const Frame = scope.VideoFrame as new (source: unknown, init: { timestamp: number; duration?: number }) => unknown;
      this.emit(new Frame(null, { timestamp: chunk.timestamp, duration: chunk.duration }));
    }
    private schedule() {
      if (this.scheduled || this.state === "closed" || (options.decodeOnFlush && !this.flushing)) return;
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        if (this.state === "closed") return;
        while (this.inputs.length && this.liveFrames < options.decoderPool!) {
          const chunk = this.inputs.shift()!;
          const Frame = scope.VideoFrame as typeof VideoFrame;
          const frame = new Frame(null as unknown as CanvasImageSource, { timestamp: chunk.timestamp, duration: chunk.duration });
          this.liveFrames++; recorded.decoderLiveFrames++;
          recorded.decoderPeakFrames = Math.max(recorded.decoderPeakFrames, recorded.decoderLiveFrames);
          const close = frame.close.bind(frame);
          let closed = false;
          frame.close = () => {
            if (closed) return;
            closed = true; close();
            this.liveFrames--; recorded.decoderLiveFrames--;
            this.schedule();
          };
          this.emit(frame);
        }
        if (!this.inputs.length) { this.flushed?.(); this.flushed = null; }
      }, 0);
    }
    async flush() {
      if (!options.decoderPool) return;
      this.flushing = true;
      await new Promise<void>((resolve) => { this.flushed = resolve; this.schedule(); });
    }
    close() {
      this.state = "closed";
      this.inputs.length = 0;
      this.flushed?.();
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

  scope.OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext(kind: string) {
      return kind === "2d" ? {
        fillStyle: "",
        filter: "none",
        globalAlpha: 1,
        fillRect() {},
        drawImage() {},
        save() {},
        restore() {},
        beginPath() {},
        rect() {},
        clip() {},
        translate() {},
        rotate() {},
      } : null;
    }
  };

  if (audio) {
    scope.AudioData = class {
      readonly format: string;
      readonly sampleRate: number;
      readonly numberOfFrames: number;
      readonly numberOfChannels: number;
      readonly timestamp: number;
      /** A real AudioData copies its samples; so does this, which is what lets
       *  the assertions read them after `close()`. */
      readonly samples: Float32Array;
      constructor(init: {
        format: string;
        sampleRate: number;
        numberOfFrames: number;
        numberOfChannels: number;
        timestamp: number;
        data: Float32Array;
      }) {
        this.format = init.format;
        this.sampleRate = init.sampleRate;
        this.numberOfFrames = init.numberOfFrames;
        this.numberOfChannels = init.numberOfChannels;
        this.timestamp = init.timestamp;
        this.samples = new Float32Array(init.data);
      }
      close() {}
    };

    scope.AudioEncoder = class {
      static async isConfigSupported(config: AudioEncoderConfig) {
        return { supported: true, config };
      }
      state = "unconfigured";
      encodeQueueSize = 0;
      private readonly emit: (chunk: unknown, meta?: unknown) => void;
      private first = true;
      constructor(init: { output: (chunk: unknown, meta?: unknown) => void; error: (reason: unknown) => void }) {
        this.emit = init.output;
      }
      configure(config: AudioEncoderConfig) {
        recorded.audioConfig = config;
        this.state = "configured";
      }
      encode(data: { format: string; timestamp: number; numberOfFrames: number; numberOfChannels: number; sampleRate: number; samples: Float32Array }) {
        recorded.audioData.push({
          format: data.format,
          timestamp: data.timestamp,
          numberOfFrames: data.numberOfFrames,
          numberOfChannels: data.numberOfChannels,
          samples: data.samples.slice(),
        });
        recorded.audioChunks += 1;
        this.emit(
          new EncodedAudioChunkClass({
            type: "key",
            timestamp: data.timestamp,
            duration: Math.round((data.numberOfFrames * 1_000_000) / data.sampleRate),
            data: new Uint8Array([0x21, data.numberOfFrames & 0xff, 0x00, 0x00]),
          }),
          // What a real AAC encoder emits alongside its first packet.
          this.first
            ? {
                decoderConfig: {
                  codec: "mp4a.40.2",
                  sampleRate: 48_000,
                  numberOfChannels: 2,
                  description: new Uint8Array([0x11, 0x90]),
                },
              }
            : undefined,
        );
        this.first = false;
      }
      async flush() {}
      close() {
        this.state = "closed";
      }
    };

    scope.OfflineAudioContext = class {
      readonly destination = { node: "destination" };
      readonly numberOfChannels: number;
      readonly length: number;
      readonly sampleRate: number;
      private readonly started: Array<{ buffer: HarnessAudioBuffer; when: number; offset: number; duration: number }> = [];
      constructor(init: { numberOfChannels: number; length: number; sampleRate: number }) {
        this.numberOfChannels = init.numberOfChannels;
        this.length = init.length;
        this.sampleRate = init.sampleRate;
      }
      async decodeAudioData(bytes: ArrayBuffer): Promise<HarnessAudioBuffer> {
        /* The real one DETACHES its input. Reproduced, because the pipeline
           copies the read result before handing it over and nothing else would
           notice if that copy were removed. */
        const owned = structuredClone(bytes, { transfer: [bytes] });
        const { channels, sampleRate } = parseWav(owned);
        if (sampleRate !== this.sampleRate) {
          throw new Error(`This harness does not resample: the file is ${sampleRate} Hz, the graph is ${this.sampleRate} Hz.`);
        }
        return new HarnessAudioBuffer(channels, sampleRate);
      }
      createBufferSource() {
        const context = this;
        return {
          buffer: null as HarnessAudioBuffer | null,
          connected: false,
          connect(destination: unknown) {
            this.connected = destination === context.destination;
          },
          start(when: number, offset: number, duration: number) {
            if (!this.buffer || !this.connected) return; // an unconnected source is silence
            context.started.push({ buffer: this.buffer, when, offset, duration });
          },
        };
      }
      async startRendering(): Promise<HarnessAudioBuffer> {
        const out = Array.from({ length: this.numberOfChannels }, () => new Float32Array(this.length));
        for (const source of this.started) {
          const startFrame = Math.round(source.when * this.sampleRate);
          const offsetFrame = Math.round(source.offset * this.sampleRate);
          const count = Math.min(
            Math.round(source.duration * this.sampleRate),
            source.buffer.length - offsetFrame,
            this.length - startFrame,
          );
          for (let channel = 0; channel < this.numberOfChannels; channel += 1) {
            // Mono up-mixes onto both channels, as the browser's graph does.
            const from = source.buffer.getChannelData(Math.min(channel, source.buffer.numberOfChannels - 1));
            const into = out[channel];
            for (let index = 0; index < count; index += 1) into[startFrame + index] += from[offsetFrame + index];
          }
        }
        return new HarnessAudioBuffer(out, this.sampleRate);
      }
    };
  } else {
    delete scope.AudioEncoder;
    delete scope.AudioData;
    delete scope.OfflineAudioContext;
    delete scope.EncodedAudioChunk;
  }

  return {
    recorded,
    restore: () => {
      for (const name of names) {
        if (saved[name] === undefined) delete scope[name];
        else scope[name] = saved[name];
      }
    },
  };
}

describe("running an export of external media", () => {
  it.each(["video-queue", "video-flush", "decoder-queue", "decoder-flush", "audio-queue", "audio-flush"])("cancels and closes codecs stuck in %s", async (stuck) => {
    const harness = installWebCodecs({ decodes: true });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = vi.fn();
    const stall = () => { timer ??= setTimeout(() => { cancelled = true; }, 0); };
    try {
      const scope = globalThis as unknown as Record<string, any>;
      const name = stuck.startsWith("video") ? "VideoEncoder" : stuck.startsWith("audio") ? "AudioEncoder" : "VideoDecoder";
      const Base = scope[name];
      scope[name] = class extends Base {
        encode(...args: unknown[]) {
          super.encode(...args);
          if (stuck.endsWith("queue")) { Object.defineProperty(this, "encodeQueueSize", { value: 20 }); stall(); }
        }
        decode(...args: unknown[]) {
          if (stuck === "decoder-flush") return; // all output is deferred until flush
          super.decode(...args);
          if (stuck.endsWith("queue")) { Object.defineProperty(this, "decodeQueueSize", { value: 20 }); stall(); }
        }
        flush() {
          if (stuck.endsWith("flush")) { stall(); return new Promise<void>(() => {}); }
          return super.flush();
        }
        close() { closed(); super.close(); }
      };
      serveFiles({ video: await sampleFile(120, 30), score: scoreFile() });
      const config = audioProject();
      const settings = defaultExportSettings(config);
      await expect(runExport({ folderPath: AUDIO_FOLDER, config, settings, plan: buildExportPlan(config, settings),
        bitrate: 5_000_000, onProgress: () => {}, cancelled: () => cancelled }).then(() => undefined)).rejects.toBeInstanceOf(ExportCancelled);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(callLog().some((call) => call.cmd.includes("write"))).toBe(false);
    } finally { clearTimeout(timer); harness.restore(); }
  });

  it.each([
    { name: "decoder backpressure", frames: 80, decodeOnFlush: false, layered: false },
    { name: "decoder flush", frames: 9, decodeOnFlush: true, layered: false },
    { name: "layered decoder backpressure", frames: 80, decodeOnFlush: false, layered: true },
  ])("recycles a three-frame hardware pool during $name", async ({ frames, decodeOnFlush, layered }) => {
    const harness = installWebCodecs({ decodes: true, audio: false, decoderPool: 3, decodeOnFlush });
    const instances: VideoDecoder[] = [];
    const Decoder = VideoDecoder;
    vi.stubGlobal("VideoDecoder", class extends Decoder {
      constructor(init: VideoDecoderInit) { super(init); instances.push(this); }
    });
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      invoked.mockResolvedValue(await sampleFile(frames, 30));
      const config = externalProject();
      const track = config.timeline.tracks.find((track) => track.kind === "video" && track.clips.length)!;
      track.clips[0].durationMs = Math.floor(frames * 1000 / 30);
      if (layered) {
        track.clips[0].look = { opacity: 50, temperature: 0 };
        config.timeline.tracks.push({ ...track, id: "lower", clips: [{ ...track.clips[0], id: "lower-clip", trackId: "lower", look: { opacity: 100, temperature: 0 } }] });
      }
      const settings = defaultExportSettings(config);
      const plan = buildExportPlan(config, settings);
      const run = runExport({ folderPath: FOLDER, config, settings, plan, bitrate: 5_000_000,
        onProgress: () => {}, cancelled: () => cancelled });
      // A hardware pool cannot output again until an earlier frame is closed.
      // Stop the mock on timeout so a regression fails without leaking a run.
      timer = setTimeout(() => { cancelled = true; instances.forEach((decoder) => decoder.close()); }, 5000);
      await expect(run).resolves.toMatchObject({ audio: false });
      expect(harness.recorded.videoChunks).toBe(plan.frameCount);
      expect(harness.recorded.decoderLiveFrames).toBe(0);
      expect(harness.recorded.decoderPeakFrames).toBeLessThanOrEqual(layered ? 6 : 3);
    } finally {
      clearTimeout(timer);
      harness.restore();
    }
  }, 10_000);

  it("refuses to silently omit GPU effects when only canvas compositing is available", async () => {
    const { restore, recorded } = installWebCodecs({ decodes: true, audio: false });
    try {
      invoked.mockResolvedValue(await sampleFile(5, 30));
      const config = externalProject();
      const video = config.timeline.tracks.find((track) => track.kind === "video" && track.clips.length > 0)!;
      video.clips[0].sharpen = { amount: 50 };
      const settings = defaultExportSettings(config);
      await expect(runExport({
        folderPath: FOLDER, config, settings, plan: buildExportPlan(config, settings),
        bitrate: 5_000_000, onProgress: () => {}, cancelled: () => false,
      })).rejects.toThrow(/effects.*require WebGPU/);
      expect(recorded.videoChunks).toBe(0);
      expect(callLog().some((call) => call.cmd.includes("write"))).toBe(false);
    } finally { restore(); }
  });

  it("dispatches the external read, not a project-relative one", async () => {
    const { restore } = installWebCodecs();
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
    const { restore } = installWebCodecs();
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

/* ---------------------------------------------------------------------------
   The sound, actually running.

   Everything above this line is the picture. The audio path had six tests of
   its PLANNING and none of its execution: no AudioEncoder in the harness, no
   audio clips in the fixture, so `mixAudio` had never been called once. These
   run it — from the .wav bytes the IPC layer hands back, through the graph, the
   encoder and into a file that is taken apart again to see the track.

   The mixing numbers below were measured first in headless Chrome against this
   same timeline: 192000 rendered frames in 2 channels, 0.80 at 500 ms where one
   clip plays alone, 1.60 at 1200 ms where two overlap and sum, 0 at 3500 ms
   where nothing covers, and a clamp to 1 at the peak.
   --------------------------------------------------------------------------- */

const AUDIO_FOLDER = "D:\\tmp\\harbour";
const PATHS = {
  video: "D:\\tmp\\harbour\\rush-01.mp4",
  score: "D:\\tmp\\harbour\\score.wav",
  voice: "D:\\tmp\\harbour\\vo-take-3.wav",
};

const audioProject = () => parseProjectConfig(audioFixture);

/** The IPC layer, answering with real files per path. Anything unasked-for
 *  throws, so a read the export should not have made shows up as a failure
 *  rather than as a convenient default. */
function serveFiles(files: Partial<Record<keyof typeof PATHS, ArrayBuffer>>) {
  invoked.mockImplementation(async (_command: string, args: { sourcePath?: string }) => {
    for (const [name, path] of Object.entries(PATHS)) {
      if (args?.sourcePath === path) {
        const bytes = files[name as keyof typeof PATHS];
        if (!bytes) throw new Error(`the test served no ${name}, so this read should not have happened`);
        return bytes;
      }
    }
    throw new Error(`unexpected read of ${String(args?.sourcePath)}`);
  });
}

/** A three-second stereo score at 0.8 of full scale — loud, but not clipping
 *  until two copies of it overlap. */
const scoreFile = () => wavFile({ seconds: 3, sample: () => 0.8 });

async function runAudioExport(
  harness: ReturnType<typeof installWebCodecs>,
  config = audioProject(),
) {
  const settings = defaultExportSettings(config);
  return runExport({
    folderPath: AUDIO_FOLDER,
    config,
    settings,
    plan: buildExportPlan(config, settings),
    bitrate: 5_000_000,
    onProgress: () => {},
    cancelled: () => false,
  }).finally(() => void harness);
}

/** The samples the encoder was actually handed, put back in channel order —
 *  which only works if the planar blocks are laid out the way the muxer and the
 *  encoder expect: all of channel 0, then all of channel 1, per block. */
function encoderChannels(recorded: HarnessRecord): Float32Array[] {
  const total = recorded.audioData.reduce((sum, block) => sum + block.numberOfFrames, 0);
  const channels = [new Float32Array(total), new Float32Array(total)];
  let offset = 0;
  for (const block of recorded.audioData) {
    for (let channel = 0; channel < 2; channel += 1) {
      channels[channel].set(
        block.samples.subarray(channel * block.numberOfFrames, (channel + 1) * block.numberOfFrames),
        offset,
      );
    }
    offset += block.numberOfFrames;
  }
  return channels;
}

/** The sample index of a moment in the finished soundtrack. */
const at = (ms: number) => Math.round((ms / 1000) * 48_000);

/** The audio track of a finished file, read back out of the muxed bytes with
 *  mp4box — the same demuxer a player uses, not the muxer's own bookkeeping. */
async function audioTrackOf(bytes: Uint8Array) {
  const { createFile, MP4BoxBuffer } = await import("mp4box");
  type Movie = import("mp4box").Movie;
  const file = createFile();
  const found: { movie: Movie | null } = { movie: null };
  file.onReady = (info) => {
    found.movie = info;
  };
  const copy = bytes.slice().buffer;
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(copy, 0), true);
  file.flush();
  if (!found.movie) throw new Error("the exported file has no readable MP4 header");
  return { movie: found.movie, track: found.movie.audioTracks[0] ?? null };
}

describe("mixing real sound into a real export", () => {
  it("reads each audio ASSET once, before the file is opened, and never a muted one", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      serveFiles({ video: await sampleFile(120, 30), score: scoreFile() });
      await runAudioExport(harness);

      /* Two clips share one asset, so there is one read for them, not two —
         and the muted voice-over is never fetched at all. The score comes
         FIRST: the mix has to be settled before the muxer can be told whether
         the file has an audio track. */
      expect(callLog()).toEqual([
        { cmd: "read_external_media_file", args: { folderPath: AUDIO_FOLDER, sourcePath: PATHS.score } },
        { cmd: "read_external_media_file", args: { folderPath: AUDIO_FOLDER, sourcePath: PATHS.video } },
      ]);
    } finally {
      harness.restore();
    }
  });

  it("sums overlapping clips and clips the sum flat, saying how far over it went", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      serveFiles({ video: await sampleFile(120, 30), score: scoreFile() });
      const result = await runAudioExport(harness);
      const [left, right] = encoderChannels(harness.recorded);

      // 4 s of picture at 48 kHz, in two channels: the whole soundtrack.
      expect(left).toHaveLength(192_000);
      expect(right).toHaveLength(192_000);
      // One clip alone; two overlapping, summed and then cut to full scale;
      // a stretch no clip covers, which is real silence.
      expect(left[at(500)]).toBeCloseTo(0.8, 4);
      expect(left[at(1200)]).toBe(1);
      expect(right[at(1200)]).toBe(1);
      expect(left[at(2500)]).toBeCloseTo(0.8, 4);
      expect(left[at(3500)]).toBe(0);

      /* The overlap is timeline 1000-2000 ms: 48000 frames in two channels,
         every one of them over full scale. "Limited" would have been the wrong
         word for it — nothing rode the gain down, the tops were cut off. */
      expect(result.audioDetail).toMatch(/peaked at 1\.60 of full scale/);
      // The thousands separator is whatever the running locale uses.
      expect(result.audioDetail).toMatch(/96.?000 samples \(25\.0%\) were clipped flat/);
      expect(result.audioDetail).toMatch(/down by about 4\.1 dB/);
      expect(result.audioDetail).not.toMatch(/limited/i);
      expect(result.audioProblems).toEqual([]);
      expect(result.audioShortfalls).toEqual([]);
    } finally {
      harness.restore();
    }
  });

  it("feeds the encoder f32-planar blocks on a microsecond clock", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      serveFiles({ video: await sampleFile(120, 30), score: scoreFile() });
      await runAudioExport(harness);
      const blocks = harness.recorded.audioData;

      expect(harness.recorded.audioConfig).toEqual({
        codec: "mp4a.40.2",
        sampleRate: 48_000,
        numberOfChannels: 2,
        bitrate: 192_000,
      });
      // 192000 samples in AAC's own 1024-sample frame: 187 full blocks and a
      // 512-sample remainder. A block of 0 would be an encoder error.
      expect(blocks).toHaveLength(188);
      expect(blocks.every((block) => block.format === "f32-planar")).toBe(true);
      expect(blocks.every((block) => block.numberOfChannels === 2)).toBe(true);
      expect(blocks.slice(0, -1).every((block) => block.numberOfFrames === 1024)).toBe(true);
      expect(blocks[blocks.length - 1].numberOfFrames).toBe(512);
      // Each block carries twice its frame count: channel 0 then channel 1.
      expect(blocks.every((block) => block.samples.length === block.numberOfFrames * 2)).toBe(true);

      /* Timestamps are microseconds computed from the sample offset, not
         accumulated — 1024 samples is 21333.33 µs, which no running total in
         integers can hold without drifting. */
      let offset = 0;
      for (const block of blocks) {
        expect(block.timestamp).toBe(Math.round((offset * 1_000_000) / 48_000));
        offset += block.numberOfFrames;
      }
      expect(offset).toBe(192_000);
      expect(blocks[1].timestamp).toBe(21_333);
      expect(blocks[187].timestamp).toBe(3_989_333);
    } finally {
      harness.restore();
    }
  });

  it("puts an AAC track in the file, and the file says so when it is read back", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      serveFiles({ video: await sampleFile(120, 30), score: scoreFile() });
      const result = await runAudioExport(harness);
      expect(result.audio).toBe(true);

      const { movie, track } = await audioTrackOf(result.bytes);
      expect(movie.videoTracks).toHaveLength(1);
      expect(track).not.toBeNull();
      expect(track?.codec).toBe("mp4a.40.2");
      expect(track?.audio?.sample_rate).toBe(48_000);
      expect(track?.audio?.channel_count).toBe(2);
      // One sample per encoded block, all 188 of them in the file.
      expect(track?.nb_samples).toBe(188);
    } finally {
      harness.restore();
    }
  });

  it("opens the file with no audio track at all when this webview cannot encode sound", async () => {
    const harness = installWebCodecs({ decodes: true, audio: false });
    try {
      // The score is deliberately not served: a webview with no AudioEncoder
      // must not read an audio file it has no use for.
      serveFiles({ video: await sampleFile(120, 30) });
      const result = await runAudioExport(harness);

      expect(result.audio).toBe(false);
      expect(result.audioDetail).toMatch(/no WebCodecs AudioEncoder/i);
      const { track } = await audioTrackOf(result.bytes);
      expect(track).toBeNull();
      expect(callLog().map((call) => call.args.sourcePath)).toEqual([PATHS.video]);
    } finally {
      harness.restore();
    }
  });

  it("says a clip outlasted its sound instead of leaving the silence unmentioned", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      /* Both clips ask for 2 s of a file that is only 1.5 s long — the head
         from 0 s in, the reprise from 0.5 s in — so each one runs out early.
         The graph already refused to invent the missing audio; nothing said
         so, which is the whole of this test. */
      serveFiles({ video: await sampleFile(120, 30), score: wavFile({ seconds: 1.5, sample: () => 0.5 }) });
      const result = await runAudioExport(harness);

      expect(result.audio).toBe(true);
      expect(result.audioShortfalls).toEqual([
        "“Score - head” runs for 2.00s but only 1.50s of Score is left from 0.00s in, so its last 0.50s is silence.",
        "“Score - reprise” runs for 2.00s but only 1.00s of Score is left from 0.50s in, so its last 1.00s is silence.",
      ]);
      expect(result.audioDetail).toMatch(/2 clips run past the end of their sound/);
      expect(result.audioProblems).toEqual([]);
      /* Both clips sit at exactly half scale, so where they overlap the sum is
         one 16-bit step over full scale and every sample of it is clamped.
         That is not clipping worth announcing: the message would have advised
         pulling down by "0.0 dB", which is not advice. */
      expect(result.audioDetail).not.toMatch(/clipped/);

      /* And the silence is really there. The head sounds 0-1500 ms of its
         2000 ms; the reprise runs 1000-3000 ms and its sound stops at 2000. */
      const [left] = encoderChannels(harness.recorded);
      expect(left[at(1200)]).toBeCloseTo(1, 4); // head + reprise, both sounding
      expect(left[at(1500)]).toBeCloseTo(0.5, 4); // the head has just run out
      expect(left[at(1900)]).toBeCloseTo(0.5, 4); // reprise alone, still sounding
      expect(left[at(2500)]).toBe(0); // reprise still on the timeline, out of sound
    } finally {
      harness.restore();
    }
  });

  it("plays a clip from where it is trimmed to, and lays a mono file across both channels", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      /* One mono channel whose value IS its position in the file, so where the
         mix reads from is legible in the samples themselves. */
      const ramp = wavFile({
        seconds: 3,
        channels: 1,
        sample: (frame) => (frame / (3 * 48_000)) * 0.5,
      });
      serveFiles({ video: await sampleFile(120, 30), score: ramp });
      await runAudioExport(harness);
      const [left, right] = encoderChannels(harness.recorded);

      /* At 250 ms only "Score - head" plays, untrimmed, so the file is being
         read at 250 ms: 0.25/3 × 0.5. */
      expect(left[at(250)]).toBeCloseTo((0.25 / 3) * 0.5, 4);
      /* At 2500 ms only "Score - reprise" plays, and it is trimmed to start
         500 ms into the file, so the file is at 2000 ms — not 2500. */
      expect(left[at(2500)]).toBeCloseTo((2.0 / 3) * 0.5, 4);
      // A mono source lands on both output channels, as the graph up-mixes it.
      expect(right[at(2500)]).toBeCloseTo(left[at(2500)], 6);
    } finally {
      harness.restore();
    }
  });

  it("names an audio file it could not decode rather than shipping a silent file", async () => {
    const harness = installWebCodecs({ decodes: true });
    try {
      serveFiles({ video: await sampleFile(120, 30), score: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer });
      const result = await runAudioExport(harness);

      expect(result.audio).toBe(false);
      expect(result.audioProblems).toHaveLength(2);
      // Once per clip, but the decode itself was attempted once — the failed
      // promise is cached with the asset, so the file is read a single time.
      expect(result.audioProblems[0]).toMatch(/“Score - head” \(Score\) could not be decoded/);
      expect(result.audioProblems[0]).toMatch(/RIFF\/WAVE/);
      expect(result.audioDetail).toMatch(/none of the audio clips could be decoded/);
      expect(callLog()).toHaveLength(2);
      const { track } = await audioTrackOf(result.bytes);
      expect(track).toBeNull();
    } finally {
      harness.restore();
    }
  });
});

describe("what the mix costs in memory", () => {
  it("is one float per channel per sample, and the plan says so on a long timeline", () => {
    // 4 s: 192000 frames × 2 channels × 4 bytes.
    expect(audioMixBytes(4_000)).toBe(1_536_000);
    // The numbers the review measured: five minutes and an hour.
    expect(audioMixBytes(5 * 60_000)).toBe(115_200_000);
    expect(audioMixBytes(60 * 60_000)).toBe(1_382_400_000);

    const config = audioProject();
    const short = buildExportPlan(config, defaultExportSettings(config));
    expect(short.notes.some((note) => /held in memory|mixed in memory/i.test(note))).toBe(false);

    /* Stretch the same project to twenty minutes and the mix is 461 MB held
       for the length of the render. That is worth a sentence. */
    const long = {
      ...config,
      timeline: {
        tracks: config.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({ ...clip, durationMs: clip.durationMs * 300 })),
        })),
      },
    };
    const plan = buildExportPlan(long, defaultExportSettings(config));
    const note = plan.notes.find((entry) => /mixed in memory/i.test(entry));
    expect(note).toBeDefined();
    expect(note).toMatch(/461 MB/);
    expect(note).toMatch(/20:00\.000/);
    expect(note).toMatch(/three times that/);
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
