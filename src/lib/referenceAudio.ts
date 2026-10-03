import { invoke } from "@tauri-apps/api/core";
import { readMediaFileBytes } from "./persistence";
import type { SlopfabGenerationRequest } from "./runtime";

type AudioInput = NonNullable<SlopfabGenerationRequest["referenceAudios"]>[number];
const cancelledError = () => new Error("Sound reference preparation cancelled.");

export const MIN_REFERENCE_AUDIO_SECONDS = 2;
export const MAX_REFERENCE_AUDIO_SECONDS = 15;

/** The webview decodes; SlopFab takes interleaved float PCM and resamples it.
 * Surround sources are folded to stereo by the audio graph's standard downmix. */
export async function decodeReferenceAudio(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const decoded = await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(bytes.slice(0));
  if (decoded.numberOfChannels <= 2) return decoded;
  const context = new OfflineAudioContext(2, decoded.length, decoded.sampleRate);
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start();
  return context.startRendering();
}

export function referenceAudioRange(input: AudioInput, sourceDuration: number) {
  const { startSeconds: start, durationSeconds: duration } = input;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration)
    || duration < MIN_REFERENCE_AUDIO_SECONDS || duration > MAX_REFERENCE_AUDIO_SECONDS) {
    throw new Error(`${input.name}: choose a sound clip lasting 2 to 15 seconds with a nonnegative start.`);
  }
  if (!Number.isFinite(sourceDuration) || start + duration > sourceDuration + 0.001) {
    throw new Error(`${input.name}: the selected range extends beyond the end of the sound file.`);
  }
  return { start, duration };
}

/** Interleaved samples of the selected range, clamped to SlopFab's [-1, 1]. */
export function referenceAudioPcm(buffer: AudioBuffer, start: number, duration: number): Float32Array {
  const channels = buffer.numberOfChannels;
  const offset = Math.round(start * buffer.sampleRate);
  const length = Math.min(Math.round(duration * buffer.sampleRate), buffer.length - offset);
  if (length < MIN_REFERENCE_AUDIO_SECONDS * buffer.sampleRate) throw new Error("The selected sound range is shorter than 2 seconds.");
  const pcm = new Float32Array(length * channels);
  for (let channel = 0; channel < channels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < length; index++) {
      const value = samples[offset + index];
      pcm[index * channels + channel] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
  }
  return pcm;
}

/** Clip options for a newly added sound: from the start, as long as allowed. */
export async function inspectReferenceAudio(folderPath: string, sourcePath: string) {
  const decoded = await decodeReferenceAudio(await readMediaFileBytes(folderPath, { sourcePath }));
  if (decoded.duration < MIN_REFERENCE_AUDIO_SECONDS) throw new Error("Sound references must be at least 2 seconds long.");
  return { startSeconds: 0, durationSeconds: Math.min(MAX_REFERENCE_AUDIO_SECONDS, Math.floor(decoded.duration * 100) / 100) };
}

export async function releaseReferenceAudios(ids: string[]) {
  if (ids.length) await invoke("release_reference_audios", { ids });
}

export async function prepareReferenceAudios(folderPath: string, request: SlopfabGenerationRequest, cancelled: () => boolean, report: (detail: string) => void): Promise<string[]> {
  const inputs = request.referenceAudios ?? [];
  if (inputs.length > 3) throw new Error("Use at most three sound references per generation.");
  const ids: string[] = [];
  let totalDuration = 0;
  try {
    for (const input of inputs) {
      if (cancelled()) throw cancelledError();
      report(`Preparing sound reference: ${input.name}`);
      const decoded = await decodeReferenceAudio(await readMediaFileBytes(folderPath, input));
      const { start, duration } = referenceAudioRange(input, decoded.duration);
      totalDuration += duration;
      if (totalDuration > MAX_REFERENCE_AUDIO_SECONDS + 1e-9) throw new Error("Sound references must total no more than 15 seconds. Shorten them in References.");
      const pcm = referenceAudioPcm(decoded, start, duration);
      if (cancelled()) throw cancelledError();
      ids.push(await invoke<string>("create_reference_audio", new Uint8Array(pcm.buffer), { headers: {
        "x-reference-channels": String(decoded.numberOfChannels), "x-reference-rate": String(decoded.sampleRate),
      } }));
    }
    return ids;
  } catch (error) {
    await releaseReferenceAudios(ids);
    throw error;
  }
}
