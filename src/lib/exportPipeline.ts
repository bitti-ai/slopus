/// <reference types="@webgpu/types" />

/* ============================================================================
   exportPipeline.ts — the five stages CLAUDE.md describes, in order.

     demux (mp4box.js)  ->  decode (WebCodecs VideoDecoder, OS hardware)
     ->  process (WebGPU, importExternalTexture, no readback)
     ->  encode (WebCodecs VideoEncoder)  ->  mux (mp4-muxer)

   No FFmpeg anywhere, deliberately: the whole point of this pipeline is to stay
   clear of GPL/LGPL binaries. The heavy libraries are imported dynamically so
   that neither the tests nor the first paint of the app pay for them.

   What this module will NOT do: pretend. If WebCodecs is missing, if the codec
   is unsupported, if a source file cannot be taken apart — it throws with the
   real reason and the view shows that reason verbatim.
   ========================================================================== */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";
import {
  fitRect,
  outputCodec,
  sourceTimeMsForFrame,
  type ExportPlan,
  type ExportSegment,
  type ExportSettings,
  type OutputCodecId,
} from "./export";
import type { ProjectAsset, ProjectConfig } from "./project";

/* ---------------------------------------------------------------------------
   What this machine can do
   --------------------------------------------------------------------------- */

export interface ExportSupport {
  /** WebCodecs encode. Present in WebView2/Chromium, absent in older engines. */
  encoder: boolean;
  decoder: boolean;
  /** The GPU compositor. Absent is not fatal — there is a 2D canvas fallback. */
  webgpu: boolean;
  /** Only the desktop shell has files to read and a place to write one. */
  desktop: boolean;
}

export function detectExportSupport(): ExportSupport {
  const scope = globalThis as unknown as Record<string, unknown>;
  return {
    encoder: typeof scope.VideoEncoder === "function",
    decoder: typeof scope.VideoDecoder === "function",
    webgpu: typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu),
    desktop: isTauri(),
  };
}

export interface CodecProbe {
  id: OutputCodecId;
  supported: boolean;
  /** The codec string this machine accepted, when it accepted one. */
  codecString: string | null;
  /** Why not, in the encoder's own terms, when it did not. */
  detail: string;
}

function encoderConfig(codecString: string, plan: ExportPlan, bitrate: number): VideoEncoderConfig {
  return {
    codec: codecString,
    width: plan.width,
    height: plan.height,
    bitrate,
    framerate: plan.frameRate,
    // Length-prefixed AVC with the parameter sets in the sample description,
    // which is the only shape mp4-muxer can put in an .mp4.
    avc: { format: "avc" },
  };
}

/** Asks the encoder itself, one candidate codec string at a time. Nothing here
 *  is assumed from the codec name. */
export async function probeCodec(id: OutputCodecId, plan: ExportPlan, bitrate: number): Promise<CodecProbe> {
  const codec = outputCodec(id);
  if (typeof VideoEncoder === "undefined") {
    return { id, supported: false, codecString: null, detail: "This webview has no WebCodecs VideoEncoder." };
  }
  const tried: string[] = [];
  for (const candidate of codec.candidates(plan.width, plan.height, plan.frameRate)) {
    tried.push(candidate);
    try {
      const support = await VideoEncoder.isConfigSupported(encoderConfig(candidate, plan, bitrate));
      if (support.supported) return { id, supported: true, codecString: candidate, detail: candidate };
    } catch (reason) {
      return {
        id,
        supported: false,
        codecString: null,
        detail: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }
  return {
    id,
    supported: false,
    codecString: null,
    detail: `This computer's encoder refused every profile tried at ${plan.width}×${plan.height}: ${tried.join(", ")}.`,
  };
}

export async function probeAllCodecs(plan: ExportPlan, bitrate: number): Promise<CodecProbe[]> {
  return Promise.all((["h264", "vp9", "av1"] as OutputCodecId[]).map((id) => probeCodec(id, plan, bitrate)));
}

/* ---------------------------------------------------------------------------
   Stage 3 — process. WebGPU first, 2D canvas only if the GPU path is missing.
   --------------------------------------------------------------------------- */

export type CompositorKind = "webgpu" | "canvas2d";

interface Compositor {
  readonly kind: CompositorKind;
  /** Paints the background alone — what a frame with no clip over it looks like. */
  clear(): void;
  /** Paints the background, then the frame scaled to fit inside it. */
  draw(frame: VideoFrame): void;
  /** The composited picture, ready for the encoder. Caller closes it. */
  take(timestampUs: number, durationUs: number): VideoFrame;
  dispose(): void;
}

function parseColor(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return { r: 0, g: 0, b: 0 };
  const value = Number.parseInt(match[1], 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

const COMPOSITOR_SHADER = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// x0, y0, x1, y1 of the fitted picture in clip space.
@group(0) @binding(0) var<uniform> rect: vec4f;
@group(0) @binding(1) var source: texture_external;
@group(0) @binding(2) var source_sampler: sampler;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[index];
  var out: VertexOut;
  out.position = vec4f(mix(rect.x, rect.z, corner.x), mix(rect.y, rect.w, corner.y), 0.0, 1.0);
  out.uv = vec2f(corner.x, 1.0 - corner.y);
  return out;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(source, source_sampler, uv);
}
`;

async function createWebGpuCompositor(width: number, height: number, background: string): Promise<Compositor | null> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const shader = device.createShaderModule({ code: COMPOSITOR_SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: { module: shader, entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  const { r, g, b } = parseColor(background);
  /* The canvas format is not an -srgb one, so the clear value lands in the
     texture as written: the project's own background colour, unconverted. */
  const clearValue = { r: r / 255, g: g / 255, b: b / 255, a: 1 };

  const pass = (view: GPUTextureView, bindGroup: GPUBindGroup | null) => {
    const encoder = device.createCommandEncoder();
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue, loadOp: "clear", storeOp: "store" }],
    });
    if (bindGroup) {
      renderPass.setPipeline(pipeline);
      renderPass.setBindGroup(0, bindGroup);
      renderPass.draw(6);
    }
    renderPass.end();
    device.queue.submit([encoder.finish()]);
  };

  return {
    kind: "webgpu",
    clear() {
      pass(context.getCurrentTexture().createView(), null);
    },
    draw(frame) {
      const box = fitRect(frame.displayWidth, frame.displayHeight, width, height);
      const x0 = (box.x / width) * 2 - 1;
      const x1 = ((box.x + box.width) / width) * 2 - 1;
      const yTop = 1 - (box.y / height) * 2;
      const yBottom = 1 - ((box.y + box.height) / height) * 2;
      device.queue.writeBuffer(uniform, 0, new Float32Array([x0, yBottom, x1, yTop]));
      // Zero copy: the decoded frame is sampled where it already lives.
      const external = device.importExternalTexture({ source: frame });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: external },
          { binding: 2, resource: sampler },
        ],
      });
      pass(context.getCurrentTexture().createView(), bindGroup);
    },
    take(timestamp, duration) {
      return new VideoFrame(canvas, { timestamp, duration, alpha: "discard" });
    },
    dispose() {
      device.destroy();
    },
  };
}

function createCanvasCompositor(width: number, height: number, background: string): Compositor {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("This computer gave no 2D canvas to composite into.");
  const paintBackground = () => {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  };
  return {
    kind: "canvas2d",
    clear: paintBackground,
    draw(frame) {
      paintBackground();
      const box = fitRect(frame.displayWidth, frame.displayHeight, width, height);
      context.drawImage(frame, box.x, box.y, box.width, box.height);
    },
    take(timestamp, duration) {
      return new VideoFrame(canvas, { timestamp, duration, alpha: "discard" });
    },
    dispose() {},
  };
}

/* ---------------------------------------------------------------------------
   Stage 1 — demux
   --------------------------------------------------------------------------- */

interface DemuxedSource {
  config: VideoDecoderConfig;
  samples: Array<{ data: Uint8Array; timestampUs: number; durationUs: number; key: boolean }>;
}

async function readAssetBytes(folderPath: string, asset: ProjectAsset): Promise<ArrayBuffer> {
  if (!isTauri()) {
    throw new Error("Reading project media needs the desktop app; the browser preview has no project folder.");
  }
  return invoke<ArrayBuffer>("read_project_file", { folderPath, relativePath: asset.relativePath });
}

/** Any of the codec configuration boxes. They all serialise themselves the
 *  same way; the declared parameter type is only the stream subclass mp4box
 *  happens to use internally, and `write` touches nothing beyond DataStream. */
type ConfigurationBox = { write(stream: unknown): void };

async function demux(bytes: ArrayBuffer, name: string): Promise<DemuxedSource> {
  const { createFile, DataStream, Endianness, MP4BoxBuffer } = await import("mp4box");
  type Movie = import("mp4box").Movie;
  type Sample = import("mp4box").Sample;
  const file = createFile();
  const raw: Sample[] = [];
  /* Held on an object rather than in `let`s: these are written from callbacks,
     and TypeScript would otherwise narrow them to their initial value. */
  const state: { movie: Movie | null; failure: string | null } = { movie: null, failure: null };

  file.onError = (module, message) => {
    state.failure = `${module}: ${message}`;
  };
  file.onReady = (info) => {
    state.movie = info;
    const track = info.videoTracks[0];
    if (!track) return;
    file.setExtractionOptions(track.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
    file.start();
  };
  file.onSamples = (_id, _user, samples) => {
    for (const sample of samples) raw.push(sample);
  };
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0), true);
  file.flush();

  if (state.failure) throw new Error(`${name} could not be read: ${state.failure}`);
  if (!state.movie) throw new Error(`${name} has no MP4 header PolStudio could parse.`);
  const track = state.movie.videoTracks[0];
  if (!track) throw new Error(`${name} has no video track in it.`);
  if (raw.length === 0) throw new Error(`${name} has a video track with no readable frames in it.`);

  /* The decoder needs the codec's own configuration record (avcC/hvcC/…) byte
     for byte. Ask the parsed box to write itself and drop the 8-byte box
     header, which is exactly what a VideoDecoderConfig description is. */
  let description: Uint8Array | undefined;
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const visual = entry as import("mp4box").VisualSampleEntry;
    const box = (visual.avcC ?? visual.hvcC ?? visual.vpcC ?? visual.av1C) as unknown as ConfigurationBox | undefined;
    if (!box) continue;
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    box.write(stream);
    description = new Uint8Array(stream.buffer.slice(8));
    break;
  }

  const samples = raw.map((sample) => {
    if (!sample.data) throw new Error(`${name} has frames whose data could not be read out of the file.`);
    return {
      data: sample.data,
      timestampUs: Math.round((sample.cts * 1_000_000) / sample.timescale),
      durationUs: Math.round((sample.duration * 1_000_000) / sample.timescale),
      key: sample.is_sync,
    };
  });

  return {
    config: {
      codec: track.codec,
      codedWidth: track.video?.width ?? track.track_width,
      codedHeight: track.video?.height ?? track.track_height,
      ...(description ? { description } : {}),
    },
    samples,
  };
}

/* ---------------------------------------------------------------------------
   The run
   --------------------------------------------------------------------------- */

export type ExportPhase = "preparing" | "rendering" | "finishing" | "writing" | "done";

export interface ExportProgress {
  phase: ExportPhase;
  framesDone: number;
  frameCount: number;
  detail: string;
}

export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled.");
    this.name = "ExportCancelled";
  }
}

export interface ExportResult {
  bytes: Uint8Array;
  compositor: CompositorKind;
  codecString: string;
}

export interface ExportRunOptions {
  folderPath: string;
  config: ProjectConfig;
  settings: ExportSettings;
  plan: ExportPlan;
  bitrate: number;
  onProgress: (progress: ExportProgress) => void;
  /** Polled once per frame. Returning true aborts with `ExportCancelled`. */
  cancelled: () => boolean;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function runExport(options: ExportRunOptions): Promise<ExportResult> {
  const { plan, settings, config, folderPath, bitrate, onProgress, cancelled } = options;
  const support = detectExportSupport();
  if (!support.encoder || !support.decoder) {
    throw new Error("This webview has no WebCodecs VideoEncoder/VideoDecoder, so PolStudio cannot encode video here.");
  }
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
  if (plan.frameCount === 0) throw new Error("There is nothing on the timeline to render.");

  const probe = await probeCodec(settings.codec, plan, bitrate);
  if (!probe.supported || !probe.codecString) throw new Error(probe.detail);

  const report = (phase: ExportPhase, framesDone: number, detail: string) =>
    onProgress({ phase, framesDone, frameCount: plan.frameCount, detail });
  const stopIfCancelled = () => {
    if (cancelled()) throw new ExportCancelled();
  };

  report("preparing", 0, "Setting up the encoder…");
  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: outputCodec(settings.codec).muxer,
      width: plan.width,
      height: plan.height,
      frameRate: plan.frameRate,
    },
    fastStart: "in-memory",
  });

  /* On an object because the encoder writes it from its own callback, where
     TypeScript's flow analysis cannot follow the assignment. */
  const encoderFailure: { reason: Error | null } = { reason: null };
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (reason) => {
      encoderFailure.reason = reason instanceof Error ? reason : new Error(String(reason));
    },
  });
  encoder.configure(encoderConfig(probe.codecString, plan, bitrate));

  const compositor =
    (await createWebGpuCompositor(plan.width, plan.height, plan.backgroundColor).catch(() => null)) ??
    createCanvasCompositor(plan.width, plan.height, plan.backgroundColor);

  const frameDurationUs = Math.round(1_000_000 / plan.frameRate);
  /* A keyframe every two seconds. Without them a player cannot seek, and a
     30-minute delta chain is also where quality quietly collapses. */
  const keyFrameInterval = Math.max(1, Math.round(plan.frameRate * 2));
  let framesDone = 0;

  const emit = async (frame: VideoFrame | null, outputIndex: number) => {
    stopIfCancelled();
    if (encoderFailure.reason) throw encoderFailure.reason;
    if (frame) compositor.draw(frame);
    else compositor.clear();
    const composited = compositor.take(outputIndex * frameDurationUs, frameDurationUs);
    encoder.encode(composited, { keyFrame: outputIndex % keyFrameInterval === 0 });
    composited.close();
    framesDone += 1;
    if (framesDone % 5 === 0 || framesDone === plan.frameCount) {
      report("rendering", framesDone, `Rendering frame ${framesDone} of ${plan.frameCount}.`);
    }
    // Yield so the encoder's own queue drains and the window stays alive.
    while (encoder.encodeQueueSize > 8) await tick();
    if (framesDone % 12 === 0) await tick();
  };

  /* One decoded source at a time. Holding every clip's samples would mean
     holding every clip's file, which for 4K footage is gigabytes. Kept on an
     object so the closure below can replace it without TypeScript pinning the
     fields to their initial null. */
  const loaded: {
    assetId: string | null;
    source: DemuxedSource | null;
    image: VideoFrame | null;
    bitmap: ImageBitmap | null;
  } = { assetId: null, source: null, image: null, bitmap: null };

  const releaseLoaded = () => {
    loaded.image?.close();
    loaded.bitmap?.close();
    loaded.image = null;
    loaded.bitmap = null;
    loaded.source = null;
  };

  const assetFor = (assetId: string) => config.assets.find((asset) => asset.id === assetId);

  const loadAsset = async (asset: ProjectAsset) => {
    if (loaded.assetId === asset.id) return;
    releaseLoaded();
    loaded.assetId = asset.id;
    report("rendering", framesDone, `Reading ${asset.name}…`);
    const bytes = await readAssetBytes(folderPath, asset);
    if (asset.mimeType.startsWith("image/")) {
      /* The bitmap stays alive as long as the frame made from it does: a
         VideoFrame built from a CanvasImageSource is not guaranteed to own a
         copy of the pixels. */
      loaded.bitmap = await createImageBitmap(new Blob([bytes], { type: asset.mimeType }));
      loaded.image = new VideoFrame(loaded.bitmap, { timestamp: 0 });
      return;
    }
    loaded.source = await demux(bytes, asset.name);
  };

  const renderClipSegment = async (segment: Extract<ExportSegment, { kind: "clip" }>) => {
    const asset = assetFor(segment.assetId);
    if (!asset) throw new Error(`Clip “${segment.label}” points at media that is not in this project.`);
    await loadAsset(asset);

    const still = loaded.image;
    if (still) {
      for (let index = segment.startFrame; index < segment.endFrame; index += 1) await emit(still, index);
      return;
    }
    const source = loaded.source;
    if (!source) throw new Error(`${asset.name} produced no decodable video.`);

    const startUs = sourceTimeMsForFrame(segment, segment.startFrame, plan.frameRate) * 1000;
    const endUs = sourceTimeMsForFrame(segment, segment.endFrame - 1, plan.frameRate) * 1000;
    /* Decoding has to begin at the keyframe at or before the trim point: a
       delta frame on its own decodes to garbage. Everything decoded before the
       trim point is fed to the decoder and then thrown away, never shown.

       Samples are in DECODE order, so their timestamps are not monotonic once a
       file uses B-frames. Hence a scan for the best keyframe rather than a
       break on the first late sample, and a margin past the last wanted frame. */
    let first = 0;
    let keyframeUs = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < source.samples.length; index += 1) {
      const sample = source.samples[index];
      if (sample.key && sample.timestampUs <= startUs && sample.timestampUs > keyframeUs) {
        keyframeUs = sample.timestampUs;
        first = index;
      }
    }
    const REORDER_MARGIN = 8;
    let last = source.samples.length - 1;
    for (let index = first; index < source.samples.length; index += 1) {
      if (source.samples[index].timestampUs > endUs) {
        last = Math.min(source.samples.length - 1, index + REORDER_MARGIN);
        break;
      }
    }

    let nextOutput = segment.startFrame;
    /* The frame currently on screen. On an object for the same reason as the
       failure below: it is replaced inside `drain`, and the cleanup that has to
       close it lives outside. */
    const on: { screen: VideoFrame | null } = { screen: null };
    const failure: { reason: Error | null } = { reason: null };
    const wantUs = (index: number) => sourceTimeMsForFrame(segment, index, plan.frameRate) * 1000;

    const pending: VideoFrame[] = [];
    const decoder = new VideoDecoder({
      output: (frame) => pending.push(frame),
      error: (reason) => {
        failure.reason = reason instanceof Error ? reason : new Error(String(reason));
      },
    });
    decoder.configure(source.config);

    /* Frames arrive in presentation order, so the frame showing at output time
       W is the last one whose timestamp is at or before W. Each decoded frame
       therefore settles the output frames that came before IT, and the source
       is only released once its successor has arrived. */
    const drain = async (final: boolean) => {
      while (pending.length > 0) {
        const frame = pending.shift() as VideoFrame;
        if (on.screen) {
          while (nextOutput < segment.endFrame && wantUs(nextOutput) < frame.timestamp) {
            await emit(on.screen, nextOutput);
            nextOutput += 1;
          }
          on.screen.close();
        }
        on.screen = frame;
        if (nextOutput >= segment.endFrame) break;
      }
      if (final) {
        if (!on.screen && nextOutput < segment.endFrame) {
          throw new Error(`${asset.name} decoded no frames, so clip “${segment.label}” has no picture to export.`);
        }
        while (nextOutput < segment.endFrame) {
          await emit(on.screen, nextOutput);
          nextOutput += 1;
        }
      }
    };

    try {
      for (let index = first; index <= last && nextOutput < segment.endFrame; index += 1) {
        if (failure.reason) throw failure.reason;
        const sample = source.samples[index];
        decoder.decode(
          new EncodedVideoChunk({
            type: sample.key ? "key" : "delta",
            timestamp: sample.timestampUs,
            duration: sample.durationUs,
            data: sample.data,
          }),
        );
        while (decoder.decodeQueueSize > 12) await tick();
        await drain(false);
      }
      if (nextOutput < segment.endFrame) {
        await decoder.flush();
        await drain(false);
      }
      if (failure.reason) throw failure.reason;
      await drain(true);
    } finally {
      on.screen?.close();
      for (const frame of pending) frame.close();
      if (decoder.state !== "closed") decoder.close();
    }
  };

  try {
    for (const segment of plan.segments) {
      stopIfCancelled();
      if (segment.kind === "gap") {
        for (let index = segment.startFrame; index < segment.endFrame; index += 1) await emit(null, index);
      } else {
        await renderClipSegment(segment);
      }
    }

    report("finishing", framesDone, "Flushing the encoder and writing the MP4 index…");
    await encoder.flush();
    if (encoderFailure.reason) throw encoderFailure.reason;
    muxer.finalize();
    report("done", framesDone, "Encoded.");
    return {
      bytes: new Uint8Array(target.buffer),
      compositor: compositor.kind,
      codecString: probe.codecString,
    };
  } finally {
    releaseLoaded();
    if (encoder.state !== "closed") encoder.close();
    compositor.dispose();
  }
}

/* ---------------------------------------------------------------------------
   Saving the result
   --------------------------------------------------------------------------- */

/** The OS save dialog, run in Rust. Null means the user cancelled. */
export async function chooseExportDestination(suggestedName: string): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("choose_export_destination", { suggestedName });
}

/** Writes the muxed bytes to the chosen path and returns how many landed.
 *  The payload rides as a raw IPC body — a JSON array of numbers for a
 *  100 MB file would be a gigabyte of text. */
export async function writeExportFile(path: string, bytes: Uint8Array): Promise<number> {
  return invoke<number>("write_export_file", bytes, { headers: { "x-export-path": encodeURIComponent(path) } });
}

/* ---------------------------------------------------------------------------
   Preview
   --------------------------------------------------------------------------- */

/** Blob URLs for the project's own media, made once and revoked together.
 *  A leaked blob URL pins the whole file in memory for the life of the page. */
export class PreviewSources {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(private readonly folderPath: string) {}

  url(asset: ProjectAsset): Promise<string> {
    const existing = this.urls.get(asset.id);
    if (existing) return existing;
    const created = readAssetBytes(this.folderPath, asset).then((bytes) =>
      URL.createObjectURL(new Blob([bytes], { type: asset.mimeType })),
    );
    this.urls.set(asset.id, created);
    return created;
  }

  dispose(): void {
    for (const pending of this.urls.values()) {
      void pending.then(URL.revokeObjectURL).catch(() => undefined);
    }
    this.urls.clear();
  }
}

const seeked = (video: HTMLVideoElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    video.addEventListener(event, () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("This file could not be decoded for preview.")), {
      once: true,
    });
  });

/** Draws the frame the export would produce at `timeMs` into `canvas`, using
 *  the same fit and the same background as the encoder. The picture is decoded
 *  from the real file by the webview's own hardware decoder — nothing here is
 *  drawn from imagination, and a source that cannot be read throws. */
export async function drawPreviewFrame(options: {
  canvas: HTMLCanvasElement;
  plan: ExportPlan;
  config: ProjectConfig;
  sources: PreviewSources;
  clip: { assetId: string; sourceTimeMs: number } | null;
}): Promise<void> {
  const { canvas, plan, config, sources, clip } = options;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This computer gave no 2D canvas to preview into.");
  context.fillStyle = plan.backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!clip) return;

  const asset = config.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset) throw new Error("This clip points at media that is not in this project.");
  const url = await sources.url(asset);

  if (asset.mimeType.startsWith("image/")) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const box = fitRect(image.naturalWidth, image.naturalHeight, canvas.width, canvas.height);
    context.drawImage(image, box.x, box.y, box.width, box.height);
    return;
  }

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  try {
    await seeked(video, "loadeddata");
    const target = Math.max(0, clip.sourceTimeMs / 1000);
    if (target > 0 && Number.isFinite(video.duration)) {
      const landed = seeked(video, "seeked");
      video.currentTime = Math.min(target, Math.max(0, video.duration - 1 / plan.frameRate));
      await landed;
    }
    const box = fitRect(video.videoWidth, video.videoHeight, canvas.width, canvas.height);
    context.drawImage(video, box.x, box.y, box.width, box.height);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
