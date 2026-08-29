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
import { isTauri, readMediaFileBytes } from "./persistence";
import {
  AUDIO_CHANNELS,
  AUDIO_SAMPLE_RATE,
  clipFrameStyle,
  fitRect,
  outputCodec,
  sourceTimeMsForFrame,
  type AudioSegment,
  type ClipFrameStyle,
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
  /** WebCodecs AudioEncoder plus an OfflineAudioContext to mix into it. Without
   *  both, the file is video only and the page says so. */
  audio: boolean;
  /** `navigator.gpu` EXISTS. That is all this says, and it is not enough to
   *  promise a GPU compositor: on a VM, over RDP, on a blocklisted driver, the
   *  object is there and `requestAdapter()` still returns null. Ask
   *  `probeCompositor()` — which does request an adapter — before telling a
   *  user which compositor will run. */
  webgpuApi: boolean;
  /** Only the desktop shell has files to read and a place to write one. */
  desktop: boolean;
}

export function detectExportSupport(): ExportSupport {
  const scope = globalThis as unknown as Record<string, unknown>;
  return {
    encoder: typeof scope.VideoEncoder === "function",
    decoder: typeof scope.VideoDecoder === "function",
    audio:
      typeof scope.AudioEncoder === "function" &&
      typeof scope.AudioData === "function" &&
      typeof scope.OfflineAudioContext === "function",
    webgpuApi: typeof navigator !== "undefined" && "gpu" in navigator && Boolean(navigator.gpu),
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
  draw(frame: VideoFrame, style: ClipFrameStyle): void;
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

// x0, y0, x1, y1 of the fitted and transformed picture in clip space.
@group(0) @binding(0) var<uniform> rect: vec4f;
// rotation, opacity, temperature, reveal start / reveal end.
struct Style {
  primary: vec4f,
  secondary: vec4f,
};
@group(0) @binding(1) var<uniform> style: Style;
@group(0) @binding(2) var source: texture_external;
@group(0) @binding(3) var source_sampler: sampler;

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[index];
  var out: VertexOut;
  let centre = vec2f((rect.x + rect.z) * 0.5, (rect.y + rect.w) * 0.5);
  let point = vec2f(mix(rect.x, rect.z, corner.x), mix(rect.y, rect.w, corner.y));
  let delta = point - centre;
  let angle = style.primary.x;
  let rotated = vec2f(
    delta.x * cos(angle) - delta.y * sin(angle),
    delta.x * sin(angle) + delta.y * cos(angle),
  );
  out.position = vec4f(centre + rotated, 0.0, 1.0);
  out.uv = vec2f(corner.x, 1.0 - corner.y);
  return out;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  if (uv.x < style.primary.w || uv.x > style.secondary.x) { discard; }
  let sampled = textureSampleBaseClampToEdge(source, source_sampler, uv);
  let temperature = style.primary.z;
  let rgb = clamp(sampled.rgb + vec3f(temperature * 0.1, 0.0, -temperature * 0.1), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb, sampled.a * style.primary.y);
}
`;

/** Either a working GPU compositor, or the reason there is none. Never a bare
 *  null: "WebGPU was unavailable" with no cause is what the last round shipped,
 *  and it is unactionable. */
type GpuAttempt = { compositor: Compositor; reason: null } | { compositor: null; reason: string };

const NO_GPU_API = "This webview exposes no navigator.gpu at all.";
const NO_ADAPTER =
  "navigator.gpu exists but requestAdapter() returned no adapter — the usual causes are a virtual machine, an RDP session, or a driver on Chromium's blocklist.";

async function createWebGpuCompositor(width: number, height: number, background: string): Promise<GpuAttempt> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    return { compositor: null, reason: NO_GPU_API };
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return { compositor: null, reason: NO_ADAPTER };
  const device = await adapter.requestDevice();
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("webgpu");
  if (!context) {
    device.destroy();
    return { compositor: null, reason: "This computer gave no WebGPU context for an OffscreenCanvas." };
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const shader = device.createShaderModule({ code: COMPOSITOR_SHADER });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vs" },
    fragment: {
      module: shader,
      entryPoint: "fs",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const styleUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
  /* A device that dies mid-export would keep handing back an untouched canvas,
     which is a black frame that looks like a rendered one. Record the loss and
     refuse to paint another frame instead. */
  const lost: { reason: string | null } = { reason: null };
  void device.lost.then((info) => {
    lost.reason = info.message || String(info.reason);
  });
  device.addEventListener("uncapturederror", (event) => {
    const detail = (event as GPUUncapturedErrorEvent).error;
    lost.reason = detail instanceof Error ? detail.message : String(detail);
  });
  const { r, g, b } = parseColor(background);
  /* The canvas format is not an -srgb one, so the clear value lands in the
     texture as written: the project's own background colour, unconverted. */
  const clearValue = { r: r / 255, g: g / 255, b: b / 255, a: 1 };

  const pass = (view: GPUTextureView, bindGroup: GPUBindGroup | null) => {
    if (lost.reason) throw new Error(`This computer's GPU stopped responding during the export: ${lost.reason}`);
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

  const compositor: Compositor = {
    kind: "webgpu",
    clear() {
      pass(context.getCurrentTexture().createView(), null);
    },
    draw(frame, style) {
      const fitted = fitRect(frame.displayWidth, frame.displayHeight, width, height);
      const scale = style.transform.scale / 100;
      const box = {
        width: fitted.width * scale,
        height: fitted.height * scale,
        x: fitted.x + (fitted.width * (1 - scale)) / 2 + (style.transform.positionX / 100) * width,
        y: fitted.y + (fitted.height * (1 - scale)) / 2 + (style.transform.positionY / 100) * height,
      };
      const x0 = (box.x / width) * 2 - 1;
      const x1 = ((box.x + box.width) / width) * 2 - 1;
      const yTop = 1 - (box.y / height) * 2;
      const yBottom = 1 - ((box.y + box.height) / height) * 2;
      device.queue.writeBuffer(uniform, 0, new Float32Array([x0, yBottom, x1, yTop]));
      device.queue.writeBuffer(styleUniform, 0, new Float32Array([
        (style.transform.rotation * Math.PI) / 180,
        style.opacity,
        style.look.temperature / 100,
        style.revealStart,
        style.revealEnd,
        0,
        0,
        0,
      ]));
      // Zero copy: the decoded frame is sampled where it already lives.
      const external = device.importExternalTexture({ source: frame });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: { buffer: styleUniform } },
          { binding: 2, resource: external },
          { binding: 3, resource: sampler },
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
  return { compositor, reason: null };
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
    draw(frame, style) {
      paintBackground();
      const fitted = fitRect(frame.displayWidth, frame.displayHeight, width, height);
      const scale = style.transform.scale / 100;
      const drawWidth = fitted.width * scale;
      const drawHeight = fitted.height * scale;
      const centreX = fitted.x + fitted.width / 2 + (style.transform.positionX / 100) * width;
      const centreY = fitted.y + fitted.height / 2 + (style.transform.positionY / 100) * height;
      const warmth = style.look.temperature / 100;
      context.save();
      context.beginPath();
      context.rect(style.revealStart * width, 0, (style.revealEnd - style.revealStart) * width, height);
      context.clip();
      context.globalAlpha = style.opacity;
      context.filter = warmth === 0
        ? "none"
        : `sepia(${Math.abs(warmth) * 0.22}) saturate(${1 + Math.abs(warmth) * 0.3}) hue-rotate(${warmth > 0 ? -8 : 172}deg)`;
      context.translate(centreX, centreY);
      context.rotate((style.transform.rotation * Math.PI) / 180);
      context.drawImage(frame, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      context.restore();
    },
    take(timestamp, duration) {
      return new VideoFrame(canvas, { timestamp, duration, alpha: "discard" });
    },
    dispose() {},
  };
}

export interface CompositorProbe {
  /** Which compositor an export started right now would actually use. */
  kind: CompositorKind;
  /** Why, in this machine's own terms. For canvas2d that is the reason the GPU
   *  path is out; for webgpu it is what the adapter calls itself. */
  detail: string;
}

/** Asks the GPU for an adapter, exactly as the export will.
 *
 *  `navigator.gpu` being present is not the same question, and it was the wrong
 *  one to put in front of a user: measured on one ordinary machine, the object
 *  was there, `requestAdapter()` returned null, and the run composited on a 2D
 *  canvas while the page had already promised WebGPU. This asks what the export
 *  asks, and the answer is what the page is allowed to claim. */
export async function probeCompositor(): Promise<CompositorProbe> {
  if (typeof navigator === "undefined" || !("gpu" in navigator) || !navigator.gpu) {
    return { kind: "canvas2d", detail: NO_GPU_API };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { kind: "canvas2d", detail: NO_ADAPTER };
    /* Nothing is kept: this adapter is dropped here and the export requests its
       own. The probe is a question, not a reservation. */
    const info: GPUAdapterInfo | undefined = adapter.info;
    const named = [info?.description, info?.device, info?.vendor, info?.architecture]
      .filter((part) => Boolean(part))
      .join(" ")
      .trim();
    return { kind: "webgpu", detail: named ? `GPU adapter: ${named}.` : "This computer offered a GPU adapter." };
  } catch (reason) {
    return {
      kind: "canvas2d",
      detail: `Asking this computer for a GPU adapter failed: ${reason instanceof Error ? reason.message : String(reason)}`,
    };
  }
}

/* ---------------------------------------------------------------------------
   Stage 1 — demux
   --------------------------------------------------------------------------- */

export interface DemuxedSource {
  config: VideoDecoderConfig;
  samples: Array<{ data: Uint8Array; timestampUs: number; durationUs: number; key: boolean }>;
}

/** The asset's file, wherever the project actually keeps it.
 *
 *  This MUST stay routed through `readMediaFileBytes`. Reading
 *  `asset.relativePath` here directly is what broke every real export: since
 *  media stopped being copied into the project folder, imported video and audio
 *  carry an absolute `sourcePath` and a null `relativePath`, so the old call
 *  handed `read_project_file` a null where Rust declares a String and died at
 *  IPC argument deserialisation — after the page had shown a clean plan and a
 *  live Export button. */
async function readAssetBytes(folderPath: string, asset: ProjectAsset): Promise<ArrayBuffer> {
  if (!asset.sourcePath && !asset.relativePath) {
    throw new Error(`${asset.name} records no file at all, so there is nothing to read for this clip.`);
  }
  return readMediaFileBytes(folderPath, asset);
}

/** Any of the codec configuration boxes. They all serialise themselves the
 *  same way; the declared parameter type is only the stream subclass mp4box
 *  happens to use internally, and `write` touches nothing beyond DataStream. */
type ConfigurationBox = { write(stream: unknown): void };

/** Stage 1 on its own, exported so it can be tested against a real ISOBMFF
 *  file without a GPU or a WebCodecs implementation in the room. */
export async function demux(bytes: ArrayBuffer, name: string): Promise<DemuxedSource> {
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
  /* A file that is not ISOBMFF at all does not reach onError — the parser
     throws from inside appendBuffer with a message about DataView offsets,
     which on its own tells nobody which file went wrong. */
  try {
    file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes, 0), true);
    file.flush();
  } catch (reason) {
    throw new Error(`${name} could not be read: ${reason instanceof Error ? reason.message : String(reason)}`);
  }

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
   Sound — the same five stages, on the other kind of track.

   Decode: the webview's own audio decoders, reached through
   `decodeAudioData`. That is deliberate. mp4box takes ISOBMFF apart and nothing
   else, and audio arrives as .wav, .mp3, .m4a and .flac far more often than as
   .mp4 — routing it through AudioDecoder would mean writing a demuxer per
   container to reach decoders the engine already exposes. Same hardware, same
   no-FFmpeg rule.

   Mix: an OfflineAudioContext, one buffer source per clip, started at the
   clip's own position with its own trim. Overlapping clips SUM, which is what
   two faders up on a desk do; stretches no clip covers render as the silence
   they already are; and sources at another sample rate are resampled by the
   graph rather than by arithmetic here.

   Encode and mux: AudioEncoder to AAC, into the same mp4-muxer file as the
   picture.
   --------------------------------------------------------------------------- */

/* AUDIO_SAMPLE_RATE and AUDIO_CHANNELS live in export.ts, with the arithmetic
   that lets the page state what the mix will cost in memory before it runs. */
const AUDIO_BITRATE = 192_000;
/* AAC-LC. Not Opus: mp4-muxer will put Opus in an .mp4 and a large share of
   players will then refuse the file, which is a worse outcome than a stated
   absence of sound. */
const AUDIO_CODEC = "mp4a.40.2";
/** One AAC frame is 1024 samples; feeding the encoder in that unit keeps every
 *  packet full and the timestamps exact. */
const AUDIO_BLOCK = 1024;

export interface AudioMix {
  /** One Float32Array per channel at AUDIO_SAMPLE_RATE, already clipped. */
  channels: Float32Array[];
  frames: number;
  /** Clips that are in the mix. */
  used: number;
  /** Clips that are NOT, each named with the reason. Never silently dropped. */
  problems: string[];
  /** Clips that ARE in the mix but whose source file ran out before the clip
   *  did, so part of them is silence. The graph already refuses to invent the
   *  missing audio; this is the sentence that says it happened. */
  shortfalls: string[];
  /** How many samples the sum drove past full scale, and were therefore hard
   *  clipped to ±1. Not "limited": no gain was ridden, the tops were cut off. */
  clippedSamples: number;
  /** The loudest magnitude the sum reached BEFORE clipping. 1.6 means the mix
   *  was 4 dB over and says how much has to come down. */
  peak: number;
}

/** How far over full scale the mix has to go before clipping is worth a
 *  sentence: a tenth of a decibel.
 *
 *  Not an arbitrary tolerance. Measured in Chrome: 16384 decodes as
 *  0.500015258789 — close to `value / 32767.5` but not equal to it, so take the
 *  number and not the formula — and two clips sitting at exactly half scale sum
 *  to 1.0000305, one 16-bit step over. The old code called that "clipped"
 *  for every sample of the overlap while advising the user to pull down by
 *  "0.0 dB". Below a tenth of a decibel the advice this message gives rounds
 *  to nothing and the overshoot is 90 dB under the signal. The samples are
 *  still clamped, because the encoder needs them in range; what changes is
 *  that a hair over full scale is no longer announced as damage. */
const CLIPPING_WORTH_SAYING = 10 ** (0.1 / 20);

/** Decodes and mixes every audio segment in the plan into one stereo buffer.
 *  Null when the plan has no sound in it at all. */
async function mixAudio(options: {
  folderPath: string;
  config: ProjectConfig;
  segments: AudioSegment[];
  durationMs: number;
  report: (detail: string) => void;
}): Promise<AudioMix | null> {
  const { folderPath, config, segments, durationMs, report } = options;
  const frames = Math.floor((durationMs / 1000) * AUDIO_SAMPLE_RATE);
  if (segments.length === 0 || frames <= 0) return null;

  const context = new OfflineAudioContext({
    numberOfChannels: AUDIO_CHANNELS,
    length: frames,
    sampleRate: AUDIO_SAMPLE_RATE,
  });

  /* One decode per ASSET, not per clip: the same music file cut into six pieces
     is one file to read and one decode to pay for. */
  const decoded = new Map<string, Promise<AudioBuffer>>();
  const problems: string[] = [];
  const shortfalls: string[] = [];
  let used = 0;

  for (const segment of segments) {
    const asset = config.assets.find((candidate) => candidate.id === segment.assetId);
    if (!asset) {
      problems.push(`“${segment.label}” points at audio that is not in this project.`);
      continue;
    }
    let buffer: AudioBuffer;
    try {
      let pending = decoded.get(asset.id);
      if (!pending) {
        report(`Reading ${asset.name}…`);
        /* decodeAudioData DETACHES the buffer it is given, so the read result is
           copied first — the same bytes may be wanted again by the picture. */
        pending = readAssetBytes(folderPath, asset).then((bytes) => context.decodeAudioData(bytes.slice(0)));
        decoded.set(asset.id, pending);
      }
      buffer = await pending;
    } catch (reason) {
      // Named, not swallowed. A soundtrack that vanished without a word is the
      // failure this whole branch exists to avoid.
      problems.push(
        `“${segment.label}” (${asset.name}) could not be decoded by this computer: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      continue;
    }
    const offsetSeconds = segment.sourceStartMs / 1000;
    if (offsetSeconds >= buffer.duration) {
      problems.push(
        `“${segment.label}” is trimmed to start ${offsetSeconds.toFixed(2)}s into ${asset.name}, which is only ${buffer.duration.toFixed(2)}s long, so it has nothing to play.`,
      );
      continue;
    }
    /* A clip can be longer than what is left of its file — drop a five second
       stand-in onto a two second recording and three seconds of it have no
       sound behind them. The graph plays what exists and no more, which is
       right; what was missing was anyone saying so. Below a millisecond this is
       rounding between a millisecond timeline and a 48 kHz buffer, not a hole. */
    const wantedSeconds = segment.durationMs / 1000;
    const availableSeconds = buffer.duration - offsetSeconds;
    const playSeconds = Math.min(wantedSeconds, availableSeconds);
    if (wantedSeconds - availableSeconds > 0.001) {
      shortfalls.push(
        `“${segment.label}” runs for ${wantedSeconds.toFixed(2)}s but only ${availableSeconds.toFixed(2)}s of ${asset.name} is left from ${offsetSeconds.toFixed(2)}s in, so its last ${(wantedSeconds - availableSeconds).toFixed(2)}s is silence.`,
      );
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start(segment.startMs / 1000, offsetSeconds, playSeconds);
    used += 1;
  }

  if (used === 0) {
    return { channels: [], frames: 0, used: 0, problems, shortfalls, clippedSamples: 0, peak: 0 };
  }

  report(`Mixing ${used} audio ${used === 1 ? "clip" : "clips"}…`);
  const rendered = await context.startRendering();
  const channels: Float32Array[] = [];
  let clippedSamples = 0;
  let peak = 0;
  for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
    const data = rendered.getChannelData(Math.min(channel, rendered.numberOfChannels - 1)).slice();
    /* Summed clips can exceed full scale. Left alone, the encoder wraps them
       into a crackle; cut to ±1, they are flat-topped — which is CLIPPING, and
       is called that here and on the page. It is deliberately not a limiter: a
       limiter rides the gain of the whole mix over an attack and a release the
       user never chose, and quietly reshaping someone's soundtrack is a worse
       failure than a labelled one. What is reported instead is the measurement
       a limiter would need anyway — how far over, and how much of it — so the
       fix is to pull a fader down by a known amount. */
    for (let index = 0; index < data.length; index += 1) {
      const value = data[index];
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 1) {
        data[index] = value > 0 ? 1 : -1;
        clippedSamples += 1;
      }
    }
    channels.push(data);
  }
  return { channels, frames: rendered.length, used, problems, shortfalls, clippedSamples, peak };
}

/** Whether this computer will encode AAC at all, asked of the encoder. */
async function probeAudioCodec(): Promise<{ supported: boolean; detail: string }> {
  if (typeof AudioEncoder === "undefined") {
    return { supported: false, detail: "This webview has no WebCodecs AudioEncoder." };
  }
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: AUDIO_CODEC,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
    });
    return support.supported
      ? { supported: true, detail: `${AUDIO_CODEC} at ${AUDIO_SAMPLE_RATE / 1000} kHz stereo, ${AUDIO_BITRATE / 1000} kbit/s` }
      : { supported: false, detail: `This computer's encoder refused AAC (${AUDIO_CODEC}) at 48 kHz stereo.` };
  } catch (reason) {
    return { supported: false, detail: reason instanceof Error ? reason.message : String(reason) };
  }
}

/** Feeds the mixed buffer to the AAC encoder and the encoder's packets to the
 *  muxer. Returns once every packet is in the file. */
async function encodeAudio(
  mix: AudioMix,
  add: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
): Promise<void> {
  const failure: { reason: Error | null } = { reason: null };
  const encoder = new AudioEncoder({
    output: (chunk, meta) => add(chunk, meta),
    error: (reason) => {
      failure.reason = reason instanceof Error ? reason : new Error(String(reason));
    },
  });
  encoder.configure({
    codec: AUDIO_CODEC,
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  });
  try {
    for (let offset = 0; offset < mix.frames; offset += AUDIO_BLOCK) {
      if (failure.reason) throw failure.reason;
      const count = Math.min(AUDIO_BLOCK, mix.frames - offset);
      // f32-planar: channel 0 then channel 1, exactly as the mix holds them.
      const planar = new Float32Array(count * AUDIO_CHANNELS);
      for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
        planar.set(mix.channels[channel].subarray(offset, offset + count), channel * count);
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfFrames: count,
        numberOfChannels: AUDIO_CHANNELS,
        timestamp: Math.round((offset * 1_000_000) / AUDIO_SAMPLE_RATE),
        data: planar,
      });
      encoder.encode(data);
      data.close();
      while (encoder.encodeQueueSize > 16) await tick();
    }
    await encoder.flush();
    if (failure.reason) throw failure.reason;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

/* ---------------------------------------------------------------------------
   The run
   --------------------------------------------------------------------------- */

export type ExportPhase = "preparing" | "mixing" | "rendering" | "finishing" | "writing" | "done";

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
  /** Why that one. When the GPU compositor did not run, this is the reason it
   *  did not — the previous version reported only WHICH compositor ran, which
   *  told nobody what to fix. */
  compositorDetail: string;
  codecString: string;
  /** True when an AAC track went into the file. */
  audio: boolean;
  /** What the sound is, or why there is none. Always populated. */
  audioDetail: string;
  /** Audio clips that were left out, each named with its reason. Empty on a
   *  clean run; never a silent omission. */
  audioProblems: string[];
  /** Audio clips that ARE in the file but ran out of sound before they ran out
   *  of clip. The silence is real and it is now named. */
  audioShortfalls: string[];
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

/** One sentence about the sound in the finished file, true in every case —
 *  including the cases where there is none. */
function describeSoundtrack(
  plan: ExportPlan,
  support: ExportSupport,
  probe: { supported: boolean; detail: string } | null,
  mix: AudioMix | null,
  soundtrack: AudioMix | null,
): string {
  if (plan.audio.length === 0) return "No sound: there are no audio clips inside the length of the picture.";
  if (!support.audio) return "No sound: this webview has no WebCodecs AudioEncoder to make an audio track with.";
  if (probe && !probe.supported) return `No sound: ${probe.detail}`;
  if (!soundtrack) {
    return mix && mix.problems.length > 0
      ? "No sound: none of the audio clips could be decoded — see below."
      : "No sound: the mix came out empty.";
  }
  const parts = [
    `${soundtrack.used} audio ${soundtrack.used === 1 ? "clip" : "clips"} mixed to ${probe?.detail ?? AUDIO_CODEC}`,
  ];
  if (soundtrack.clippedSamples > 0 && soundtrack.peak > CLIPPING_WORTH_SAYING) {
    const share = (soundtrack.clippedSamples / (soundtrack.frames * AUDIO_CHANNELS)) * 100;
    parts.push(
      `the mix peaked at ${soundtrack.peak.toFixed(2)} of full scale and ${soundtrack.clippedSamples.toLocaleString()} samples (${share.toFixed(share < 0.1 ? 3 : 1)}%) were clipped flat — pull the overlapping clips down by about ${(20 * Math.log10(soundtrack.peak)).toFixed(1)} dB to avoid it`,
    );
  }
  if (soundtrack.shortfalls.length > 0) {
    parts.push(
      `${soundtrack.shortfalls.length} ${soundtrack.shortfalls.length === 1 ? "clip runs" : "clips run"} past the end of ${soundtrack.shortfalls.length === 1 ? "its" : "their"} sound — see below`,
    );
  }
  if (soundtrack.problems.length > 0) parts.push(`${soundtrack.problems.length} left out — see below`);
  return `${parts.join("; ")}.`;
}

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

  /* Sound is prepared BEFORE the muxer exists, because an .mp4's track list is
     fixed the moment the file is opened: whether there is an audio track is a
     question that has to be answered first, not discovered at the end. */
  report("mixing", 0, "Working out the soundtrack…");
  const audioProbe = plan.audio.length === 0 ? null : await probeAudioCodec();
  const mix =
    audioProbe?.supported && support.audio
      ? await mixAudio({
          folderPath,
          config,
          segments: plan.audio,
          durationMs: plan.durationMs,
          report: (detail) => report("mixing", 0, detail),
        })
      : null;
  const soundtrack = mix && mix.used > 0 && mix.frames > 0 ? mix : null;
  const audioProblems = mix?.problems ?? [];
  const audioShortfalls = mix?.shortfalls ?? [];
  const audioDetail = describeSoundtrack(plan, support, audioProbe, mix, soundtrack);
  stopIfCancelled();

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
    ...(soundtrack
      ? { audio: { codec: "aac" as const, numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE } }
      : {}),
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

  /* WebGPU first, as the pipeline is meant to run — the decoded frame is
     sampled where it already lives. A machine without it, or a GPU that gives
     up part way through, drops to the 2D canvas, which composites the same
     picture on the same geometry. Which one ran is reported, never assumed —
     and so is WHY, because "WebGPU was unavailable" on its own is a sentence
     nobody can act on. */
  const attempt = await createWebGpuCompositor(plan.width, plan.height, plan.backgroundColor).catch(
    (reason: unknown) => ({
      compositor: null,
      reason: `Starting the GPU compositor failed: ${reason instanceof Error ? reason.message : String(reason)}`,
    }),
  );
  const stage: { compositor: Compositor; detail: string } = attempt.compositor
    ? { compositor: attempt.compositor, detail: attempt.reason ?? "" }
    : {
        compositor: createCanvasCompositor(plan.width, plan.height, plan.backgroundColor),
        detail: attempt.reason,
      };
  const paint = (frame: VideoFrame | null, style: ClipFrameStyle | null) => {
    try {
      if (frame && style) stage.compositor.draw(frame, style);
      else stage.compositor.clear();
      return;
    } catch (reason) {
      if (stage.compositor.kind === "canvas2d") throw reason;
      stage.compositor.dispose();
      stage.compositor = createCanvasCompositor(plan.width, plan.height, plan.backgroundColor);
      stage.detail = `The GPU compositor gave out ${framesDone} frames in and the rest was composited on a 2D canvas: ${reason instanceof Error ? reason.message : String(reason)}`;
    }
    if (frame && style) stage.compositor.draw(frame, style);
    else stage.compositor.clear();
  };

  /* Timestamps are computed from the frame index every time rather than
     accumulated, so a rate that does not divide a microsecond evenly (30 fps
     does not) cannot drift the last frame away from the clock. */
  const timestampUs = (index: number) => Math.round((index * 1_000_000) / plan.frameRate);
  /* A keyframe every two seconds. Without them a player cannot seek, and a
     30-minute delta chain is also where quality quietly collapses. */
  const keyFrameInterval = Math.max(1, Math.round(plan.frameRate * 2));
  let framesDone = 0;

  const emit = async (
    frame: VideoFrame | null,
    outputIndex: number,
    segment: Extract<ExportSegment, { kind: "clip" }> | null = null,
  ) => {
    stopIfCancelled();
    if (encoderFailure.reason) throw encoderFailure.reason;
    const timelineMs = (outputIndex * 1000) / plan.frameRate;
    const style = segment ? clipFrameStyle(segment.visual, timelineMs - segment.clipStartMs) : null;
    paint(frame, style);
    const composited = stage.compositor.take(
      timestampUs(outputIndex),
      timestampUs(outputIndex + 1) - timestampUs(outputIndex),
    );
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
      for (let index = segment.startFrame; index < segment.endFrame; index += 1) await emit(still, index, segment);
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
            await emit(on.screen, nextOutput, segment);
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
          await emit(on.screen, nextOutput, segment);
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

    if (soundtrack) {
      report("finishing", framesDone, `Encoding the mixed soundtrack as AAC…`);
      await encodeAudio(soundtrack, (chunk, meta) => muxer.addAudioChunk(chunk, meta));
    }
    report("finishing", framesDone, "Flushing the encoder and writing the MP4 index…");
    await encoder.flush();
    if (encoderFailure.reason) throw encoderFailure.reason;
    muxer.finalize();
    report("done", framesDone, "Encoded.");
    return {
      bytes: new Uint8Array(target.buffer),
      compositor: stage.compositor.kind,
      compositorDetail: stage.detail,
      codecString: probe.codecString,
      audio: Boolean(soundtrack),
      audioDetail,
      audioProblems,
      audioShortfalls,
    };
  } finally {
    releaseLoaded();
    if (encoder.state !== "closed") encoder.close();
    stage.compositor.dispose();
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
