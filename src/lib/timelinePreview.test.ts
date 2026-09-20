import { describe, expect, it } from "vitest";
import type { ProjectAsset, TimelineClip, TimelineTrack } from "./project";
import { preparedPreviewClips, previewSegmentIndex, previewSegments } from "./timelinePreview";

const asset = { id: "video", kind: "video", mimeType: "video/mp4" } as ProjectAsset;
const assets = new Map([[asset.id, asset]]);
const clip = (id: string, startMs: number, durationMs: number, extra: Partial<TimelineClip> = {}): TimelineClip => ({
  id, assetId: asset.id, trackId: "track", startMs, durationMs, sourceStartMs: 0, label: id, color: null, status: "approved", ...extra,
});
const track = (clips: TimelineClip[]): TimelineTrack => ({ id: "track", name: "Picture", kind: "video", muted: false, locked: false, clips });

describe("prepared timeline pictures", () => {
  it("prepares a covered lower track at the time it will be revealed", () => {
    const segments = previewSegments([track([clip("top", 0, 2000)]), track([clip("lower", 0, 6000, { sourceStartMs: 8000 })])], assets);
    expect(segments.map((segment) => [segment.startMs, segment.clips.map((clip) => clip.id)])).toEqual([
      [0, ["top"]], [2000, ["lower"]], [6000, []],
    ]);
    const prepared = preparedPreviewClips(segments, 0);
    expect(prepared.map((entry) => [entry.clip.id, entry.prepareAtMs])).toEqual([["top", 0], ["lower", 2000]]);
    expect(prepared[1].clip.sourceStartMs + prepared[1].prepareAtMs - prepared[1].clip.startMs).toBe(10000);
  });

  it("retains transition layers only while revealed and prepares beyond gaps", () => {
    const segments = previewSegments([
      track([clip("fade", 1000, 2000, { transition: { type: "fade", durationMs: 500 } }), clip("later", 5000, 1000)]),
      track([clip("lower", 1000, 2000)]),
    ], assets);
    expect(segments.map((segment) => [segment.startMs, segment.clips.map((clip) => clip.id)])).toEqual([
      [0, []], [1000, ["fade", "lower"]], [1500, ["fade"]], [3000, []], [5000, ["later"]], [6000, []],
    ]);
    expect(previewSegmentIndex(segments, 1499)).toBe(1);
    expect(previewSegmentIndex(segments, 1500)).toBe(2);
    expect(previewSegmentIndex(segments, 99999)).toBe(5);
    expect(preparedPreviewClips(segments, 2).map((entry) => entry.clip.id)).toEqual(["fade", "later"]);
  });

  it("bounds prepared players to the current and next two pictures, even for repeated assets", () => {
    const segments = previewSegments([track(Array.from({ length: 30 }, (_, index) => clip(String(index), index * 1000, 1000)))], assets);
    expect(preparedPreviewClips(segments, 0).map((entry) => entry.clip.id)).toEqual(["0", "1", "2"]);
    expect(preparedPreviewClips(segments, 1).map((entry) => entry.clip.id)).toEqual(["1", "2", "3"]);
    expect(preparedPreviewClips(segments, 30)).toEqual([]);
  });
});
