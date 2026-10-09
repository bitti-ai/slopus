import { expect, it } from "vitest";
import { bridgedSceneSegments, currentLongShotArchives, longShotBlocker, longShotInputs, longShotPosition } from "./longShot";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneOutputFrames } from "./project";
import { continuationPlaybackTracks, joinedSceneSegments, sceneMediaDurationMs, sceneMediaStartSeconds } from "./continuationMedia";
import { sceneGenerationRequest } from "./sceneGeneration";
import { buildExportPlan, defaultExportSettings } from "./export";

function project() {
  const config = createProjectConfig({ name: "Long Shot", prompt: "Walk", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.generationJobs = Array.from({ length: 5 }, (_, i) => ({ ...createDraftGenerationJob("Walk", { id: String(i + 1), sceneType: "long-shot" }),
    durationSeconds: 2, status: "completed" as const, outputRelativePath: `media/${i + 1}.mp4`, latentRelativePath: `latents/${i + 1}.safetensors` }));
  config.assets = config.generationJobs.map((job) => ({ id: `asset-${job.id}`, kind: "generated", name: job.id, relativePath: job.outputRelativePath,
    mimeType: "video/mp4", hasAudio: true, durationMs: Math.round(124 / 24 * 1000), createdAt: config.createdAt,
    sceneSegments: [{ sceneId: job.id, startFrame: 0, frameCount: 124, latentRelativePath: job.latentRelativePath! }] }));
  // The bridge gap is 46 frames; original anchors stay unchanged.
  const b = longShotInputs(config.generationJobs[1], config)!;
  config.assets[1].sceneSegments = bridgedSceneSegments("2", "latents/2.safetensors", 294, 30, b.bridge, b.leftSegments);
  config.assets[1].durationMs = 12250;
  return config;
}

it("alternates within consecutive runs and blocks missing, failed and short anchors", () => {
  const config = project();
  expect(config.generationJobs.map((job) => longShotPosition(job, config.generationJobs)?.bridge)).toEqual([false, true, false, true, false]);
  expect(longShotBlocker(config.generationJobs[1], config)).toBeNull();
  config.generationJobs[2].status = "failed";
  expect(longShotBlocker(config.generationJobs[1], config)).toContain("Generate");
  expect(longShotBlocker(config.generationJobs[1], config, false)).toBeNull();
  config.generationJobs[2].status = "completed";
  config.generationJobs[1].bridgeRightMargin = 119;
  expect(longShotBlocker(config.generationJobs[1], config)).toContain("141 frames");
  config.generationJobs[2].sceneType = "backdrop";
  expect(longShotBlocker(config.generationJobs[1], config)).toBeNull();
  expect(longShotPosition(config.generationJobs[1], config.generationJobs)?.continuation).toBe(true);
  expect(longShotPosition(config.generationJobs[3], config.generationJobs)?.bridge).toBe(false);
});

it("continues the last scene from the joined archive and invalidates it when a following anchor is added", () => {
  const config = project();
  const fifth = config.generationJobs.pop()!;
  const last = config.generationJobs[3];
  expect(longShotBlocker(last, config)).toBeNull();
  const request = sceneGenerationRequest(last, config, "C:/project", 8);
  expect(request.latentBridge).toBeUndefined();
  expect(request).toMatchObject({ previousSceneId: "3", continuationRelativePath: "latents/2.safetensors",
    continuationSourceFrames: 124, continuationOverlapFrames: 22, continuationFrom: "end" });
  config.assets[3].sceneSegments = joinedSceneSegments("4", last.latentRelativePath!, 345, 51, {
    sceneId: "3", latentRelativePath: request.continuationRelativePath!, frameCount: 124, segments: config.assets[1].sceneSegments!,
  });
  const parts = config.assets[3].sceneSegments;
  expect(currentLongShotArchives(config).map((asset) => asset.id)).toEqual(["asset-4", "asset-2"]);
  let startMs = 0;
  config.timeline.tracks[0].clips = parts.map((part) => {
    const durationMs = Math.round(part.frameCount * 1000 / 24);
    const clip = { id: part.sceneId, assetId: `asset-${part.sceneId}`, trackId: config.timeline.tracks[0].id,
      label: part.sceneId, startMs, durationMs, sourceStartMs: 0, status: "generated" as const };
    startMs += durationMs;
    return clip;
  });
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(Array(4).fill("asset-4"));
  expect(buildExportPlan(config, defaultExportSettings(config)).audio.map((part) => part.assetId)).toEqual(Array(4).fill("asset-4"));
  config.generationJobs.push(fifth);
  expect(currentLongShotArchives(config).map((asset) => asset.id)).toEqual(["asset-2"]);
  expect(sceneGenerationRequest(last, config, "C:/project", 8).latentBridge).toBeDefined();
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(["asset-2", "asset-2", "asset-2", "asset-4"]);
});

it("chains complete archives to preserve both ends of shared anchors", () => {
  const config = project();
  const next = longShotInputs(config.generationJobs[3], config)!;
  expect(next.bridge).toMatchObject({ leftSceneId: "3", leftRelativePath: "latents/2.safetensors", leftFrames: 294, rightFrames: 124 });
  config.assets[3].sceneSegments = bridgedSceneSegments("4", "latents/4.safetensors", 464, 30, next.bridge, next.leftSegments);
  config.assets[3].durationMs = Math.round(464 / 24 * 1000);
  expect(currentLongShotArchives(config).map((asset) => asset.id)).toEqual(["asset-4", "asset-2"]);
  const segments = config.assets[3].sceneSegments;
  config.timeline.tracks[0].clips = segments.map((part) => ({ id: part.sceneId, assetId: `asset-${part.sceneId}`, trackId: config.timeline.tracks[0].id,
    label: part.sceneId, startMs: Math.round(part.startFrame / 24 * 1000), sourceStartMs: 100, durationMs: Math.round(part.frameCount / 24 * 1000) - 100, status: "generated" }));
  const original = JSON.stringify(config.timeline);
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(Array(5).fill("asset-4"));
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.sourceStartMs)).toEqual(segments.map((part) => 100 + part.startFrame * 1000 / 24));
  const exportPlan = buildExportPlan(config, defaultExportSettings(config));
  expect(exportPlan.audio.map((part) => part.assetId)).toEqual(Array(5).fill("asset-4"));
  expect(JSON.stringify(config.timeline)).toBe(original);
  expect(sceneOutputFrames(config.generationJobs[3], config)).toBe(46);
  expect(sceneMediaDurationMs(config.assets[3])).toBe(1917);
  expect(sceneMediaStartSeconds(config.assets[3])).toBe(294 / 24);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).assets[3].sceneSegments).toEqual(segments);
  // Rerendering an anchor makes every old joined decode ineligible.
  config.generationJobs[2].latentRelativePath = "latents/replaced.safetensors";
  expect(currentLongShotArchives(config)).toEqual([]);
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(["asset-1", "asset-2", "asset-3", "asset-4", "asset-5"]);
});

it("rejects suffix-only output and keeps fresh requests independent of saved frame anchors", () => {
  const config = project();
  const input = longShotInputs(config.generationJobs[1], config)!;
  expect(() => bridgedSceneSegments("2", "latents/new.safetensors", 46, 30, input.bridge)).toThrow("both anchors");
  config.generationJobs[0].startFrameReferenceId = "old";
  config.generationJobs[0].usePreviousSceneLastFrame = true;
  const request = sceneGenerationRequest(config.generationJobs[0], config, "C:/project", 8);
  expect(request.latentBridge).toBeUndefined();
  expect(request.previousSceneId).toBeUndefined();
  expect(request.referencePaths).toEqual([]);
});

it("uses standalone bridges when an older bridge is stale, and invalidates suffixes when it returns", () => {
  const config = project();
  // Regenerating 1 makes bridge 2 stale, without preventing a direct bridge 4.
  config.generationJobs[0].latentRelativePath = "latents/new-first.safetensors";
  config.assets[0].sceneSegments![0].latentRelativePath = config.generationJobs[0].latentRelativePath;
  const next = longShotInputs(config.generationJobs[3], config)!;
  expect(next.bridge.leftRelativePath).toBe("latents/3.safetensors");
  config.assets[3].sceneSegments = bridgedSceneSegments("4", "latents/4.safetensors", 294, 30, next.bridge, next.leftSegments);
  expect(currentLongShotArchives(config).map((asset) => asset.id)).toEqual(["asset-4"]);
  const previous = longShotInputs(config.generationJobs[1], config)!;
  config.assets[1].sceneSegments = bridgedSceneSegments("2", "latents/2.safetensors", 294, 30, previous.bridge, previous.leftSegments);
  expect(currentLongShotArchives(config).map((asset) => asset.id)).toEqual(["asset-2"]);
});
