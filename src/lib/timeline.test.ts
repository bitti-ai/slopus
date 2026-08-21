import { describe, expect, it } from "vitest";
import { parseProjectConfig, type TimelineClip, type TimelineTrack } from "./project";
import {
  clipEndMs,
  freeStart,
  insertClip,
  moveClip,
  removeClip,
  snapStart,
  snapTargets,
  snapTime,
  sourceRoom,
  trimClip,
} from "./timeline";

const clip = (id: string, startMs: number, durationMs: number, over: Partial<TimelineClip> = {}): TimelineClip => ({
  id, assetId: `asset-${id}`, trackId: "v1", startMs, durationMs, sourceStartMs: 0,
  label: id, color: null, status: "approved", ...over,
});

const track = (id: string, kind: "video" | "audio", clips: TimelineClip[], over: Partial<TimelineTrack> = {}): TimelineTrack => ({
  id, kind, name: id, locked: false, muted: false, clips: clips.map((item) => ({ ...item, trackId: id })), ...over,
});

/* Two picture lanes and two sound lanes, which is what makes "to another track"
   testable in both directions and "not onto that one" testable at all. */
const stage = () => [
  track("v1", "video", [clip("a", 0, 4_000), clip("b", 6_000, 2_000)]),
  track("v2", "video", []),
  track("a1", "audio", [clip("music", 0, 10_000)]),
  track("a2", "audio", []),
];

const lane = (tracks: TimelineTrack[], id: string) => tracks.find((item) => item.id === id)!;
const at = (tracks: TimelineTrack[], trackId: string, clipId: string) => lane(tracks, trackId).clips.find((item) => item.id === clipId);

/** Nothing any of these functions returns may put two clips over each other —
 *  the single invariant the whole module exists to keep. */
const noOverlaps = (tracks: TimelineTrack[]) =>
  tracks.every((item) => [...item.clips].sort((a, b) => a.startMs - b.startMs)
    .every((current, index, sorted) => index === 0 || sorted[index - 1].startMs + sorted[index - 1].durationMs <= current.startMs));

describe("snapping", () => {
  it("offers the head of the timeline, the playhead, and both ends of every other clip", () => {
    // 0 and the playhead, plus b (6s–8s) and the music (0–10s) — a's own edges
    // are missing because a is the clip being dragged.
    expect(snapTargets(stage(), { excludeClipId: "a", playheadMs: 5_500 }))
      .toEqual([0, 5_500, 6_000, 8_000, 10_000]);
    // The dragged clip is not a target for itself, or it could never move.
    expect(snapTargets(stage(), { excludeClipId: "a" })).not.toContain(4_000);
  });

  it("takes the nearest target inside the tolerance and leaves everything else alone", () => {
    const snap = { targets: [0, 6_000, 8_000], toleranceMs: 200 };
    expect(snapTime(5_900, snap)).toBe(6_000);
    expect(snapTime(6_250, snap)).toBe(6_250);
    // A tolerance of zero is how the view says "I have not measured the lane
    // yet". It must disable the magnet rather than snap everything to 0.
    expect(snapTime(5_900, { targets: [0, 6_000], toleranceMs: 0 })).toBe(5_900);
  });

  it("lets the tail of a clip take the magnet, which is how a cut gets closed up", () => {
    const snap = { targets: [6_000], toleranceMs: 200 };
    // Head is 4s from anything; the tail is 100ms short of the next clip's head,
    // so the clip lands flush and the gap disappears.
    expect(snapStart(5_900 - 4_000, 4_000, snap)).toBe(2_000);
    // Whichever end is closer wins: here it is the head.
    expect(snapStart(5_950, 4_000, snap)).toBe(6_000);
  });
});

describe("placing a clip where there is room", () => {
  it("leaves a free position alone", () => {
    expect(freeStart([clip("a", 0, 4_000)], 5_000, 1_000)).toBe(5_000);
  });

  it("butts up against whatever is in the way, on the nearer side", () => {
    const neighbours = [clip("a", 2_000, 4_000)];
    // Dropped over the head of the neighbour: lands flush in front of it.
    expect(freeStart(neighbours, 2_300, 1_000)).toBe(1_000);
    // Dropped over its tail: lands flush after it.
    expect(freeStart(neighbours, 5_500, 1_000)).toBe(6_000);
    // And a clip dropped where it already fits is not moved at all.
    expect(freeStart(neighbours, 500, 1_000)).toBe(500);
  });

  it("finds a gap big enough and refuses when there is none", () => {
    const crowd = [clip("a", 0, 4_000), clip("b", 5_000, 4_000)];
    // The 1s gap takes a 1s clip exactly.
    expect(freeStart(crowd, 4_400, 1_000)).toBe(4_000);
    // A 2s clip does not fit in it, so it goes after the crowd rather than on
    // top of anything.
    expect(freeStart(crowd, 4_400, 2_000)).toBe(9_000);
    // Nowhere at all: both edges of the crowd blocked by the timeline head is
    // impossible, but a lane with no room to the left still answers honestly.
    expect(freeStart([clip("a", 0, 4_000)], 0, 4_000)).toBe(4_000);
  });

  it("never lands a clip before the start of the timeline", () => {
    expect(freeStart([], -5_000, 1_000)).toBe(0);
  });
});

describe("moving a clip", () => {
  it("moves it along its own lane", () => {
    // b is 2s long and 4s–6s is empty, so this is a plain slide with no
    // neighbour involved.
    const next = moveClip(stage(), "b", "v1", 4_200)!;
    expect(at(next, "v1", "b")!.startMs).toBe(4_200);
    expect(noOverlaps(next)).toBe(true);
  });

  it("moves it to another lane of the same kind, and takes it off the old one", () => {
    const next = moveClip(stage(), "a", "v2", 3_000)!;
    expect(lane(next, "v1").clips.map((item) => item.id)).toEqual(["b"]);
    expect(at(next, "v2", "a")).toMatchObject({ startMs: 3_000, trackId: "v2" });
    // The clip's own record of which track it is on has to move with it, or the
    // project says one thing and the lane it is drawn in says another.
    expect(at(next, "v2", "a")!.trackId).toBe("v2");
  });

  it("moves sound between sound tracks", () => {
    const next = moveClip(stage(), "music", "a2", 2_000)!;
    expect(lane(next, "a1").clips).toHaveLength(0);
    expect(at(next, "a2", "music")!.startMs).toBe(2_000);
  });

  it("refuses to mix picture and sound, or to touch a locked track", () => {
    expect(moveClip(stage(), "music", "v2", 0)).toBeNull();
    expect(moveClip(stage(), "a", "a2", 0)).toBeNull();
    const lockedTarget = stage().map((item) => (item.id === "v2" ? { ...item, locked: true } : item));
    expect(moveClip(lockedTarget, "a", "v2", 0)).toBeNull();
    const lockedSource = stage().map((item) => (item.id === "v1" ? { ...item, locked: true } : item));
    expect(moveClip(lockedSource, "a", "v2", 0)).toBeNull();
  });

  it("slides against a neighbour instead of covering it", () => {
    // Dragged over the middle of b (6s–8s): it cannot land there, so it lands
    // flush against the side the pointer was nearer to.
    const next = moveClip(stage(), "a", "v1", 6_500)!;
    expect(at(next, "v1", "a")!.startMs).toBe(8_000);
    expect(noOverlaps(next)).toBe(true);
  });

  it("does not count the clip as its own neighbour when it moves within a lane", () => {
    // Nudged 100ms right on a lane where the only other clip is far away. If
    // the clip were still on the lane while being placed, it would block itself
    // and jump the whole width of itself instead.
    const next = moveClip(stage(), "a", "v1", 100)!;
    expect(at(next, "v1", "a")!.startMs).toBe(100);
  });

  it("reports no move rather than an identical project", () => {
    expect(moveClip(stage(), "a", "v1", 0)).toBeNull();
    expect(moveClip(stage(), "nope", "v1", 0)).toBeNull();
    expect(moveClip(stage(), "a", "no-such-track", 0)).toBeNull();
  });

  it("snaps to a neighbour while moving", () => {
    const snap = { targets: snapTargets(stage(), { excludeClipId: "a" }), toleranceMs: 300 };
    // 4.1s from the head means the tail lands 100ms short of b: close the gap.
    const next = moveClip(stage(), "a", "v1", 2_100, snap)!;
    expect(at(next, "v1", "a")!.startMs).toBe(2_000);
    expect(clipEndMs(at(next, "v1", "a")!)).toBe(6_000);
  });
});

describe("trimming a clip by its edges", () => {
  const room = { headMs: 3_000, tailMs: 3_000 };

  it("moves the head on the ruler and inside the file together", () => {
    const tracks = [track("v1", "video", [clip("a", 4_000, 4_000, { sourceStartMs: 3_000 })])];
    const next = trimClip(tracks, "a", "start", 5_000, { minClipMs: 40, room })!;
    const trimmed = at(next, "v1", "a")!;
    expect(trimmed.startMs).toBe(5_000);
    expect(trimmed.durationMs).toBe(3_000);
    // A second later on the ruler is a second later in the footage, or the
    // trim would slide the picture under the cut.
    expect(trimmed.sourceStartMs).toBe(4_000);
  });

  it("will not pull the head back past the footage the file has", () => {
    const tracks = [track("v1", "video", [clip("a", 4_000, 4_000, { sourceStartMs: 1_000 })])];
    // Only 1s of head is left in the file, so 4_000 - 1_000 is the floor.
    const next = trimClip(tracks, "a", "start", 0, { minClipMs: 40, room: { headMs: 1_000, tailMs: 0 } })!;
    expect(at(next, "v1", "a")).toMatchObject({ startMs: 3_000, durationMs: 5_000, sourceStartMs: 0 });
  });

  it("lets a still image be pulled open at either end, because it has no footage to run out of", () => {
    const tracks = [track("v1", "video", [clip("still", 4_000, 2_000)])];
    const unbounded = { headMs: null, tailMs: null };
    expect(at(trimClip(tracks, "still", "start", 500, { minClipMs: 40, room: unbounded })!, "v1", "still"))
      .toMatchObject({ startMs: 500, durationMs: 5_500, sourceStartMs: 0 });
    expect(at(trimClip(tracks, "still", "end", 30_000, { minClipMs: 40, room: unbounded })!, "v1", "still"))
      .toMatchObject({ startMs: 4_000, durationMs: 26_000 });
  });

  it("stops at the neighbour on that side rather than growing over it", () => {
    const tracks = stage();
    // a ends at 4s, b starts at 6s: the tail can reach 6s and no further.
    const next = trimClip(tracks, "a", "end", 9_000, { minClipMs: 40, room: { headMs: 0, tailMs: 20_000 } })!;
    expect(clipEndMs(at(next, "v1", "a")!)).toBe(6_000);
    expect(noOverlaps(next)).toBe(true);
    // And the head cannot be pulled back over the clip in front of it: b opens
    // up into the 1s gap and stops dead on a's tail.
    const crowded = [track("v1", "video", [clip("a", 0, 4_000), clip("b", 5_000, 4_000)])];
    const pulled = trimClip(crowded, "b", "start", 1_000, { minClipMs: 40, room: { headMs: 9_000, tailMs: 0 } })!;
    expect(at(pulled, "v1", "b")).toMatchObject({ startMs: 4_000, durationMs: 5_000 });
    expect(noOverlaps(pulled)).toBe(true);
  });

  it("keeps at least one frame, from either end", () => {
    const tracks = [track("v1", "video", [clip("a", 0, 4_000)])];
    expect(at(trimClip(tracks, "a", "end", 0, { minClipMs: 42, room })!, "v1", "a")!.durationMs).toBe(42);
    const fromHead = at(trimClip(tracks, "a", "start", 9_999, { minClipMs: 42, room })!, "v1", "a")!;
    expect(fromHead.durationMs).toBe(42);
    expect(fromHead.startMs).toBe(4_000 - 42);
  });

  it("will not run the tail past the end of the footage", () => {
    const tracks = [track("v1", "video", [clip("a", 0, 4_000, { sourceStartMs: 2_000 })])];
    // 10s file, starting 2s in, 4s used: 4s of tail left.
    const measured = sourceRoom(tracks[0].clips[0], 10_000);
    expect(measured).toEqual({ headMs: 2_000, tailMs: 4_000 });
    expect(at(trimClip(tracks, "a", "end", 30_000, { minClipMs: 40, room: measured })!, "v1", "a")!.durationMs).toBe(8_000);
  });

  it("reports no trim rather than an identical project, and refuses a locked track", () => {
    const tracks = [track("v1", "video", [clip("a", 0, 4_000)])];
    expect(trimClip(tracks, "a", "end", 4_000, { minClipMs: 40, room })).toBeNull();
    expect(trimClip(tracks, "a", "start", 0, { minClipMs: 40, room })).toBeNull();
    const locked = [track("v1", "video", [clip("a", 0, 4_000)], { locked: true })];
    expect(trimClip(locked, "a", "end", 6_000, { minClipMs: 40, room })).toBeNull();
  });

  it("snaps a trimmed edge to the clips around it", () => {
    const tracks = stage();
    const snap = { targets: snapTargets(tracks, { excludeClipId: "a" }), toleranceMs: 300 };
    const next = trimClip(tracks, "a", "end", 5_800, { minClipMs: 40, room: { headMs: 0, tailMs: 20_000 }, snap })!;
    expect(clipEndMs(at(next, "v1", "a")!)).toBe(6_000);
  });
});

describe("removing and inserting", () => {
  it("takes a clip off its track and leaves the rest alone", () => {
    const next = removeClip(stage(), "a")!;
    expect(lane(next, "v1").clips.map((item) => item.id)).toEqual(["b"]);
    expect(lane(next, "a1").clips).toHaveLength(1);
  });

  it("refuses to remove from a locked track", () => {
    const locked = stage().map((item) => (item.id === "v1" ? { ...item, locked: true } : item));
    expect(removeClip(locked, "a")).toBeNull();
    expect(removeClip(stage(), "not-a-clip")).toBeNull();
  });

  it("drops a new clip into the first place it fits", () => {
    const fresh = clip("new", 0, 3_000);
    const next = insertClip(stage(), "v1", fresh, 3_000)!;
    // 3s over the top of a (0–4s): it butts up after it instead of covering it.
    expect(at(next, "v1", "new")!.startMs).toBe(8_000);
    expect(noOverlaps(next)).toBe(true);
    expect(insertClip(stage().map((item) => (item.id === "v1" ? { ...item, locked: true } : item)), "v1", fresh, 0)).toBeNull();
  });
});

describe("what comes out still parses as a project", () => {
  it("survives the schema after a move, a trim and a delete", () => {
    const base = parseProjectConfig({
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      name: "Edits", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      thumbnail: null,
      settings: { aspectRatio: "16:9", resolution: "1080p", frameRate: 24, backgroundColor: "#10131a" },
      brief: { prompt: "A film", status: "draft", targetDurationSeconds: 30, aspectRatio: "16:9", resolution: "1080p" },
      assets: [], references: [], generationJobs: [],
      timeline: { tracks: stage() },
      exports: [],
    });
    const moved = moveClip(base.timeline.tracks, "a", "v2", 1_234)!;
    const trimmed = trimClip(moved, "b", "start", 6_500, { minClipMs: 42, room: { headMs: 5_000, tailMs: 5_000 } })!;
    const deleted = removeClip(trimmed, "music")!;
    expect(parseProjectConfig({ ...base, timeline: { tracks: deleted } })).toBeTruthy();
    expect(noOverlaps(deleted)).toBe(true);
  });
});
