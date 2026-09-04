import { readMediaFileBytes } from "./persistence";
import { type ProjectAsset } from "./project";

export interface AudioWaveformOverview {
  durationSeconds: number;
  levels: Float32Array;
}

type WaveformAudioBuffer = Pick<AudioBuffer, "duration" | "length" | "numberOfChannels" | "getChannelData">;

const MIN_OVERVIEW_POINTS = 1_024;
const MAX_OVERVIEW_POINTS = 16_384;
const OVERVIEW_POINTS_PER_SECOND = 64;
const MAX_READS_PER_BIN = 128;
const DISPLAY_FLOOR_DB = -60;
const CACHE_LIMIT = 24;
const OVERVIEWS = new Map<string, Promise<AudioWaveformOverview>>();

/** Reduces decoded PCM to a reusable overview. RMS keeps sustained quiet
 * passages legible while the peak term retains short transients. */
export function createAudioWaveformOverview(
  buffer: WaveformAudioBuffer,
  requestedPoints?: number,
): AudioWaveformOverview {
  const desiredPoints = requestedPoints ?? Math.max(MIN_OVERVIEW_POINTS, Math.ceil(buffer.duration * OVERVIEW_POINTS_PER_SECOND));
  const pointCount = Math.max(1, Math.min(buffer.length, Math.min(MAX_OVERVIEW_POINTS, desiredPoints)));
  const levels = new Float32Array(pointCount);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));

  for (let point = 0; point < pointCount; point += 1) {
    const start = Math.floor(point * buffer.length / pointCount);
    const end = Math.max(start + 1, Math.floor((point + 1) * buffer.length / pointCount));
    const stride = Math.max(1, Math.ceil((end - start) / MAX_READS_PER_BIN));
    let squares = 0;
    let peak = 0;
    let reads = 0;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample += stride) {
        const amplitude = Math.abs(channel[sample] ?? 0);
        squares += amplitude * amplitude;
        peak = Math.max(peak, amplitude);
        reads += 1;
      }
    }
    const rms = reads > 0 ? Math.sqrt(squares / reads) : 0;
    levels[point] = peak > 0 ? Math.sqrt(rms * peak) : 0;
  }
  return { durationSeconds: buffer.duration, levels };
}

/** Selects the part used by a timeline clip and maps it on a logarithmic
 * -60 dB..0 dB scale. This prevents quiet speech or room tone from
 * disappearing against the centre line. */
export function audioWaveformSegment(
  overview: AudioWaveformOverview,
  sourceStartSeconds: number,
  durationSeconds: number,
  pointCount = 512,
): number[] {
  const result = Array.from({ length: pointCount }, () => 0);
  if (overview.durationSeconds <= 0 || overview.levels.length === 0 || durationSeconds <= 0) return result;
  const first = Math.max(0, sourceStartSeconds / overview.durationSeconds * overview.levels.length);
  const last = Math.min(overview.levels.length, (sourceStartSeconds + durationSeconds) / overview.durationSeconds * overview.levels.length);
  for (let point = 0; point < pointCount; point += 1) {
    const start = Math.floor(first + (last - first) * point / pointCount);
    const end = Math.max(start + 1, Math.ceil(first + (last - first) * (point + 1) / pointCount));
    for (let index = start; index < Math.min(end, overview.levels.length); index += 1) {
      result[point] = Math.max(result[point], overview.levels[index]);
    }
  }
  const peak = Math.max(...result);
  if (peak <= 0) return result;
  return result.map((level) => {
    if (level <= 0) return 0;
    const decibels = 20 * Math.log10(level / peak);
    return Math.max(0, Math.min(1, (decibels - DISPLAY_FLOOR_DB) / -DISPLAY_FLOOR_DB));
  });
}

/** Reads and decodes each source once. A generation timestamp belongs in the
 * cache key so regenerating the same scene path cannot reuse its old sound. */
export function loadAudioWaveform(
  folderPath: string,
  asset: ProjectAsset,
  cacheVersion = "",
): Promise<AudioWaveformOverview> {
  const location = asset.sourcePath ?? asset.relativePath;
  if (!location) return Promise.reject(new Error(`${asset.name} has no readable media path.`));
  const key = `${folderPath}::${location}::${cacheVersion}`;
  const cached = OVERVIEWS.get(key);
  if (cached) return cached;
  const pending = readMediaFileBytes(folderPath, asset).then(async (bytes) => {
    const context = new OfflineAudioContext(1, 1, 44_100);
    const decoded = await context.decodeAudioData(bytes.slice(0));
    return createAudioWaveformOverview(decoded);
  }).catch((error) => {
    OVERVIEWS.delete(key);
    throw error;
  });
  OVERVIEWS.set(key, pending);
  while (OVERVIEWS.size > CACHE_LIMIT) OVERVIEWS.delete(OVERVIEWS.keys().next().value!);
  return pending;
}
