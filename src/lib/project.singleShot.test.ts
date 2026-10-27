import { expect, it } from "vitest";
import { continuationBlocker, createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneGenerationReferences, sceneGenerationSnapshot, sceneShots, type GenerationJob, type ProjectReference } from "./project";
import { sceneGenerationRequest, sendBlocker } from "./sceneGeneration";
import { duplicateScene, sceneInput } from "./sceneHistory";

const project = () => createProjectConfig({ name: "Single", prompt: "A dancer walks", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 10 });
const shot = (id: string): GenerationJob => createDraftGenerationJob("A dancer walks", { id, sceneType: "single-shot", durationSeconds: 6 });

it("maps Single Shot Continuation to source noise, persists it in takes and invalidates snapshots", () => {
  const config = project(), source = { ...shot("source"), latentRelativePath: "latents/source.safetensors" };
  const job = { ...shot("next"), continuationSceneId: source.id }; config.generationJobs = [source, job];
  const request = sceneGenerationRequest(job, config, "D:/Project", 8);
  expect(request.continuationSourceNoise).toBe(0.7);
  const changed = { ...job, continuationStrength: 0.65 };
  const changedRequest = sceneGenerationRequest(changed, config, "D:/Project", 8);
  expect(changedRequest.continuationSourceNoise).toBe(0.35);
  expect(sceneGenerationSnapshot(changed, changedRequest)).not.toBe(sceneGenerationSnapshot(job, request));
  expect(sceneInput(changed).continuationStrength).toBe(0.65);
  config.generationJobs[1] = changed;
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).generationJobs[1].continuationStrength).toBe(0.65);
  expect(duplicateScene(config, changed.id)?.config.generationJobs.at(-1)?.continuationStrength).toBe(0.65);
  expect(sceneGenerationRequest({ ...job, continuationStrength: 0 }, config, "D:/Project", 8).continuationSourceNoise).toBe(1);
  expect(sceneGenerationRequest({ ...job, continuationStrength: 0.99 }, config, "D:/Project", 8).continuationSourceNoise).toBe(0.01);
  expect(sceneGenerationRequest({ ...changed, continuationSceneId: null }, config, "D:/Project", 8).continuationSourceNoise).toBeUndefined();
  expect(sceneGenerationRequest({ ...changed, sceneType: "continue" }, config, "D:/Project", 8).continuationSourceNoise).toBeUndefined();
  config.generationJobs[1] = { ...job, continuationStrength: 1 };
  expect(() => parseProjectConfig(config)).toThrow();
});

it("compiles both prompts with consistent reference numbering and persists ending settings in drafts and copies", () => {
  const config = project();
  config.references = ["main", "ending", "unused"].map((id): ProjectReference => ({ id, name: id, kind: "image", description: "", intendedUse: [], relativePath: `references/${id}.png`, createdAt: config.createdAt }));
  const job = { ...shot("single"), endingPrompt: "@[ref:ending] waves goodbye.",
    shots: [{ id: "one", startSeconds: 0, action: "@[ref:main] enters the room." }], startFrameReferenceId: "unused", endFrameReferenceId: "unused" };
  config.generationJobs = [job];
  const restored = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  expect(restored.generationJobs[0].endingPrompt).toBe(job.endingPrompt);
  const request = sceneGenerationRequest(job, restored, "C:/Project", 8);
  expect(sceneGenerationReferences(job, config.references).map((reference) => reference.id)).toEqual(["main", "ending"]);
  expect(request.referencePaths).toEqual(["C:/Project/references/main.png", "C:/Project/references/ending.png"]);
  expect(request.prompt).toContain("<Subject 1> enters the room.");
  expect(request.singleShot?.endingPrompt).toContain("<Subject 2> waves goodbye.");
  expect(request.prompt).not.toContain("is the last frame");
  expect(request.frames).toBe(144);
  expect(sceneInput(job).endingPrompt).toBe(job.endingPrompt);
  expect(duplicateScene(config, job.id)?.config.generationJobs[1].endingPrompt).toBe(job.endingPrompt);
  expect(JSON.parse(sceneGenerationSnapshot(job, request)).singleShot).toEqual(request.singleShot);
  const changed = { ...job, endingPrompt: "@[ref:ending] sits down." };
  expect(sceneGenerationSnapshot(changed, sceneGenerationRequest(changed, restored, "C:/Project", 8))).not.toBe(sceneGenerationSnapshot(job, request));
});

it("falls back to the main prompt, collapses source shots, and rejects missing references and too-short scenes", () => {
  const config = project();
  const job = { ...shot("single"), endingPrompt: "  ", shots: [
    { id: "a", startSeconds: 0, action: "Walk forward." }, { id: "b", startSeconds: 2, action: "Wave goodbye." },
  ] };
  expect(sceneShots(job)).toHaveLength(1);
  expect(sceneShots(job)[0].action).toBe("Walk forward.\n\nWave goodbye.");
  const request = sceneGenerationRequest(job, config, "C:/Project", 8);
  expect(request.singleShot?.endingPrompt).toBe(request.prompt);
  expect(sendBlocker({ ...job, endingPrompt: "@[ref:missing] leaves." }, [])).toMatch(/ending prompt/);
  expect(sendBlocker({ ...job, durationSeconds: 1 }, [])).toMatch(/at least 2 seconds/);
});

it("uses the starting video's ending latents and rejects cycles, missing sources and incompatible upscale settings", () => {
  const config = project(), source = { ...shot("start"), latentRelativePath: "latents/start.safetensors", status: "completed" as const };
  const next = { ...shot("next"), continuationSceneId: source.id, continuationFrom: "start" as const, continuationOverlapFrames: 39, continuationLockOverlap: false };
  config.generationJobs = [next, source];
  expect(continuationBlocker(next, config.generationJobs)).toBeNull();
  expect(sceneGenerationRequest(next, config, "C:/Project", 8)).toMatchObject({ previousSceneId: "start", continuationRelativePath: source.latentRelativePath,
    continuationFrom: "end", continuationOverlapFrames: 22, continuationLockOverlap: true, singleShot: { endingPrompt: expect.any(String) } });
  expect(continuationBlocker(next, [next])).toMatch(/no longer exists/);
  expect(continuationBlocker(next, [next, { ...source, sceneType: "prompt" }])).toBeNull();
  expect(continuationBlocker(next, [next, { ...source, continuationSceneId: next.id }])).toMatch(/cycle/);
  expect(continuationBlocker({ ...source, continuationSceneId: source.id }, [source])).toMatch(/cycle/);
  expect(continuationBlocker(next, [next, { ...source, latentUpscale: true }])).toMatch(/Latent upscale/);
});
