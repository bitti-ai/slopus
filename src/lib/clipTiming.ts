import type { TimelineClip } from "./project";

export const MIN_CLIP_SPEED = 0.25;
export const MAX_CLIP_SPEED = 4;
export const clipPlaybackRate = (clip: Pick<TimelineClip, "playbackRate">) => clip.playbackRate ?? 1;
export const clipSourceTimeMs = (clip: Pick<TimelineClip, "sourceStartMs" | "startMs" | "playbackRate">, timelineMs: number) =>
  clip.sourceStartMs + (timelineMs - clip.startMs) * clipPlaybackRate(clip);
