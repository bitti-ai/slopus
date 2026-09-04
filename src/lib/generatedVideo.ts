import { invoke } from "@tauri-apps/api/core";
import { writeDiagnostic } from "./diagnostics";
import { bitrateFor, outputCodec } from "./export";
import { isTauri } from "./persistence";
import { TIMELINE_THUMBNAIL_INTERVAL_MS, writeTimelineThumbnail } from "./timelineThumbnails";

/* Turning a finished render into a file in the project folder.
 *
 * vidfab makes pictures, not files: it hands Rust raw frames and raw audio and
 * frees them. Encoding is this side's job — WebCodecs owns the machine's
 * hardware encoder and PolStudio ships no FFmpeg by design (CLAUDE.md) — so a
 * saved scene is a round trip:
 *
 *   Rust holds the frames  →  this reads them one at a time  →  WebCodecs
 *   encodes  →  mp4-muxer muxes  →  Rust writes the .mp4 into the project.
 *
 * The frames are pulled ONE AT A TIME rather than in a single read, because a
 * whole render is hundreds of megabytes and the encoder only ever wants the
 * next one. What is held in memory here is one frame plus whatever the encoder
 * has not yet drained.
 *
 * Nothing here invents a fallback. A machine with no VideoEncoder cannot save a
 * scene, and this says so rather than writing something that is not a video. */

/** The shape of a render still waiting in Rust's memory. */
export interface RenderedSummary {
  jobId: string;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  audioChannels: number;
  audioSampleRate: number;
  /** Interleaved samples across every channel. Zero means it rendered silent. */
  audioSamples: number;
}

/** What was written, in the project's own terms. */
export interface SavedGeneration {
  /** The path to record on the job — Rust's own answer, never a guess here. */
  relativePath: string;
  bytes: number;
  /** Null when everything the render produced is in the file. A sentence when
   *  something was left out, so a silent video is never silently silent. */
  note: string | null;
  /** Whether the saved MP4 actually contains an audio stream. */
  hasAudio?: boolean;
}

/** How often a keyframe is written: every two seconds, so the file can be
 *  seeked and a long delta chain cannot quietly cost quality. */
const KEYFRAME_SECONDS = 2;
/** How many frames may be in flight before this stops handing the encoder more.
 *  Each one is a full picture, so an unbounded queue is an unbounded heap. */
const ENCODE_QUEUE_LIMIT = 8;
const AUDIO_BLOCK = 1024;
const AUDIO_CODEC = "mp4a.40.2";
const AUDIO_BITRATE = 192_000;
/** Generated footage is a MASTER, not a delivery file: it is what every later
 *  export is cut from, so it is encoded at the highest preset the app has. */
const GENERATED_QUALITY = "high" as const;
const TIMELINE_THUMBNAIL_WIDTH = 192;
const TIMELINE_THUMBNAIL_JPEG_QUALITY = 0.82;

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Downsamples one RGBA render frame directly into a small JPEG. Sampling the
 * pixels avoids allocating a second full-resolution canvas merely to shrink
 * it, and this runs only at the timeline cache interval. */
async function timelineThumbnailJpeg(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array | null> {
  try {
    const outputWidth = Math.min(width, TIMELINE_THUMBNAIL_WIDTH);
    const outputHeight = Math.max(1, Math.round(height * outputWidth / width));
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const image = context.createImageData(outputWidth, outputHeight);
    for (let y = 0; y < outputHeight; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor(y * height / outputHeight));
      for (let x = 0; x < outputWidth; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor(x * width / outputWidth));
        const source = (sourceY * width + sourceX) * 4;
        const target = (y * outputWidth + x) * 4;
        image.data[target] = pixels[source];
        image.data[target + 1] = pixels[source + 1];
        image.data[target + 2] = pixels[source + 2];
        image.data[target + 3] = pixels[source + 3];
      }
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", TIMELINE_THUMBNAIL_JPEG_QUALITY));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    // A missing canvas encoder must not cost the user the rendered video. The
    // timeline can build this disposable cache later from the saved MP4.
    return null;
  }
}

/** What Rust still holds for this scene, or null if nothing does. */
export async function renderedSummary(jobId: string): Promise<RenderedSummary | null> {
  if (!isTauri()) return null;
  return invoke<RenderedSummary | null>("generated_summary", { jobId });
}

type IpcBytes = ArrayBuffer | ArrayBufferView | number[];

/** Tauri's raw response is an ArrayBuffer in the desktop webview, while its
 * test/mock transports and some older runtimes expose the same body as a byte
 * array. Normalize both without ever treating byte values as PCM samples. */
export function bytesFromIpc(raw: IpcBytes): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return Uint8Array.from(raw);
}

/** One frame's pixels, RGBA, straight out of the render. */
async function renderedFrame(jobId: string, index: number): Promise<Uint8Array> {
  return bytesFromIpc(await invoke<IpcBytes>("generated_frame", { jobId, index }));
}

/** Turns the raw IPC body into the interleaved samples vidfab produced. */
export function audioSamplesFromIpc(raw: IpcBytes, expectedSamples: number): Float32Array {
  const bytes = bytesFromIpc(raw);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`The render's audio buffer has ${bytes.byteLength} bytes, which is not whole 32-bit PCM.`);
  }
  // Copy the exact view. Constructing Float32Array from Uint8Array would turn
  // each byte into a sample; constructing it from an offset view can also fail
  // alignment. vidfab and Rust both use native little-endian f32 PCM.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const samples = new Float32Array(copy.buffer);
  if (samples.length !== expectedSamples) {
    throw new Error(`The render promised ${expectedSamples} audio samples, but ${samples.length} came back.`);
  }
  return samples;
}

/** The render's soundtrack, interleaved, as Rust holds it. */
async function renderedAudio(jobId: string, expectedSamples: number): Promise<Float32Array> {
  return audioSamplesFromIpc(await invoke<IpcBytes>("generated_audio", { jobId }), expectedSamples);
}

/** Gives the frames back. Called on the way out whether or not a file was
 *  written: a render nobody can encode is still hundreds of megabytes. */
export async function releaseRendered(jobId: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>("release_generated_frames", { jobId }).catch(() => false);
}

/** Writes the muxed bytes into the project folder. The path is Rust's to
 *  decide — this names the scene, not the file. Raw IPC body for the same
 *  reason an export uses one: a JSON array of numbers for a 30 MB file is
 *  hundreds of megabytes of text. */
async function writeGeneratedVideo(folderPath: string, jobId: string, bytes: Uint8Array): Promise<{ relativePath: string; bytes: number }> {
  return invoke<{ relativePath: string; bytes: number }>("write_generated_video", bytes, {
    headers: {
      "x-generated-folder": encodeURIComponent(folderPath),
      "x-generated-job": encodeURIComponent(jobId),
    },
  });
}

/** The codec string this machine actually accepts for this picture, asked of
 *  the encoder rather than assumed from the name. */
async function pickCodec(width: number, height: number, fps: number, bitrate: number): Promise<{ codec: string; tried: string[] }> {
  const tried: string[] = [];
  for (const candidate of outputCodec("h264").candidates(width, height, fps)) {
    tried.push(candidate);
    const config: VideoEncoderConfig = {
      codec: candidate,
      width,
      height,
      bitrate,
      framerate: fps,
      // Length-prefixed AVC with the parameter sets in the sample description,
      // which is the only shape mp4-muxer can put in an .mp4.
      avc: { format: "avc" },
    };
    const support = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (support.supported) return { codec: candidate, tried };
  }
  throw new Error(`This computer's encoder refused every H.264 configuration PolStudio offers (${tried.join(", ")}).`);
}

/** Makes a `VideoFrame` out of raw RGBA.
 *
 *  The buffer constructor is the direct route and what every current Chromium
 *  supports; a webview that refuses it gets the canvas route instead, which
 *  copies the same pixels through an ImageData. Which one is in use is decided
 *  ONCE, on the first frame, so a fallback is not re-tested 360 times. */
function frameFactory(width: number, height: number) {
  let viaCanvas: CanvasRenderingContext2D | null = null;
  const canvasFrame = (pixels: Uint8Array, timestamp: number, duration: number) => {
    if (!viaCanvas) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: false });
      if (!context) throw new Error("This computer gave no 2D canvas to build frames in.");
      viaCanvas = context;
    }
    viaCanvas.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), width, height), 0, 0);
    return new VideoFrame(viaCanvas.canvas, { timestamp, duration, alpha: "discard" });
  };
  let direct = true;
  return (pixels: Uint8Array, timestamp: number, duration: number): VideoFrame => {
    if (direct) {
      try {
        return new VideoFrame(pixels, {
          format: "RGBA",
          codedWidth: width,
          codedHeight: height,
          timestamp,
          duration,
        });
      } catch {
        direct = false;
      }
    }
    return canvasFrame(pixels, timestamp, duration);
  };
}

/** The render's own AAC configuration, or null for a genuinely silent render.
 *  Sound that exists is never quietly omitted from the MP4. */
async function audioConfig(summary: RenderedSummary): Promise<AudioEncoderConfig | null> {
  if (summary.audioSamples === 0) return null;
  if (summary.audioChannels <= 0 || summary.audioSampleRate <= 0 || summary.audioSamples % summary.audioChannels !== 0) {
    throw new Error("The render returned audio with invalid channel or sample-rate metadata.");
  }
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return null;
  for (const sampleRate of [...new Set([summary.audioSampleRate, 48_000, 44_100])]) {
    const config: AudioEncoderConfig = {
      codec: AUDIO_CODEC,
      sampleRate,
      numberOfChannels: summary.audioChannels,
      bitrate: AUDIO_BITRATE,
    };
    const support = await AudioEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (support.supported) return config;
  }
  return null;
}

/** Linear PCM resampling is enough here: vidfab's soundtrack is already the
 * final mix, and this only adapts its rate to an AAC configuration the OS
 * exposes. Channels remain interleaved throughout. */
export function resampleInterleaved(samples: Float32Array, channels: number, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const inputFrames = Math.floor(samples.length / channels);
  const outputFrames = Math.max(1, Math.round(inputFrames * toRate / fromRate));
  const output = new Float32Array(outputFrames * channels);
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const source = Math.min(inputFrames - 1, frame * fromRate / toRate);
    const left = Math.floor(source);
    const right = Math.min(inputFrames - 1, left + 1);
    const mix = source - left;
    for (let channel = 0; channel < channels; channel += 1) {
      const a = samples[left * channels + channel];
      const b = samples[right * channels + channel];
      output[frame * channels + channel] = a + (b - a) * mix;
    }
  }
  return output;
}

/** Feeds the render's interleaved samples to the AAC encoder, in the blocks
 *  AAC works in. */
async function encodeAudio(
  summary: RenderedSummary,
  samples: Float32Array,
  config: AudioEncoderConfig,
  add: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
): Promise<number> {
  const channels = summary.audioChannels;
  const sampleRate = config.sampleRate ?? summary.audioSampleRate;
  const prepared = resampleInterleaved(samples, channels, summary.audioSampleRate, sampleRate);
  const total = Math.floor(prepared.length / channels);
  const failure: { reason: Error | null } = { reason: null };
  let chunks = 0;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => { chunks += 1; add(chunk, meta); },
    error: (reason) => { failure.reason = reason instanceof Error ? reason : new Error(String(reason)); },
  });
  encoder.configure(config);
  try {
    for (let offset = 0; offset < total; offset += AUDIO_BLOCK) {
      if (failure.reason) throw failure.reason;
      const count = Math.min(AUDIO_BLOCK, total - offset);
      // vidfab's C API returns [frame0-L, frame0-R, frame1-L, frame1-R, ...].
      // WebCodecs calls that layout `f32`; `f32-planar` means something else.
      const interleaved = prepared.slice(offset * channels, (offset + count) * channels);
      const data = new AudioData({
        format: "f32",
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset * 1_000_000) / sampleRate),
        data: interleaved,
      });
      encoder.encode(data);
      data.close();
      while (encoder.encodeQueueSize > 16) await tick();
    }
    await encoder.flush();
    if (failure.reason) throw failure.reason;
    if (chunks === 0) throw new Error("The AAC encoder finished without producing a soundtrack.");
    return chunks;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

/**
 * Encodes the render waiting for `jobId` and writes it into the project.
 *
 * Throws if there is nothing to encode, if this computer cannot encode, or if
 * the write fails — every one of which is a sentence the Generator shows. The
 * frames are handed back either way.
 */
export async function saveGeneratedScene(options: {
  folderPath: string;
  jobId: string;
  /** Called as frames go into the encoder, for the progress bar. */
  onProgress?: (encoded: number, total: number) => void;
}): Promise<SavedGeneration> {
  const { folderPath, jobId } = options;
  if (!isTauri()) throw new Error("Saving a rendered scene needs the desktop app.");
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new Error("This webview has no WebCodecs VideoEncoder, so a rendered scene cannot be turned into a video file here.");
  }
  const summary = await renderedSummary(jobId);
  if (!summary) {
    throw new Error("The rendered frames are no longer in memory, so there is nothing to save. Run the scene again.");
  }
  if (summary.frameCount <= 0 || summary.width <= 0 || summary.height <= 0) {
    throw new Error("The render came back with no pictures in it.");
  }
  writeDiagnostic("info", "generated-video", "render.loaded", "Rendered buffers are available for encoding.", {
    jobId, width: summary.width, height: summary.height, frames: summary.frameCount, fps: summary.fps,
    audioChannels: summary.audioChannels, audioSampleRate: summary.audioSampleRate, audioSamples: summary.audioSamples,
  });

  try {
    const fps = summary.fps > 0 ? summary.fps : 24;
    const bitrate = bitrateFor(summary.width, summary.height, fps, GENERATED_QUALITY);
    const { codec } = await pickCodec(summary.width, summary.height, fps, bitrate);
    writeDiagnostic("info", "generated-video", "video_encoder.selected", "WebCodecs accepted a video encoder configuration.", {
      jobId, codec, bitrate, fps, width: summary.width, height: summary.height,
    });
    const sound = await audioConfig(summary);
    const audioChunks: Array<{ chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }> = [];
    let note: string | null = null;
    if (summary.audioSamples > 0) {
      if (sound) {
        try {
          await encodeAudio(summary, await renderedAudio(jobId, summary.audioSamples), sound, (chunk, meta) => audioChunks.push({ chunk, meta }));
        } catch (reason) {
          note = `Saved without sound: ${describe(reason)}`;
        }
      } else {
        note = "Saved without sound: this computer's encoder would not take the render's audio.";
      }
    }
    if (note) writeDiagnostic("warn", "generated-video", "audio.omitted", note, { jobId });
    const withAudio = audioChunks.length > 0;

    const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: outputCodec("h264").muxer, width: summary.width, height: summary.height, frameRate: Math.round(fps) },
      ...(withAudio
        ? { audio: { codec: "aac" as const, numberOfChannels: summary.audioChannels, sampleRate: sound!.sampleRate! } }
        : {}),
      fastStart: "in-memory",
    });

    /* On an object because the encoder writes it from its own callback, where
       TypeScript's flow analysis cannot follow the assignment. */
    const failure: { reason: Error | null } = { reason: null };
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (reason) => { failure.reason = reason instanceof Error ? reason : new Error(String(reason)); },
    });
    encoder.configure({ codec, width: summary.width, height: summary.height, bitrate, framerate: fps, avc: { format: "avc" } });

    const makeFrame = frameFactory(summary.width, summary.height);
    /* Computed from the index every time rather than accumulated, so a rate
       that does not divide a microsecond evenly cannot drift the last frame
       away from the clock. */
    const timestampUs = (index: number) => Math.round((index * 1_000_000) / fps);
    const keyframeEvery = Math.max(1, Math.round(fps * KEYFRAME_SECONDS));
    const thumbnailEvery = Math.max(1, Math.round(fps * TIMELINE_THUMBNAIL_INTERVAL_MS / 1_000));
    const timelineThumbnails: Array<{ timeMs: number; bytes: Uint8Array }> = [];

    try {
      for (let index = 0; index < summary.frameCount; index += 1) {
        if (failure.reason) throw failure.reason;
        const pixels = await renderedFrame(jobId, index);
        if (index % thumbnailEvery === 0) {
          const thumbnail = await timelineThumbnailJpeg(pixels, summary.width, summary.height);
          if (thumbnail) timelineThumbnails.push({ timeMs: Math.round(index * 1_000 / fps), bytes: thumbnail });
        }
        const frame = makeFrame(pixels, timestampUs(index), timestampUs(index + 1) - timestampUs(index));
        encoder.encode(frame, { keyFrame: index % keyframeEvery === 0 });
        frame.close();
        options.onProgress?.(index + 1, summary.frameCount);
        // Let the encoder drain, and let the window paint: this loop is the
        // whole of a five-second render's encode and it must not freeze the UI.
        while (encoder.encodeQueueSize > ENCODE_QUEUE_LIMIT) await tick();
        if (index % 8 === 7) await tick();
      }
      await encoder.flush();
      if (failure.reason) throw failure.reason;
    } finally {
      if (encoder.state !== "closed") encoder.close();
    }

    audioChunks.forEach(({ chunk, meta }) => muxer.addAudioChunk(chunk, meta));

    muxer.finalize();
    const written = await writeGeneratedVideo(folderPath, jobId, new Uint8Array(target.buffer));
    await Promise.allSettled(timelineThumbnails.map((thumbnail) =>
      writeTimelineThumbnail(folderPath, jobId, thumbnail.timeMs, thumbnail.bytes)));
    return { relativePath: written.relativePath, bytes: written.bytes, note, hasAudio: withAudio };
  } finally {
    // Whatever happened, the render stops occupying memory here.
    await releaseRendered(jobId);
  }
}

/** The same failure, said the same way wherever it is caught. */
export const describeSaveFailure = (reason: unknown) => describe(reason);
