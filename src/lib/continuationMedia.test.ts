import { expect, it } from "vitest";
import { assetSceneSegment, continuationPlaybackTracks, joinedSceneSegments, sceneArchiveSegments, sceneMediaDurationMs } from "./continuationMedia";
import { createDraftGenerationJob, createProjectConfig, generationAssetId, parseProjectConfig, sceneOutputFrames, type SceneMediaSegment } from "./project";
import { buildExportPlan, defaultExportSettings } from "./export";

function project() {
  const config = createProjectConfig({ name: "Joined", prompt: "Ride", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 15 });
  const segments: SceneMediaSegment[] = [
    { sceneId: "a", latentRelativePath: "latents/a.safetensors", startFrame: 0, frameCount: 124 },
    { sceneId: "b", latentRelativePath: "latents/b.safetensors", startFrame: 124, frameCount: 119 },
    { sceneId: "c", latentRelativePath: "latents/c.safetensors", startFrame: 243, frameCount: 119 },
  ];
  config.generationJobs = segments.map((part) => ({ ...createDraftGenerationJob("Ride", { id: part.sceneId }), status: "completed" as const, latentRelativePath: part.latentRelativePath }));
  config.assets = segments.map((part, index) => ({ id: generationAssetId(part.sceneId), kind: "generated", mimeType: "video/mp4", name: part.sceneId,
    relativePath: `media/${part.sceneId}.mp4`, hasAudio: true, createdAt: config.createdAt,
    durationMs: Math.round((part.startFrame + part.frameCount) * 1000 / 24), sceneSegments: segments.slice(0, index + 1),
  }));
  let startMs = 0;
  config.timeline.tracks[0].clips = segments.map((part) => {
    const durationMs = Math.round(part.frameCount * 1000 / 24);
    const clip = { id: part.sceneId, assetId: generationAssetId(part.sceneId), trackId: config.timeline.tracks[0].id, label: part.sceneId,
      startMs, sourceStartMs: 0, durationMs, status: "generated" as const, transform: { scale: 80, rotation: 0, positionX: 0, positionY: 0 } };
    startMs += durationMs;
    return clip;
  });
  return parseProjectConfig(config);
}

it("uses one joined source for both sides of every boundary in a chain, including exported audio", () => {
  const config = project();
  const authored = JSON.stringify(config.timeline);
  const clips = continuationPlaybackTracks(config)[0].clips;
  expect(clips.map((clip) => clip.assetId)).toEqual(["asset-c", "asset-c", "asset-c"]);
  expect(clips.map((clip) => clip.sourceStartMs)).toEqual([0, 124 * 1000 / 24, 243 * 1000 / 24]);
  expect(clips.map((clip) => clip.transform)).toEqual(config.timeline.tracks[0].clips.map((clip) => clip.transform));
  const plan = buildExportPlan(config, defaultExportSettings(config));
  expect(plan.segments.filter((segment) => segment.kind === "clip").map((segment) => segment.assetId)).toEqual(["asset-c", "asset-c", "asset-c"]);
  expect(plan.audio.map((segment) => segment.assetId)).toEqual(["asset-c", "asset-c", "asset-c"]);
  expect(plan.audio.map((segment) => segment.sourceStartMs)).toEqual(clips.map((clip) => clip.sourceStartMs));
  expect(JSON.stringify(config.timeline)).toBe(authored);
  expect(sceneOutputFrames(config.generationJobs[2], config)).toBe(119);
  expect(sceneMediaDurationMs(config.assets[2])).toBe(4958);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).assets[2].sceneSegments).toEqual(config.assets[2].sceneSegments);
});

it("keeps standalone scenes and trims in scene coordinates", () => {
  const config = project();
  const b = config.timeline.tracks[0].clips[1];
  b.sourceStartMs = 500;
  b.durationMs -= 500;
  config.timeline.tracks[0].clips = [b];
  const resolved = continuationPlaybackTracks(config)[0].clips[0];
  expect(resolved).toMatchObject({ assetId: "asset-b", sourceStartMs: 124 * 1000 / 24 + 500, durationMs: b.durationMs });
});

it("shares joined sources across a cut between different tracks", () => {
  const config = project();
  const b = config.timeline.tracks[0].clips.splice(1, 1)[0];
  config.timeline.tracks[1].clips = [{ ...b, trackId: config.timeline.tracks[1].id }];
  expect(continuationPlaybackTracks(config).flatMap((track) => track.clips).map((clip) => clip.assetId)).toEqual(["asset-c", "asset-c", "asset-c"]);
});

it("does not silently switch to a different source generation or bridge gaps", () => {
  const config = project();
  config.assets[0].sceneSegments![0] = { ...config.assets[0].sceneSegments![0], latentRelativePath: "latents/a-rerender.safetensors" };
  expect(continuationPlaybackTracks(config)[0].clips[0].assetId).toBe("asset-a");
  config.timeline.tracks[0].clips[2].startMs += 100;
  expect(continuationPlaybackTracks(config)[0].clips[1].assetId).toBe("asset-b");
});

it("preserves branch identity when the same source appears before different continuations", () => {
  const config = project();
  const [a, b, c] = config.timeline.tracks[0].clips;
  config.assets[2].sceneSegments = joinedSceneSegments("c", "latents/c.safetensors", 243, 119, {
    sceneId: "a", latentRelativePath: "latents/a.safetensors", frameCount: 124, segments: config.assets[0].sceneSegments!,
  });
  config.timeline.tracks[0].clips = [a, b, { ...a, id: "a-again", startMs: c.startMs }, { ...c, startMs: c.startMs + a.durationMs }];
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(["asset-b", "asset-b", "asset-c", "asset-c"]);
});

it("reconstructs old suffix-only archives from saved generations, not edited scene settings", () => {
  const config = project();
  config.assets.forEach((asset) => { asset.durationMs = sceneMediaDurationMs(asset); delete asset.sceneSegments; });
  config.generationJobs[1].generationSnapshot = JSON.stringify({ continuationRelativePath: "latents/a.safetensors", previousSceneId: "a", frames: 119 });
  config.generationJobs[1].continuationSceneId = "c";
  const prefix = sceneArchiveSegments(config, config.generationJobs[1])!;
  expect(prefix.map((part) => part.startFrame)).toEqual([0, 124]);
  config.assets[2].durationMs = Math.round(362 * 1000 / 24);
  config.assets[2].sceneSegments = joinedSceneSegments("c", "latents/c.safetensors", 362, 119, {
    sceneId: "b", latentRelativePath: "latents/b.safetensors", frameCount: 119, segments: prefix,
  });
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(["asset-c", "asset-c", "asset-c"]);
  expect(assetSceneSegment(config.assets[1], config.generationJobs)?.startFrame).toBe(0);
});

it("keeps Beginning overlap ranges separate and rejects suffix-only worker results", () => {
  const config = project();
  config.assets[1].sceneSegments = joinedSceneSegments("b", "latents/b.safetensors", 141, 119, {
    sceneId: "a", latentRelativePath: "latents/a.safetensors", frameCount: 124, from: "start",
  });
  config.timeline.tracks[0].clips.pop();
  expect(continuationPlaybackTracks(config)[0].clips.map((clip) => clip.assetId)).toEqual(["asset-a", "asset-b"]);
  expect(config.assets[1].sceneSegments.map((part) => [part.startFrame, part.frameCount])).toEqual([[0, 22], [22, 119]]);
  expect(() => joinedSceneSegments("b", "latents/b.safetensors", 119, 119, { sceneId: "a", latentRelativePath: "latents/a.safetensors", frameCount: 124 })).toThrow("Update the worker");
});
