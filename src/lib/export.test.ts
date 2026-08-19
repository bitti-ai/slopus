import { describe, expect, it } from "vitest";
import {
  bitrateFor,
  buildExportPlan,
  defaultExportSettings,
  estimatedBytes,
  fitRect,
  formatBytes,
  formatDuration,
  outputDimensions,
  sourceTimeMsForFrame,
  suggestedFileName,
  videoDurationMs,
  visibleClipAt,
  type ExportSegment,
  type ExportSettings,
} from "./export";
import { createProjectConfig, type ProjectAsset, type ProjectConfig, type TimelineClip } from "./project";

const asset = (id: string, overrides: Partial<ProjectAsset> = {}): ProjectAsset => ({
  id,
  kind: "video",
  name: id,
  relativePath: `media/${id}.mp4`,
  mimeType: "video/mp4",
  durationMs: 10_000,
  width: 1920,
  height: 1080,
  createdAt: new Date(0).toISOString(),
  ...overrides,
});

const clip = (id: string, trackId: string, startMs: number, durationMs: number, overrides: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  assetId: `asset-${id}`,
  trackId,
  startMs,
  durationMs,
  sourceStartMs: 0,
  label: id,
  color: null,
  status: "approved",
  ...overrides,
});

/** A project with the app's own four tracks, `clips` distributed by trackId.
 *  `track-story` is "Track 1, Video" — the FIRST video track, and the one that
 *  composites over "Track 2, Video" (`track-v2`), because the timeline draws
 *  tracks in array order from the top. */
function project(clips: TimelineClip[], assets: ProjectAsset[], overrides: Partial<ProjectConfig["settings"]> = {}): ProjectConfig {
  const base = createProjectConfig({
    name: "Test", prompt: "A test", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30,
  });
  return {
    ...base,
    settings: { ...base.settings, ...overrides },
    assets,
    timeline: {
      tracks: base.timeline.tracks.map((track) => ({ ...track, clips: clips.filter((item) => item.trackId === track.id) })),
    },
  };
}

const settings = (overrides: Partial<ExportSettings> = {}): ExportSettings => ({
  resolution: "1080p", frameRate: 30, codec: "h264", quality: "balanced", ...overrides,
});

const clipSegments = (segments: ExportSegment[]) => segments.flatMap((segment) => (segment.kind === "clip" ? [segment] : []));

describe("output geometry", () => {
  it("gives every aspect ratio the same short edge", () => {
    expect(outputDimensions("1080p", "16:9")).toEqual({ width: 1920, height: 1080 });
    expect(outputDimensions("1080p", "9:16")).toEqual({ width: 1080, height: 1920 });
    expect(outputDimensions("1080p", "1:1")).toEqual({ width: 1080, height: 1080 });
    expect(outputDimensions("1080p", "4:5")).toEqual({ width: 1080, height: 1350 });
    expect(outputDimensions("720p", "16:9")).toEqual({ width: 1280, height: 720 });
    expect(outputDimensions("4k", "16:9")).toEqual({ width: 3840, height: 2160 });
  });

  it("never produces an odd edge, which a 4:2:0 encoder refuses", () => {
    for (const resolution of ["720p", "1080p", "4k"] as const) {
      for (const ratio of ["16:9", "9:16", "1:1", "4:5"] as const) {
        const { width, height } = outputDimensions(resolution, ratio);
        expect(width % 2).toBe(0);
        expect(height % 2).toBe(0);
      }
    }
  });

  it("fits a wide source into a tall frame with bars above and below", () => {
    const box = fitRect(1920, 1080, 1080, 1920);
    expect(box.width).toBe(1080);
    expect(box.height).toBeCloseTo(607.5, 3);
    expect(box.x).toBe(0);
    expect(box.y).toBeCloseTo((1920 - 607.5) / 2, 3);
  });

  it("fills the frame exactly when the source already matches it", () => {
    expect(fitRect(1920, 1080, 1280, 720)).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("falls back to the whole frame rather than dividing by a zero size", () => {
    expect(fitRect(0, 0, 640, 360)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
});

describe("defaults", () => {
  it("starts from the project's own settings instead of inventing numbers", () => {
    const config = project([], [], { resolution: "4k", frameRate: 24 });
    expect(defaultExportSettings(config)).toEqual({ resolution: "4k", frameRate: 24, codec: "h264", quality: "balanced" });
  });

  it("derives the bitrate from the frame size and rate", () => {
    expect(bitrateFor(1920, 1080, 30, "balanced")).toBe(Math.round(1920 * 1080 * 30 * 0.09));
    expect(bitrateFor(1920, 1080, 30, "draft")).toBeLessThan(bitrateFor(1920, 1080, 30, "high"));
    expect(estimatedBytes(8_000_000, 10_000)).toBe(10_000_000);
  });
});

describe("which clip is on screen at time T", () => {
  const tracks = () =>
    project(
      [clip("a", "track-v2", 0, 4_000), clip("b", "track-v2", 4_000, 4_000), clip("over", "track-story", 2_000, 1_000)],
      [],
    ).timeline.tracks;

  it("treats a clip as covering its start and not its end", () => {
    expect(visibleClipAt(tracks(), 0)?.id).toBe("a");
    expect(visibleClipAt(tracks(), 3_999)?.id).toBe("a");
    expect(visibleClipAt(tracks(), 4_000)?.id).toBe("b");
    expect(visibleClipAt(tracks(), 7_999)?.id).toBe("b");
    expect(visibleClipAt(tracks(), 8_000)).toBeNull();
  });

  it("lets the upper track cover the one below it", () => {
    expect(visibleClipAt(tracks(), 2_500)?.id).toBe("over");
    expect(visibleClipAt(tracks(), 2_999)?.id).toBe("over");
    expect(visibleClipAt(tracks(), 3_000)?.id).toBe("a");
  });

  it("puts the later clip on top when two on one track overlap", () => {
    const overlapping = project([clip("under", "track-story", 0, 4_000), clip("later", "track-story", 1_000, 1_000)], []);
    expect(visibleClipAt(overlapping.timeline.tracks, 1_500)?.id).toBe("later");
    expect(visibleClipAt(overlapping.timeline.tracks, 500)?.id).toBe("under");
  });

  it("ignores audio tracks, which have no picture", () => {
    const withSound = project([clip("music", "track-a2", 0, 5_000)], []);
    expect(visibleClipAt(withSound.timeline.tracks, 1_000)).toBeNull();
    expect(videoDurationMs(withSound)).toBe(0);
  });
});

describe("the plan", () => {
  it("turns two back-to-back clips into two segments of the right length", () => {
    const config = project(
      [clip("a", "track-story", 0, 2_000), clip("b", "track-story", 2_000, 1_000)],
      [asset("asset-a"), asset("asset-b")],
    );
    const plan = buildExportPlan(config, settings());
    expect(plan.durationMs).toBe(3_000);
    expect(plan.frameCount).toBe(90);
    expect(plan.clipCount).toBe(2);
    expect(plan.gapFrames).toBe(0);
    expect(plan.blockers).toEqual([]);
    expect(clipSegments(plan.segments).map((segment) => [segment.clipId, segment.startFrame, segment.endFrame])).toEqual([
      ["a", 0, 60],
      ["b", 60, 90],
    ]);
  });

  it("counts frames at the rate the user picked, not the project's", () => {
    const config = project([clip("a", "track-story", 0, 2_000)], [asset("asset-a")]);
    expect(buildExportPlan(config, settings({ frameRate: 24 })).frameCount).toBe(48);
    expect(buildExportPlan(config, settings({ frameRate: 60 })).frameCount).toBe(120);
  });

  it("fills a hole between clips with background frames and says so", () => {
    const config = project(
      [clip("a", "track-story", 0, 1_000), clip("b", "track-story", 2_000, 1_000)],
      [asset("asset-a"), asset("asset-b")],
    );
    const plan = buildExportPlan(config, settings());
    expect(plan.segments.map((segment) => segment.kind)).toEqual(["clip", "gap", "clip"]);
    expect(plan.gapFrames).toBe(30);
    expect(plan.notes.join(" ")).toContain("30 of 90 frames have no clip over them");
  });

  it("splits one clip into two segments when an overlay cuts through it", () => {
    const config = project(
      [clip("under", "track-v2", 0, 3_000), clip("over", "track-story", 1_000, 1_000)],
      [asset("asset-under"), asset("asset-over")],
    );
    const plan = buildExportPlan(config, settings());
    expect(clipSegments(plan.segments).map((segment) => [segment.clipId, segment.startFrame, segment.endFrame])).toEqual([
      ["under", 0, 30],
      ["over", 30, 60],
      ["under", 60, 90],
    ]);
    expect(plan.clipCount).toBe(2);
  });

  it("mixes the audio that lands inside the picture, and cuts it where the picture ends", () => {
    const config = project(
      [clip("a", "track-story", 0, 1_000), clip("score", "track-a2", 0, 5_000)],
      [asset("asset-a"), asset("asset-score", { kind: "audio", mimeType: "audio/wav" })],
    );
    const plan = buildExportPlan(config, settings());
    expect(plan.audioClipCount).toBe(1);
    expect(plan.durationMs).toBe(1_000);
    // The clip is 5s long over a 1s picture: 1s of it is in the file, and the
    // page says where the rest went rather than dropping it in silence.
    expect(plan.audio).toEqual([
      { clipId: "score", assetId: "asset-score", label: "score", startMs: 0, durationMs: 1_000, sourceStartMs: 0 },
    ]);
    expect(plan.notes.join(" ")).toContain("mixed into an AAC track");
    expect(plan.notes.join(" ")).toContain("stops with the picture at 00:01.000");
  });

  it("keeps its own trim: a clip starting late plays from where it was cut, not from zero", () => {
    const config = project(
      [
        clip("a", "track-story", 0, 8_000),
        clip("vo", "track-a1", 2_000, 3_000, { sourceStartMs: 4_500 }),
      ],
      [asset("asset-a"), asset("asset-vo", { kind: "audio", mimeType: "audio/wav" })],
    );
    expect(buildExportPlan(config, settings()).audio).toEqual([
      { clipId: "vo", assetId: "asset-vo", label: "vo", startMs: 2_000, durationMs: 3_000, sourceStartMs: 4_500 },
    ]);
  });

  it("leaves out audio that starts after the last frame, and says how much", () => {
    const config = project(
      [clip("a", "track-story", 0, 1_000), clip("late", "track-a1", 4_000, 2_000)],
      [asset("asset-a"), asset("asset-late", { kind: "audio", mimeType: "audio/wav" })],
    );
    const plan = buildExportPlan(config, settings());
    expect(plan.audio).toEqual([]);
    expect(plan.notes.join(" ")).toContain("after the last video frame");
  });

  it("does not mix a muted track, and says that too", () => {
    const config = project(
      [clip("a", "track-story", 0, 4_000), clip("score", "track-a2", 0, 4_000)],
      [asset("asset-a"), asset("asset-score", { kind: "audio", mimeType: "audio/wav" })],
    );
    const muted = {
      ...config,
      timeline: {
        tracks: config.timeline.tracks.map((track) => (track.id === "track-a2" ? { ...track, muted: true } : track)),
      },
    };
    const plan = buildExportPlan(muted, settings());
    expect(plan.audio).toEqual([]);
    expect(plan.notes.join(" ")).toContain("muted track");
  });

  it("counts overlapping audio as summed rather than picking a winner", () => {
    const config = project(
      [
        clip("a", "track-story", 0, 6_000),
        clip("vo", "track-a1", 0, 4_000),
        clip("score", "track-a2", 2_000, 4_000),
      ],
      [
        asset("asset-a"),
        asset("asset-vo", { kind: "audio", mimeType: "audio/wav" }),
        asset("asset-score", { kind: "audio", mimeType: "audio/wav" }),
      ],
    );
    const plan = buildExportPlan(config, settings());
    expect(plan.audio).toHaveLength(2);
    expect(plan.notes.join(" ")).toContain("overlaps are summed");
  });

  it("blocks on an empty timeline, on missing media and on a container it cannot demux", () => {
    expect(buildExportPlan(project([], []), settings()).blockers[0]).toContain("no video clips");

    const orphan = project([clip("a", "track-story", 0, 1_000)], []);
    expect(buildExportPlan(orphan, settings()).blockers.join(" ")).toContain("not in this project");

    const webm = project([clip("a", "track-story", 0, 1_000)], [asset("asset-a", { mimeType: "video/webm" })]);
    expect(buildExportPlan(webm, settings()).blockers.join(" ")).toContain("video/webm");
  });

  it("accepts a still image on a video track", () => {
    const config = project([clip("a", "track-story", 0, 1_000)], [asset("asset-a", { kind: "image", mimeType: "image/png" })]);
    expect(buildExportPlan(config, settings()).blockers).toEqual([]);
  });

  it("reports clips that are hidden underneath another track", () => {
    const config = project(
      [clip("hidden", "track-v2", 0, 1_000), clip("over", "track-story", 0, 1_000)],
      [asset("asset-hidden"), asset("asset-over")],
    );
    expect(buildExportPlan(config, settings()).notes.join(" ")).toContain("hidden underneath");
  });
});

describe("where each output frame comes from inside the source file", () => {
  it("starts at the clip's own trim point and advances one frame at a time", () => {
    const config = project(
      [clip("a", "track-story", 4_000, 2_000, { sourceStartMs: 10_000 })],
      [asset("asset-a")],
    );
    const plan = buildExportPlan(config, settings({ frameRate: 25 }));
    const [segment] = clipSegments(plan.segments);
    expect([segment.startFrame, segment.endFrame]).toEqual([100, 150]);
    // Output frame 100 sits at 4000 ms, which is the first frame of the clip.
    expect(sourceTimeMsForFrame(segment, 100, 25)).toBe(10_000);
    expect(sourceTimeMsForFrame(segment, 101, 25)).toBe(10_040);
    expect(sourceTimeMsForFrame(segment, 149, 25)).toBe(11_960);
  });

  it("keeps the source offset when a clip does not begin on a frame boundary", () => {
    const config = project([clip("a", "track-story", 0, 1_000, { sourceStartMs: 500 })], [asset("asset-a")]);
    const plan = buildExportPlan(config, settings({ frameRate: 24 }));
    const [segment] = clipSegments(plan.segments);
    // 24 fps has no frame at 500 ms; frame 12 is at 500 ms exactly, frame 13 at 541.67.
    expect(sourceTimeMsForFrame(segment, 0, 24)).toBe(500);
    expect(sourceTimeMsForFrame(segment, 12, 24)).toBe(1_000);
    expect(sourceTimeMsForFrame(segment, 13, 24)).toBeCloseTo(1_041.667, 3);
  });

  it("reads the second half of a split clip from the second half of the file", () => {
    const config = project(
      [
        clip("a", "track-story", 0, 1_000, { sourceStartMs: 0 }),
        clip("a-b", "track-story", 1_000, 1_000, { assetId: "asset-a", sourceStartMs: 1_000 }),
      ],
      [asset("asset-a")],
    );
    const plan = buildExportPlan(config, settings());
    const [first, second] = clipSegments(plan.segments);
    expect(sourceTimeMsForFrame(first, first.startFrame, 30)).toBe(0);
    expect(sourceTimeMsForFrame(second, second.startFrame, 30)).toBe(1_000);
    expect(second.assetId).toBe("asset-a");
  });
});

describe("formatting", () => {
  it("scales bytes without claiming precision it does not have", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_400)).toBe("2.4 kB");
    expect(formatBytes(15_600_000)).toBe("15.6 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.4 GB");
  });

  it("writes a timeline duration to the millisecond", () => {
    expect(formatDuration(0)).toBe("00:00.000");
    expect(formatDuration(31_800)).toBe("00:31.800");
    expect(formatDuration(125_004)).toBe("02:05.004");
  });

  it("turns a project name into something a filesystem accepts", () => {
    expect(suggestedFileName("Northern Light — Brand Film")).toBe("Northern Light — Brand Film.mp4");
    expect(suggestedFileName("a/b:c*d?")).toBe("a b c d.mp4");
    expect(suggestedFileName("   ")).toBe("PolStudio export.mp4");
  });
});
