import { expect, it } from "vitest";
import fixture from "../../fixtures/generation-effects.json";
import { activeGenerationEffects, generationEffectsSchema } from "./generationEffects";
import { createProjectConfig, parseProjectConfig, sceneGenerationSnapshot } from "./project";
import { sceneGenerationRequest } from "./sceneGeneration";
import { createImageScene, imageSceneSchema } from "./imageScene";
import { importLcsCalibration } from "./lcsCalibration";

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
  { drift: { strength: 0, max: 1, highlightStrength: 1.1, highlightKnee: 0.8 } },
  { drift: { strength: 0.5, max: 1, highlightStrength: 0, highlightKnee: 0.8 } },
  { drift: { ...fixture.drift, strength: -1 } }, { drift: { ...fixture.drift, max: 11 } },
  { drift: { ...fixture.drift, highlightKnee: 3 } },
  { region: { x: 60, y: 0, width: 50, height: 100, invert: false } },
])("rejects invalid native controls %j", (value) => {
  expect(generationEffectsSchema.safeParse(value).success).toBe(false);
});

it("keeps highlight compression independent and ignores bypassed or zero drift controls", () => {
  const drift = generationEffectsSchema.parse(fixture).drift!;
  expect(activeGenerationEffects({ drift: { ...drift, enabled: false } })).toBeUndefined();
  expect(activeGenerationEffects({ drift: { ...drift, strength: 0, highlightStrength: 0 } })).toBeUndefined();
  expect(activeGenerationEffects({ drift: { ...drift, max: 0, highlightStrength: 0 } })).toBeUndefined();
  expect(activeGenerationEffects({ drift: { ...drift, strength: 0 } })?.drift?.calibration).toBeUndefined();
  expect(activeGenerationEffects({ drift })?.drift?.calibration).toEqual(fixture.drift.calibration);
});

it("imports fitted calibration bytes and rejects missing, truncated or invalid directions", () => {
  const bytes = Uint8Array.from(atob(fixture.drift.calibration.data), (c) => c.charCodeAt(0));
  expect(importLcsCalibration("test-drift.safetensors", bytes)).toEqual(fixture.drift.calibration);
  expect(() => importLcsCalibration("broken", bytes.subarray(0, 100))).toThrow();
  const view = new DataView(bytes.buffer);
  const length = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  view.setFloat32(8 + length + header.drift_direction.data_offsets[0] + 3 * 4, 0, true);
  expect(() => importLcsCalibration("zero-direction", bytes)).toThrow(/direction/);
  expect(generationEffectsSchema.safeParse({ drift: { ...fixture.drift, calibration: { name: "bad", data: "aGVsbG8=" } } }).success).toBe(false);
});
