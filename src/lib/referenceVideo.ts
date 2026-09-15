import { invoke } from "@tauri-apps/api/core";
import { demux, type DemuxedSource } from "./exportPipeline";
import { readMediaFileBytes } from "./persistence";
import type { ProjectConfig } from "./project";
import type { SlopfabGenerationRequest } from "./runtime";

type VideoInput = NonNullable<SlopfabGenerationRequest["referenceVideos"]>[number];
const cancelledError = () => new Error("Video reference preparation cancelled.");

export function referenceVideoRange(input: VideoInput, sourceDuration: number) {
  const start = input.startSeconds;
  const duration = input.durationSeconds ?? Math.min(15, sourceDuration - start);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 2 || duration > 15) {
    throw new Error(`${input.name}: choose a clip lasting 2 to 15 seconds with a nonnegative start.`);
  }
  if (!Number.isFinite(sourceDuration) || start + duration > sourceDuration + 0.001) {
    throw new Error(`${input.name}: the selected clip extends beyond the source video.`);
  }
  return { start, duration };
}

export function sourceVideoDuration(source: DemuxedSource): number {
  const first = source.samples.reduce((value, sample) => Math.min(value, sample.timestampUs), Infinity);
  const last = source.samples.reduce((value, sample) => Math.max(value, sample.timestampUs + sample.durationUs), -Infinity);
  return source.durationSeconds ?? (last - first) / 1_000_000;
}

export async function inspectReferenceVideo(folderPath: string, sourcePath: string) {
  const source = await demux(await readMediaFileBytes(folderPath, { sourcePath }), "Video reference");
  const duration = sourceVideoDuration(source);
  referenceVideoRange({ name: "Video reference", startSeconds: 0, includeAudio: true }, duration);
  return { durationSeconds: Math.min(15, duration), includeAudio: Boolean(source.hasAudio) };
}

async function referenceDecoderConfig(config: VideoDecoderConfig): Promise<VideoDecoderConfig> {
  // A rejected hardware preference does not mean the codec is unavailable.
  // In particular, AV1 may still be decoded by the webview's software decoder.
  for (const hardwareAcceleration of ["prefer-hardware", "no-preference"] as const) {
    const candidate = { ...config, hardwareAcceleration };
    try {
      const support = await VideoDecoder.isConfigSupported(candidate);
      if (support.supported) return support.config ?? candidate;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotSupportedError") throw error;
    }
  }
  throw new Error(`This webview cannot decode reference codec ${config.codec} with hardware or automatic decoder selection.`);
}

/** Decode only the selected interval. At most a small decoder batch and one
 * retained frame are alive; binary IPC avoids JSON/base64 copies of pixels.
 * Slopfab consumes host RGB, so readback is confined to this ingestion step. */
export async function uploadReferenceVideoFrames(source: DemuxedSource, id: string, start: number, duration: number, cancelled: () => boolean) {
  if (typeof VideoDecoder === "undefined") throw new Error("This webview does not support WebCodecs video decoding.");
  const config = await referenceDecoderConfig(source.config);
  const origin = source.samples.reduce((value, sample) => Math.min(value, sample.timestampUs), Infinity);
  const beginUs = origin + Math.round(start * 1_000_000);
  const endUs = beginUs + Math.round(duration * 1_000_000);
  let first = 0;
  for (let index = 0; index < source.samples.length; index++) {
    if (source.samples[index].key && source.samples[index].timestampUs <= beginUs) first = index;
  }
  // Include the rest of the last GOP for reordered/B frames at the trim edge.
  let last = source.samples.length;
  for (let index = first + 1; index < source.samples.length; index++) {
    if (source.samples[index].key && source.samples[index].timestampUs >= endUs) { last = index; break; }
  }
  const state: { previous: VideoFrame | null; error: unknown; pending: number; uploaded: number; slot: number; canvas: OffscreenCanvas | null } =
    { previous: null, error: null, pending: 0, uploaded: 0, slot: -1, canvas: null };
  let chain = Promise.resolve();
  const check = () => { if (cancelled()) throw cancelledError(); if (state.error) throw state.error; };
  const upload = async (frame: VideoFrame, seconds: number) => {
    check();
    const slot = Math.round(seconds * 24);
    if (slot <= state.slot || slot >= Math.round(duration * 24)) return;
    if (!state.canvas) {
      const aspect = frame.displayWidth / frame.displayHeight;
      if (aspect < 0.25 || aspect > 4) throw new Error("Video reference aspect ratio must be between 1:4 and 4:1.");
      const scale = Math.min(1, 768 / Math.max(frame.displayWidth, frame.displayHeight));
      state.canvas = new OffscreenCanvas(Math.max(1, Math.round(frame.displayWidth * scale)), Math.max(1, Math.round(frame.displayHeight * scale)));
    }
    const canvas = state.canvas;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create the video reference pixel buffer.");
    context.drawImage(frame, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    await invoke("append_reference_video", new Uint8Array(pixels.buffer), { headers: {
      "x-reference-id": id, "x-reference-width": String(canvas.width), "x-reference-height": String(canvas.height),
      "x-reference-time": String(state.uploaded === 0 ? 0 : seconds),
    } });
    state.slot = slot;
    state.uploaded += 1;
  };
  const consume = async (frame: VideoFrame) => {
    check();
    if (frame.timestamp <= beginUs) {
      state.previous?.close();
      state.previous = frame.clone();
      return;
    }
    if (!state.uploaded && state.previous) {
      await upload(state.previous, 0);
      state.previous.close(); state.previous = null;
    }
    if (frame.timestamp < endUs) await upload(frame, state.uploaded ? (frame.timestamp - beginUs) / 1_000_000 : 0);
  };
  const decoder = new VideoDecoder({
    output: (frame) => {
      state.pending += 1;
      chain = chain.then(() => consume(frame)).catch((error: unknown) => { state.error ??= error; })
        .finally(() => { frame.close(); state.pending -= 1; });
    },
    error: (error) => { state.error = error; },
  });
  try {
    decoder.configure(config);
    for (let index = first; index < last; index++) {
      check();
      const sample = source.samples[index];
      decoder.decode(new EncodedVideoChunk({ type: sample.key ? "key" : "delta", timestamp: sample.timestampUs, duration: sample.durationUs, data: sample.data }));
      while (decoder.decodeQueueSize > 8 || state.pending > 8) {
        await new Promise((resolve) => setTimeout(resolve, 0)); check();
      }
    }
    await decoder.flush();
    await chain;
    check();
    if (!state.uploaded && state.previous) await upload(state.previous, 0);
    if (!state.uploaded) throw new Error("The selected reference interval contains no decodable frames.");
  } finally {
    if (decoder.state !== "closed") decoder.close();
    await chain;
    state.previous?.close();
  }
}

export function referenceSoundtrack(buffer: AudioBuffer, start: number, duration: number): Float32Array {
  if (buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error("Video reference soundtracks must be mono or stereo. Turn off Include sound for this clip or use a mono/stereo source.");
  const offset = Math.round(start * buffer.sampleRate);
  const length = Math.min(Math.floor(duration * buffer.sampleRate), buffer.length - offset);
  if (length <= 0) throw new Error("The selected video interval contains no soundtrack samples. Turn off Include sound for this clip.");
  const pcm = new Float32Array(length * buffer.numberOfChannels);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < length; index++) pcm[index * buffer.numberOfChannels + channel] = Math.max(-1, Math.min(1, samples[offset + index]));
  }
  return pcm;
}

export async function releaseReferenceVideos(ids: string[]) {
  if (ids.length) await invoke("release_reference_videos", { ids });
}

export async function prepareReferenceVideos(folderPath: string, request: SlopfabGenerationRequest, config: ProjectConfig, cancelled: () => boolean, report: (detail: string) => void): Promise<string[]> {
  const inputs = request.referenceVideos ?? [];
  if (inputs.length > 3 || request.referencePaths.length > 9) throw new Error("Use at most nine images and three video references per generation.");
  const ids: string[] = [];
  let totalDuration = 0;
  try {
    for (const input of inputs) {
      if (cancelled()) throw cancelledError();
      report(`Preparing video reference: ${input.name}`);
      if (!/\.(mp4|m4v|mov)$/i.test(input.sourcePath ?? input.relativePath ?? "")) throw new Error(`${input.name}: video references currently require an MP4 or MOV file.`);
      const bytes = await readMediaFileBytes(folderPath, input);
      const source = await demux(bytes, input.name);
      const { start, duration } = referenceVideoRange(input, sourceVideoDuration(source));
      totalDuration += duration;
      if (totalDuration > 15 + 1e-9) throw new Error("Video references must total no more than 15 seconds. Shorten the clips in References.");
      if (cancelled()) throw cancelledError();
      const id = await invoke<string>("create_reference_video", { durationSeconds: duration, config });
      ids.push(id);
      await uploadReferenceVideoFrames(source, id, start, duration, cancelled);
      if (input.includeAudio && source.hasAudio) {
        report(`Preparing soundtrack: ${input.name}`);
        const context = new OfflineAudioContext(2, 1, 48_000);
        const decoded = await context.decodeAudioData(bytes.slice(0));
        if (cancelled()) throw cancelledError();
        const pcm = referenceSoundtrack(decoded, start, duration);
        await invoke("set_reference_video_audio", new Uint8Array(pcm.buffer), { headers: {
          "x-reference-id": id, "x-reference-channels": String(decoded.numberOfChannels), "x-reference-rate": String(decoded.sampleRate),
        } });
      }
    }
    return ids;
  } catch (error) {
    await releaseReferenceVideos(ids);
    throw error;
  }
}
