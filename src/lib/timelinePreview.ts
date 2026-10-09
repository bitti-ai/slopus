import { visibleClipsAt } from "./export";
import { clipPlaybackRate, clipSourceTimeMs } from "./clipTiming";
import { clipTransition, type ProjectAsset, type TimelineClip, type TimelineTrack } from "./project";

export type PreviewSegment = { startMs: number; clips: TimelineClip[] };

/** Resolve visibility once per edit, including a lower track revealed by a cut
 * or the end of a transition. Playback only needs a binary search afterwards. */
export function previewSegments(tracks: TimelineTrack[], assets: ReadonlyMap<string, ProjectAsset>): PreviewSegment[] {
  const boundaries = new Set([0]);
  for (const track of tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      boundaries.add(clip.startMs);
      boundaries.add(clip.startMs + clip.durationMs);
      const transition = clipTransition(clip);
      if (transition.type !== "cut") {
        boundaries.add(clip.startMs + Math.min(clip.durationMs, transition.durationMs));
      }
    }
  }
  const segments: PreviewSegment[] = [];
  for (const startMs of [...boundaries].sort((a, b) => a - b)) {
    const clips = visibleClipsAt(tracks, startMs, assets);
    const previous = segments.at(-1)?.clips;
    if (previous && previous.length === clips.length && previous.every((clip, index) => clip.id === clips[index].id)) continue;
    segments.push({ startMs, clips });
  }
  return segments;
}

export function previewSegmentIndex(segments: PreviewSegment[], timeMs: number): number {
  let low = 0, high = segments.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (segments[middle].startMs <= timeMs) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Adjacent ranges of a joined generation can keep one running decoder.
 * Preserve separate players for gaps, overlaps, changed speeds and other trims. */
export function previewPlayerKeys(tracks: TimelineTrack[], assets: ReadonlyMap<string, ProjectAsset>) {
  const keys = new Map<string, string>();
  for (const track of tracks) {
    if (track.kind !== "video") continue;
    let previous: TimelineClip | undefined;
    for (const clip of [...track.clips].sort((a, b) => a.startMs - b.startMs)) {
      const asset = assets.get(clip.assetId);
      const rate = clipPlaybackRate(clip);
      const continuous = previous && (asset?.sceneSegments?.length ?? 0) > 1
        && previous.assetId === clip.assetId && clipPlaybackRate(previous) === rate
        && previous.startMs + previous.durationMs === clip.startMs
        // Scene durations are stored in whole milliseconds; their frame
        // offsets are exact. Allow only that half-millisecond rounding error.
        && Math.abs(clipSourceTimeMs(previous, clip.startMs) - clip.sourceStartMs) <= rate / 2 + 1e-6;
      keys.set(clip.id, continuous ? keys.get(previous!.id)! : clip.id);
      previous = clip;
    }
  }
  return keys;
}

/** Keep the current picture and the next two pictures mounted. Continuous
 * joined scenes share a player; unrelated trims still prepare independently. */
export function preparedPreviewClips(segments: PreviewSegment[], index: number, playerKeys?: ReadonlyMap<string, string>) {
  const prepared = new Map<string, { clip: TimelineClip; prepareAtMs: number; playerKey: string }>();
  let pictures = 0;
  for (let next = index; next < segments.length && pictures < 3; next++) {
    const segment = segments[next];
    if (segment.clips.length) pictures++;
    for (const clip of segment.clips) {
      const playerKey = playerKeys?.get(clip.id) ?? clip.id;
      if (!prepared.has(playerKey)) prepared.set(playerKey, { clip, prepareAtMs: segment.startMs, playerKey });
    }
  }
  return [...prepared.values()];
}
