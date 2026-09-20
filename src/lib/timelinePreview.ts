import { visibleClipsAt } from "./export";
import type { ProjectAsset, TimelineClip, TimelineTrack } from "./project";

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
      if (clip.transition && clip.transition.type !== "cut") {
        boundaries.add(clip.startMs + Math.min(clip.durationMs, clip.transition.durationMs));
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

/** Keep the current picture and the next two pictures mounted. A prepared
 * player is keyed by clip, since two trims of one asset need separate seeks. */
export function preparedPreviewClips(segments: PreviewSegment[], index: number) {
  const prepared = new Map<string, { clip: TimelineClip; prepareAtMs: number }>();
  let pictures = 0;
  for (let next = index; next < segments.length && pictures < 3; next++) {
    const segment = segments[next];
    if (segment.clips.length) pictures++;
    for (const clip of segment.clips) {
      if (!prepared.has(clip.id)) prepared.set(clip.id, { clip, prepareAtMs: segment.startMs });
    }
  }
  return [...prepared.values()];
}
