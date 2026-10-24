import { expect, it } from "vitest";
import fixture from "../../fixtures/generation-effects.json";
import { activeGenerationEffects, generationEffectsSchema } from "./generationEffects";
import { createProjectConfig, parseProjectConfig, sceneGenerationSnapshot } from "./project";
import { sceneGenerationRequest } from "./sceneGeneration";
import { createImageScene, imageSceneSchema } from "./imageScene";

it("preserves effects across project and image serialization and fingerprints active video effects", () => {
  const effects = generationEffectsSchema.parse(fixture);
  const config = createProjectConfig({ name: "Effects", prompt: "A red apple", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 5 });
  config.generationJobs[0].generationEffects = effects;
  config.imageScene = { ...createImageScene("Apple"), generationEffects: effects };
  const restored = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  expect(restored.generationJobs[0].generationEffects).toEqual(effects);
  expect(imageSceneSchema.parse(restored.imageScene).generationEffects).toEqual(effects);
  const job = restored.generationJobs[0];
  const request = sceneGenerationRequest(job, restored, "D:/project", 20);
  expect(request.generationEffects).toEqual(activeGenerationEffects(effects));
  expect(request.generationEffects?.sharpness).toBeUndefined();
  const snapshot = sceneGenerationSnapshot(job, request);
  expect(JSON.parse(snapshot).generationEffects).toEqual(request.generationEffects);
  expect(sceneGenerationSnapshot(job, { ...request, generationEffects: { tone: { contrast: 1, brightness: 0, saturation: 1, temperature: 0 } } }))
    .toBe(sceneGenerationSnapshot(job, { ...request, generationEffects: undefined }));
  expect(snapshot).not.toBe(sceneGenerationSnapshot(job, { ...request, generationEffects: undefined }));
});

it.each([
  { color: { color: "red", strength: 1, mode: "type_i" } },
  { sharpness: { strength: Infinity } }, { sharpness: { strength: 6 } },
  { anchor: { strength: 1, mode: "reference" } }, { startStep: 10, endStep: 9 },
  { region: { x: 60, y: 0, width: 50, height: 100, invert: false } },
])("rejects invalid native controls %j", (value) => {
  expect(generationEffectsSchema.safeParse(value).success).toBe(false);
});
