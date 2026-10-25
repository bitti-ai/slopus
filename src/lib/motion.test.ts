import { describe, expect, it } from "vitest";
import { emptyMotion, MOTION_MIME, motionNodeSchema, motionOverrideSchema, motionSchema } from "./motion";
import { evaluateMotion, type MotionUpdate } from "./motionEvaluation";
import { motionReferenceExport, motionVideoReference } from "./motionReference";
import { createProjectConfig, isReferenceUsable, parseProjectConfig, type ProjectAsset } from "./project";
import { visibleClipsAt } from "./export";

function fixture() {
  const motion = emptyMotion(320, 180);
  motion.nodes = [motionNodeSchema.parse({ id: "title", name: "Title", kind: "text", text: "Original" })];
  motion.parameters = [{ id: "speed", label: "Speed", type: "number", value: 40 }];
  const asset: ProjectAsset = { id: "motion-test", name: "Test", kind: "motion", mimeType: MOTION_MIME, motion, createdAt: new Date(0).toISOString() };
  const config = createProjectConfig({ name: "Test", prompt: "Test", resolution: "720p", aspectRatio: "16:9", targetDurationSeconds: 5 });
  config.assets = [asset];
  return { motion, asset, config };
}

describe("Motions", () => {
  it("derives beat timing from source trim and arbitrary seek time without accumulating state", () => {
    const { motion } = fixture();
    motion.music = { songId: "song", assetId: "audio", bpm: 120, beatOffsetSeconds: 0.25, beatsPerBar: 4, sourceAt: 5 };
    const seen: unknown[] = [];
    const update: MotionUpdate = ({ music }) => { seen.push(music); };
    evaluateMotion(motion, 0.375, update); evaluateMotion(motion, 3, update); evaluateMotion(motion, 0.375, update);
    expect(seen[0]).toEqual(seen[2]);
    expect(seen[0]).toMatchObject({ time: 5.375, beat: 10.25, beatIndex: 10, phase: 0.25, bar: 2, beatInBar: 2 });
    motion.music.sourceAt = 0;
    evaluateMotion(motion, 0, update);
    expect(seen[3]).toMatchObject({ beat: -0.5, beatIndex: -1, phase: 0.5, bar: -1, beatInBar: 3 });
    const { config, asset } = fixture(); config.assets = [{ ...asset, motion }];
    expect(parseProjectConfig(config).assets[0].motion?.music).toEqual(motion.music);
    expect(motionSchema.safeParse({ ...motion, music: { ...motion.music, bpm: 0 } }).success).toBe(false);
  });
  it("evaluates arbitrary seeks independently and applies editable overrides after animation", () => {
    const { motion } = fixture();
    motion.overrides.title = motionOverrideSchema.parse({ offset: [10, 20, 0], text: "Edited", scale: [2, 1, 1] });
    const update: MotionUpdate = ({ nodes, time, parameters, random }, draw) => {
      nodes[0].position[0] += time * Number(parameters.speed);
      draw.ellipse({ id: "particle", position: [random() * 100, 0, 0] });
    };
    const frame = evaluateMotion(motion, 2, update);
    evaluateMotion(motion, 4, update);
    expect(evaluateMotion(motion, 2, update)).toEqual(frame);
    expect(frame[0]).toMatchObject({ position: [90, 20, 0], text: "Edited", scale: [2, 1, 1] });
    expect(motion.nodes[0]).toMatchObject({ position: [0, 0, 0], text: "Original" });
    expect(evaluateMotion(motion, 100, update)[0].position[0]).toBe(210);
  });
  it("supports scene IDs that also name Object prototype properties", () => {
    const { motion } = fixture();
    motion.nodes[0].id = "constructor";
    expect(evaluateMotion(motion, 0, () => {})[0].position).toEqual([0, 0, 0]);
  });
  it("rejects invalid script output, duplicate IDs and asynchronous updates", () => {
    const { motion } = fixture();
    expect(() => evaluateMotion(motion, 0, ({ nodes }) => { nodes[0].position[0] = Infinity; })).toThrow();
    expect(() => evaluateMotion(motion, 0, (_, draw) => draw.rect({ id: "title" }))).toThrow(/unique/);
    expect(() => evaluateMotion(motion, 0, async () => {})).toThrow(/synchronous/);
    expect(() => evaluateMotion(motion, 0, (_, draw) => { for (let i = 0; i < 1024; i++) draw.rect({}); })).toThrow(/1024/);
  });
  it("round trips inline scenes, source, parameters and adjustments without a media path", () => {
    const { config, motion } = fixture();
    motion.overrides.title = motionOverrideSchema.parse({ offset: [7, 9, 0] });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).assets[0].motion).toEqual(motion);
    expect(() => parseProjectConfig({ ...config, assets: [{ ...config.assets[0], relativePath: "media/fake.mp4" }] })).toThrow();
    expect(motionSchema.safeParse({ ...motion, overrides: { missing: {} } }).success).toBe(false);
    expect(motionSchema.safeParse({ ...motion, parameters: [{ id: "speed", label: "Speed", type: "number", value: "wrong" }] }).success).toBe(false);
  });
  it("bakes only the selected Motion and creates a usable video reference", () => {
    const { config, asset, motion } = fixture();
    motion.duration = 0.5;
    const result = motionReferenceExport(config, asset);
    expect(result.plan.blockers).toEqual([]);
    expect(result.plan.frameCount).toBe(48);
    expect(result.settings.frameRate).toBe(24);
    expect(result.config.timeline.tracks[0].clips).toHaveLength(1);
    expect(result.config.timeline.tracks[0].clips[0].durationMs).toBe(2000);
    expect(config.timeline.tracks[0].clips).toHaveLength(0);
    expect(result.config.assets[0].motion).not.toBe(motion);
    const reference = motionVideoReference(asset, "media/motion-test.mp4");
    expect(isReferenceUsable(reference)).toBe(true);
    expect(reference.video).toMatchObject({ mode: "video", durationSeconds: 2, includeAudio: false });
    motion.duration = 20;
    expect(motionVideoReference(asset, "media/motion-long.mp4").video?.durationSeconds).toBe(15);
  });
  it("keeps opaque footage underneath transparent Motion layers", () => {
    const { config, asset } = fixture();
    const { config: snapshot } = motionReferenceExport(config, asset);
    const top = snapshot.timeline.tracks[0]; top.muted = false;
    const background: ProjectAsset = { id: "video", kind: "video", name: "Video", mimeType: "video/mp4", relativePath: "media/video.mp4", createdAt: asset.createdAt };
    const bottom = { ...top, id: "bottom", clips: [{ ...top.clips[0], id: "video-clip", assetId: "video", trackId: "bottom" }] };
    expect(visibleClipsAt([top, bottom], 100, new Map([[asset.id, asset], [background.id, background]])).map(c => c.assetId)).toEqual([asset.id, "video"]);
  });
});
