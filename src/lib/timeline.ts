import type { TimelineClip, TimelineTrack } from "./project";

/* Editing the timeline, as arithmetic.
 *
 * Everything the timeline view can do to a clip by dragging — move it along its
 * lane, move it to another lane, trim either end, delete it, drop a new one in
 * — lands here rather than in the pointer handlers. Two reasons, and the second
 * is the one that matters:
 *
 *  * A pointer handler cannot be tested without a browser that lays things out;
 *    these functions are numbers in and numbers out.
 *  * The DRAG PREVIEW and the COMMITTED EDIT have to be the same calculation.
 *    The view draws the drag by running these functions and rendering the
 *    result, then commits by running them once more on release. What the user
 *    sees under the pointer is therefore what is written down — a preview that
 *    approximated the commit would put a clip somewhere the user did not aim.
 *
 * The one invariant everything here keeps: no two clips on the same track ever
 * cover the same millisecond. A refused edit returns null rather than a
 * best-effort overlap, and the caller leaves the project alone. */

/** Where a clip stops. Exclusive: a clip at 0 lasting 1000 ends at 1000, and a
 *  clip starting at 1000 sits flush against it without overlapping. */
export const clipEndMs = (clip: Pick<TimelineClip, "startMs" | "durationMs">) => clip.startMs + clip.durationMs;

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** How close two edges have to be, and what they may line up with. Tolerance is
 *  milliseconds because that is what the model speaks, but the view derives it
 *  from a fixed number of PIXELS — snapping has to feel the same at every zoom,
 *  and a lane it has not measured yet gives 0, which disables it rather than
 *  guessing. */
export interface SnapOptions {
  targets: number[];
  toleranceMs: number;
}

export const NO_SNAP: SnapOptions = { targets: [], toleranceMs: 0 };

/** Every edge worth lining up with: the head of the timeline, the playhead, and
 *  both ends of every other clip — including clips on other tracks, because
 *  cutting a sound to land on a picture change is the whole point of a magnet.
 *  The clip being dragged is excluded; a clip cannot snap to itself. */
export function snapTargets(tracks: TimelineTrack[], options: { excludeClipId?: string; playheadMs?: number } = {}): number[] {
  const targets = new Set<number>([0]);
  if (options.playheadMs !== undefined && Number.isFinite(options.playheadMs)) targets.add(Math.round(options.playheadMs));
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.id === options.excludeClipId) continue;
      targets.add(clip.startMs);
      targets.add(clipEndMs(clip));
    }
  }
  return [...targets].sort((a, b) => a - b);
}

/** The nearest target within tolerance, or the value untouched. */
export function snapTime(valueMs: number, snap: SnapOptions): number {
  if (snap.toleranceMs <= 0) return valueMs;
  let best = valueMs;
  let bestDistance = snap.toleranceMs;
  for (const target of snap.targets) {
    const distance = Math.abs(target - valueMs);
    // `<` rather than `<=`: with two targets equally close the first one wins,
    // which is stable as the pointer moves rather than flipping between them.
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/** A whole clip snapped: its head OR its tail may take the magnet, whichever is
 *  closer to something. Returns the start time. Dragging a clip so its END
 *  lands on the next clip's head is how a cut is closed up, and snapping only
 *  the head would never close it. */
export function snapStart(desiredStartMs: number, durationMs: number, snap: SnapOptions): number {
  const fromStart = snapTime(desiredStartMs, snap);
  const fromEnd = snapTime(desiredStartMs + durationMs, snap) - durationMs;
  /* Whether each END found a magnet at all, which is not the same question as
     how far it moved: an edge already sitting exactly on a target moves by
     zero, and reading that as "did not snap" would hand the drag to the other
     end and pull the clip off the target it was already on. */
  const headTook = fromStart !== desiredStartMs;
  const tailTook = fromEnd !== desiredStartMs;
  if (!headTook) return tailTook ? fromEnd : desiredStartMs;
  if (!tailTook) return fromStart;
  // Both ends found something: the smaller correction wins, so the clip moves
  // to the nearer magnet rather than being yanked across the lane.
  return Math.abs(fromEnd - desiredStartMs) < Math.abs(fromStart - desiredStartMs) ? fromEnd : fromStart;
}

/** Where a clip `durationMs` long can actually sit on a lane already holding
 *  `neighbours`, as near `desiredStartMs` as the lane allows.
 *
 *  A drag that lands on top of another clip is not an overlap and is not a
 *  refusal either: the clip slides flush against whatever is in the way, on
 *  whichever side is nearer to where the pointer actually was. That is what
 *  makes butting two shots together with a drag possible at all. Null is
 *  returned only when the lane genuinely has no room — every gap is too small
 *  and both edges of the crowd are occupied. */
export function freeStart(neighbours: TimelineClip[], desiredStartMs: number, durationMs: number): number | null {
  const desired = Math.max(0, Math.round(desiredStartMs));
  const occupied = neighbours
    .map((clip) => ({ start: clip.startMs, end: clipEndMs(clip) }))
    .sort((a, b) => a.start - b.start);
  const fits = (start: number) => start >= 0 && !occupied.some((slot) => overlaps(start, start + durationMs, slot.start, slot.end));
  if (fits(desired)) return desired;
  /* Both sides of every clip in the way, plus the head of the timeline. The
     nearest one that FITS wins — "nearest" measured from where the pointer
     asked for, so a clip dropped just past a neighbour's middle butts up after
     it rather than jumping back in front of it. */
  const candidates = [0, ...occupied.flatMap((slot) => [slot.start - durationMs, slot.end])]
    .filter(fits)
    .sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired));
  return candidates[0] ?? null;
}

const withClips = (tracks: TimelineTrack[], trackId: string, clips: TimelineClip[]): TimelineTrack[] =>
  tracks.map((track) => (track.id === trackId ? { ...track, clips } : track));

const byStart = (clips: TimelineClip[]) => [...clips].sort((a, b) => a.startMs - b.startMs);

export interface ClipLocation {
  clip: TimelineClip;
  track: TimelineTrack;
}

export function findClip(tracks: TimelineTrack[], clipId: string): ClipLocation | null {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

/** Move a clip along its lane or into another one.
 *
 *  Refused — null, and the caller writes nothing — when either track is locked,
 *  when the two tracks hold different kinds of media (a sound cannot be dragged
 *  onto a picture track any more than it can be dropped there), or when the
 *  target lane has no room for it. */
export function moveClip(
  tracks: TimelineTrack[],
  clipId: string,
  targetTrackId: string,
  desiredStartMs: number,
  snap: SnapOptions = NO_SNAP,
): TimelineTrack[] | null {
  const found = findClip(tracks, clipId);
  const target = tracks.find((track) => track.id === targetTrackId);
  if (!found || !target) return null;
  if (found.track.locked || target.locked) return null;
  if (found.track.kind !== target.kind) return null;

  const startMs = freeStart(
    target.clips.filter((clip) => clip.id !== clipId),
    snapStart(desiredStartMs, found.clip.durationMs, snap),
    found.clip.durationMs,
  );
  if (startMs === null) return null;
  if (target.id === found.track.id && startMs === found.clip.startMs) return null;

  const moved: TimelineClip = { ...found.clip, trackId: target.id, startMs };
  // Lifted off its old lane first, so a move WITHIN one lane does not leave the
  // clip behind as its own neighbour.
  const lifted = tracks.map((track) => (track.id === found.track.id ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) } : track));
  const landing = lifted.find((track) => track.id === target.id)?.clips ?? [];
  return withClips(lifted, target.id, byStart([...landing, moved]));
}

/** What the FILE can still give a clip, in milliseconds, at each end.
 *  Null means unbounded: a still image has no source timeline to run out of,
 *  and a file nothing has measured yet has no length to be held to. Passing a
 *  guess here would let a trim claim footage that does not exist. */
export interface SourceRoom {
  headMs: number | null;
  tailMs: number | null;
}

/** The room a clip has inside its own source file, given the file's length.
 *  `sourceDurationMs` null (a still, or an unmeasured file) means no limit. */
export function sourceRoom(clip: TimelineClip, sourceDurationMs: number | null): SourceRoom {
  if (sourceDurationMs === null || !Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0) {
    return { headMs: null, tailMs: null };
  }
  return {
    headMs: Math.max(0, clip.sourceStartMs),
    tailMs: Math.max(0, sourceDurationMs - clip.sourceStartMs - clip.durationMs),
  };
}

export interface TrimOptions {
  minClipMs: number;
  room: SourceRoom;
  snap?: SnapOptions;
}

/** Drag one end of a clip to `desiredMs`.
 *
 *  Trimming the START moves the clip's head on the ruler AND the point it
 *  begins inside its file, together — that is what makes it a trim rather than
 *  a move. Trimming the END only changes how long it lasts.
 *
 *  Every limit that exists is applied: the neighbour on that side (clips never
 *  overlap), the head of the timeline, the footage the file actually has left,
 *  and a floor of one frame so the result is still a clip. */
export function trimClip(
  tracks: TimelineTrack[],
  clipId: string,
  edge: "start" | "end",
  desiredMs: number,
  options: TrimOptions,
): TimelineTrack[] | null {
  const found = findClip(tracks, clipId);
  if (!found || found.track.locked) return null;
  const { clip, track } = found;
  const minClipMs = Math.max(1, Math.round(options.minClipMs));
  const others = track.clips.filter((candidate) => candidate.id !== clipId);
  const snapped = Math.round(snapTime(desiredMs, options.snap ?? NO_SNAP));

  if (edge === "start") {
    const end = clipEndMs(clip);
    const previousEnd = others
      .filter((candidate) => clipEndMs(candidate) <= clip.startMs)
      .reduce((furthest, candidate) => Math.max(furthest, clipEndMs(candidate)), 0);
    // How far left this end can go: past the neighbour, past zero, and past the
    // head of the footage are all impossible, and the clip must stay a clip.
    const floor = Math.max(0, previousEnd, options.room.headMs === null ? 0 : clip.startMs - options.room.headMs);
    const startMs = Math.min(Math.max(snapped, floor), end - minClipMs);
    if (startMs === clip.startMs) return null;
    const shift = startMs - clip.startMs;
    const next: TimelineClip = {
      ...clip,
      startMs,
      durationMs: end - startMs,
      // The head moved by `shift` on the ruler, so it moved by `shift` inside
      // the file too. Clamped at zero for a source with no timeline of its own.
      sourceStartMs: Math.max(0, clip.sourceStartMs + shift),
    };
    return withClips(tracks, track.id, byStart([...others, next]));
  }

  const nextStart = others
    .filter((candidate) => candidate.startMs >= clipEndMs(clip))
    .reduce((nearest, candidate) => Math.min(nearest, candidate.startMs), Number.POSITIVE_INFINITY);
  const ceiling = Math.min(nextStart, options.room.tailMs === null ? Number.POSITIVE_INFINITY : clipEndMs(clip) + options.room.tailMs);
  const endMs = Math.max(Math.min(snapped, ceiling), clip.startMs + minClipMs);
  if (endMs === clipEndMs(clip)) return null;
  return withClips(tracks, track.id, byStart([...others, { ...clip, durationMs: endMs - clip.startMs }]));
}

/** Take a clip off the timeline. The media it was cut from stays in the
 *  project: deleting a clip is an edit, not an import being undone. */
export function removeClip(tracks: TimelineTrack[], clipId: string): TimelineTrack[] | null {
  const found = findClip(tracks, clipId);
  if (!found || found.track.locked) return null;
  return withClips(tracks, found.track.id, found.track.clips.filter((clip) => clip.id !== clipId));
}

/** Put a new clip on a track at (or as near as possible to) `desiredStartMs`.
 *  The same placement rule as a move, so a file dropped from the media panel
 *  onto an occupied stretch butts up against what is there instead of landing
 *  on top of it. Null when the lane has no room at all. */
export function insertClip(
  tracks: TimelineTrack[],
  trackId: string,
  clip: TimelineClip,
  desiredStartMs: number,
  snap: SnapOptions = NO_SNAP,
): TimelineTrack[] | null {
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track || track.locked) return null;
  const startMs = freeStart(track.clips, snapStart(desiredStartMs, clip.durationMs, snap), clip.durationMs);
  if (startMs === null) return null;
  return withClips(tracks, track.id, byStart([...track.clips, { ...clip, trackId, startMs }]));
}
