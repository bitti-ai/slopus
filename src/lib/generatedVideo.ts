import { invoke } from "@tauri-apps/api/core";
import { bitrateFor, outputCodec } from "./export";
import { isTauri } from "./persistence";

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

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What Rust still holds for this scene, or null if nothing does. */
export async function renderedSummary(jobId: string): Promise<RenderedSummary | null> {
  if (!isTauri()) return null;
  return invoke<RenderedSummary | null>("generated_summary", { jobId });
}

/** One frame's pixels, RGBA, straight out of the render. */
async function renderedFrame(jobId: string, index: number): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("generated_frame", { jobId, index }));
}

/** The render's soundtrack, interleaved, as Rust holds it. */
async function renderedAudio(jobId: string): Promise<Float32Array> {
  return new Float32Array(await invoke<ArrayBuffer>("generated_audio", { jobId }));
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

/** Whether this machine will encode the render's own sound as AAC. The render
 *  decides the rate and the channel count, so the question is asked with those
 *  numbers rather than with the export pipeline's 48 kHz stereo. */
async function audioSupported(summary: RenderedSummary): Promise<boolean> {
  if (summary.audioSamples === 0 || summary.audioChannels <= 0 || summary.audioSampleRate <= 0) return false;
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return false;
  const support = await AudioEncoder.isConfigSupported({
    codec: AUDIO_CODEC,
    sampleRate: summary.audioSampleRate,
    numberOfChannels: summary.audioChannels,
    bitrate: AUDIO_BITRATE,
  }).catch(() => ({ supported: false }));
  return Boolean(support.supported);
}

/** Feeds the render's interleaved samples to the AAC encoder, in the blocks
 *  AAC works in. */
async function encodeAudio(
  summary: RenderedSummary,
  samples: Float32Array,
  add: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void,
): Promise<void> {
  const channels = summary.audioChannels;
  const total = Math.floor(samples.length / channels);
  const failure: { reason: Error | null } = { reason: null };
  const encoder = new AudioEncoder({
    output: (chunk, meta) => add(chunk, meta),
    error: (reason) => { failure.reason = reason instanceof Error ? reason : new Error(String(reason)); },
  });
  encoder.configure({
    codec: AUDIO_CODEC,
    sampleRate: summary.audioSampleRate,
    numberOfChannels: channels,
    bitrate: AUDIO_BITRATE,
  });
  try {
    for (let offset = 0; offset < total; offset += AUDIO_BLOCK) {
      if (failure.reason) throw failure.reason;
      const count = Math.min(AUDIO_BLOCK, total - offset);
      // f32-planar: every channel's block laid end to end, de-interleaved from
      // the way vidfab returns them.
      const planar = new Float32Array(count * channels);
      for (let channel = 0; channel < channels; channel += 1) {
        for (let frame = 0; frame < count; frame += 1) {
          planar[channel * count + frame] = samples[(offset + frame) * channels + channel];
        }
      }
      const data = new AudioData({
        format: "f32-planar",
        sampleRate: summary.audioSampleRate,
        numberOfFrames: count,
        numberOfChannels: channels,
        timestamp: Math.round((offset * 1_000_000) / summary.audioSampleRate),
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

  try {
    const fps = summary.fps > 0 ? summary.fps : 24;
    const bitrate = bitrateFor(summary.width, summary.height, fps, GENERATED_QUALITY);
    const { codec } = await pickCodec(summary.width, summary.height, fps, bitrate);
    const withAudio = await audioSupported(summary);

    const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: outputCodec("h264").muxer, width: summary.width, height: summary.height, frameRate: Math.round(fps) },
      ...(withAudio
        ? { audio: { codec: "aac" as const, numberOfChannels: summary.audioChannels, sampleRate: summary.audioSampleRate } }
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

    try {
      for (let index = 0; index < summary.frameCount; index += 1) {
        if (failure.reason) throw failure.reason;
        const pixels = await renderedFrame(jobId, index);
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

    let note: string | null = null;
    if (withAudio) {
      await encodeAudio(summary, await renderedAudio(jobId), (chunk, meta) => muxer.addAudioChunk(chunk, meta));
    } else if (summary.audioSamples > 0) {
      // The render HAD sound and the file does not: say so rather than hand
      // back a silent video that looks complete.
      note = "Saved without sound: this computer's encoder would not take the render's audio.";
    }

    muxer.finalize();
    const written = await writeGeneratedVideo(folderPath, jobId, new Uint8Array(target.buffer));
    return { relativePath: written.relativePath, bytes: written.bytes, note };
  } finally {
    // Whatever happened, the render stops occupying memory here.
    await releaseRendered(jobId);
  }
}

/** The same failure, said the same way wherever it is caught. */
export const describeSaveFailure = (reason: unknown) => describe(reason);
