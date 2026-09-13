import { expect, it } from "vitest";
import { activeReferenceRefmods, compileMiniMaxH3Prompt, createProjectConfig, isReferenceUsable, parseProjectConfig, projectReferenceSchema, referenceRefmodInputs, sceneGenerationSnapshot, usableReferenceImages } from "./project";

const reference = () => projectReferenceSchema.parse({
  id: "subject", name: "Uncategorized", description: "", kind: "text", intendedUse: [], createdAt: "2026-09-13T00:00:00.000Z",
  refmods: [{ id: "latent", name: "person.safetensors", sourcePath: "D:/person.safetensors" }],
});

it("round-trips refmod attachments with defaults without inventing image inputs", () => {
  const config = createProjectConfig({ name: "Refmod", prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  config.references = [reference()];
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
  expect(reference().refmods![0]).toMatchObject({ strength: 1, copies: 1 });
  expect(isReferenceUsable(reference())).toBe(true);
  expect(usableReferenceImages(config.references)).toEqual([]);
  expect(referenceRefmodInputs("C:/project", config.references)).toEqual([{ path: "D:/person.safetensors", strength: 1, copies: 1 }]);
  const prompt = compileMiniMaxH3Prompt("A walking person", config.references);
  expect(prompt).not.toContain("<Picture");
  expect(prompt).not.toContain("person.safetensors");
  expect(prompt).toContain("pre-encoded reference");
});

it("omits disabled refmods and includes their settings in generation snapshots", () => {
  const ref = reference();
  ref.refmods![0].strength = 0;
  expect(activeReferenceRefmods(ref)).toEqual([]);
  expect(isReferenceUsable(ref)).toBe(false);
  const config = createProjectConfig({ name: "Refmod", prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const request = { prompt: "A scene", frames: 120, steps: 20, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [], refmods: [{ path: "D:/ref.safetensors", strength: 0.7, copies: 2 }] };
  const before = sceneGenerationSnapshot(config.generationJobs[0], request);
  expect(sceneGenerationSnapshot(config.generationJobs[0], { ...request, refmods: [{ ...request.refmods[0], copies: 3 }] })).not.toBe(before);
});

it.each([{ strength: -1 }, { strength: 1.1 }, { strength: Infinity }, { copies: 0 }, { copies: 11 }, { copies: 1.5 }, { sourcePath: "../escape.safetensors" }, { sourcePath: null }])("rejects invalid refmod settings %j", (patch) => {
  const ref = reference();
  expect(() => projectReferenceSchema.parse({ ...ref, refmods: [{ ...ref.refmods![0], ...patch }] })).toThrow();
});
