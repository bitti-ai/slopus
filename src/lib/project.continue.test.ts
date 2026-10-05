import { expect, it } from "vitest";
import { compileGenerationJobPrompt, continuationBlocker, createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneFrameInputs, sceneGenerationSnapshot } from "./project";

const project = () => {
  const config = createProjectConfig({ name: "Continue", prompt: "A cyclist", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 6 });
  config.generationJobs = [createDraftGenerationJob("A cyclist", { id: "source" }), createDraftGenerationJob("Keeps riding", { id: "next", sceneType: "continue" })];
  return config;
};

it("migrates previous-scene links to stable explicit sources with the old defaults", () => {
  const config = project();
  config.generationJobs[1] = { ...config.generationJobs[1], sceneType: "first-last-frame", usePreviousSceneLastFrame: true };
  const restored = parseProjectConfig(config);
  expect(restored.generationJobs[1]).toMatchObject({ sceneType: "continue", continuationSceneId: "source", continuationOverlapFrames: 22, continuationFrom: "end" });
  restored.generationJobs.reverse();
  expect(sceneFrameInputs(restored.generationJobs[0], restored).previousSceneId).toBe("source");
  expect(sceneFrameInputs(restored.generationJobs[0], restored).continuationLockOverlap).toBe(false);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(restored)))).toEqual(restored);
});

it("uses the selected source and ignores saved first/last-frame selections", () => {
  const config = project();
  config.references = [{ id: "frame", kind: "image", name: "Frame", description: "", intendedUse: [], sourcePath: "C:/frame.png", createdAt: config.createdAt }];
  config.generationJobs[0].latentRelativePath = "latents/source.safetensors";
  config.assets = [{ id: "asset-source", kind: "generated", mimeType: "video/mp4", name: "Source", relativePath: "media/source.mp4", durationMs: 5167, createdAt: config.createdAt }];
  const next = { ...config.generationJobs[1], continuationSceneId: "source", continuationFrom: "start" as const, continuationOverlapFrames: 39, startFrameReferenceId: "frame", endFrameReferenceId: "frame" };
  const inputs = sceneFrameInputs(next, config);
  expect(inputs).toMatchObject({ previousSceneId: "source", continuationRelativePath: "latents/source.safetensors", continuationFrom: "start", continuationOverlapFrames: 39, continuationSourceFrames: 124, references: [] });
  expect(inputs.job.startFrameReferenceId).toBeUndefined();
  expect(inputs.job.endFrameReferenceId).toBeUndefined();
  expect(compileGenerationJobPrompt(next, config.references)).not.toContain("<Picture");
  const snapshot = JSON.parse(sceneGenerationSnapshot(next, { ...inputs, prompt: "Continue", frames: 100, steps: 4, seed: 1, canvasWidth: 64, canvasHeight: 32, referencePaths: [] }));
  expect(snapshot).toMatchObject({ continuationFrom: "start", continuationOverlapFrames: 39, previousSceneId: "source" });
});

it("blocks missing, self-referencing and cyclic continuation sources", () => {
  const config = project();
  const next = config.generationJobs[1];
  expect(continuationBlocker(next, config.generationJobs)).toContain("Select");
  next.continuationSceneId = "gone";
  expect(continuationBlocker(next, config.generationJobs)).toContain("no longer exists");
  next.continuationSceneId = "next";
  expect(continuationBlocker(next, config.generationJobs)).toContain("cycle");
  next.continuationSceneId = "source";
  expect(continuationBlocker(next, config.generationJobs)).toBeNull();
  Object.assign(config.generationJobs[0], { sceneType: "continue", continuationSceneId: "next" });
  expect(continuationBlocker(next, config.generationJobs)).toContain("cycle");
});

it("validates overlap increments and edge choices when loading", () => {
  for (const overlap of [0, 21, 23, 39.5, 379]) {
    const config = project();
    config.generationJobs[1].continuationOverlapFrames = overlap;
    expect(() => parseProjectConfig(config)).toThrow();
  }
  const config = project();
  config.generationJobs[1].continuationOverlapFrames = 56;
  expect(parseProjectConfig(config).generationJobs[1].continuationOverlapFrames).toBe(56);
});
