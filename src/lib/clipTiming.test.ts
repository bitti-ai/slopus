import { expect, it } from "vitest";
import { createProjectConfig, parseProjectConfig, type TimelineClip, type TimelineTrack } from "./project";
import { clipPlaybackRate, clipSourceTimeMs } from "./clipTiming";
import { retimeClip, sourceRoom, trimClip } from "./timeline";
import { buildExportPlan, defaultExportSettings, sourceTimeMsForFrame } from "./export";

const clip: TimelineClip = { id: "clip", assetId: "asset", trackId: "track", label: "Clip", status: "approved", startMs: 1000, durationMs: 4000, sourceStartMs: 2000 };
const tracks: TimelineTrack[] = [{ id: "track", name: "Video", kind: "video", locked: false, muted: false,
  clips: [clip, { ...clip, id: "next", startMs: 6000 }] }];

it.each([0.25, 0.5, 2, 4])("retimes at %sx preserving the source range and following gaps", (rate) => {
  const next = retimeClip(tracks, "clip", rate)!;
  const changed = next[0].clips[0];
  expect(changed.durationMs).toBe(4000 / rate);
  expect(clipSourceTimeMs(changed, changed.startMs + changed.durationMs)).toBe(6000);
  expect(next[0].clips[1].startMs - changed.startMs - changed.durationMs).toBe(1000);
  expect(retimeClip(next, "clip", 1)![0].clips).toEqual([{ ...clip, playbackRate: 1 }, tracks[0].clips[1]]);
  expect(tracks[0].clips[0]).toBe(clip);
});

it("rejects invalid rates and locked tracks", () => {
  for (const rate of [0, -1, NaN, Infinity, 0.24, 4.1]) expect(retimeClip(tracks, "clip", rate)).toBeNull();
  expect(retimeClip([{ ...tracks[0], locked: true }], "clip", 2)).toBeNull();
  expect(clipPlaybackRate(clip)).toBe(1);
});

it("does not round retimed clips beyond the available source", () => {
  const next = retimeClip([{ ...tracks[0], clips: [{ ...clip, durationMs: 4003 }] }], "clip", 4)![0].clips[0];
  expect(clipSourceTimeMs(next, next.startMs + next.durationMs)).toBeLessThanOrEqual(6003);
});

it.each([0.5, 2])("trims in source time at %sx", (rate) => {
  const changed = retimeClip(tracks, "clip", rate)!;
  const room = sourceRoom(changed[0].clips[0], 8000);
  expect(room).toEqual({ headMs: 2000 / rate, tailMs: 2000 / rate });
  const trimmed = trimClip(changed, "clip", "start", 1500, { minClipMs: 33, room })![0].clips[0];
  expect(trimmed.sourceStartMs).toBe(2000 + 500 * rate);
  expect(clipSourceTimeMs(trimmed, trimmed.startMs + trimmed.durationMs)).toBe(6000);
});

it("persists rates and exports foreground, underlay and audio source times", () => {
  const config = createProjectConfig({ name: "Speed", prompt: "", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 10 });
  config.assets = [{ id: "asset", name: "Video", kind: "video", relativePath: "video.mp4", mimeType: "video/mp4", hasAudio: true, durationMs: 20000, createdAt: config.createdAt }];
  config.timeline.tracks = [{ ...tracks[0], clips: [{ ...clip, playbackRate: 2, look: { opacity: 50 } }] },
    { ...tracks[0], id: "lower", clips: [{ ...clip, id: "lower", trackId: "lower", playbackRate: 0.5 }] }];
  const loaded = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  const plan = buildExportPlan(loaded, { ...defaultExportSettings(loaded), frameRate: 30 });
  const segment = plan.segments.find((item) => item.kind === "clip");
  if (!segment || segment.kind !== "clip") throw new Error("Missing clip");
  expect(sourceTimeMsForFrame(segment, 60, 30)).toBe(4000);
  expect(sourceTimeMsForFrame(segment.underlays![0], 60, 30)).toBe(2500);
  expect(plan.audio.map((item) => item.playbackRate)).toEqual([2, 0.5]);
  expect(() => parseProjectConfig({ ...config, timeline: { tracks: [{ ...tracks[0], clips: [{ ...clip, playbackRate: 0 }] }] } })).toThrow();
});
