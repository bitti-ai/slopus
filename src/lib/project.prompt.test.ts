import { expect, it } from "vitest";
import { compileGenerationJobPrompt, createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneGenerationReferences, sceneTypeFor, type ProjectReference } from "./project";
import { sceneGenerationRequest } from "./sceneGeneration";

it("defaults ordinary scenes to Prompt while preserving legacy frame-based scenes", () => {
  const job = createDraftGenerationJob("A dancer spins.");
  expect(sceneTypeFor(job)).toBe("prompt");
  expect(sceneTypeFor({ ...job, startFrameReferenceId: "start" })).toBe("first-last-frame");
  expect(sceneTypeFor({ ...job, endFrameReferenceId: "end" })).toBe("first-last-frame");
  expect(sceneTypeFor({ ...job, sceneType: "first-last-frame" })).toBe("first-last-frame");
});

it("saves Prompt scenes and uses cited references without stale frame or continuation conditioning", () => {
  const config = createProjectConfig({ name: "Prompt", prompt: "A dancer spins.", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 10 });
  const references: ProjectReference[] = ["start", "end", "subject"].map((id) => ({ id, name: id, kind: "image", description: "", intendedUse: [], relativePath: `references/${id}.png`, createdAt: config.createdAt }));
  const job = { ...config.generationJobs[0], sceneType: "prompt" as const, startFrameReferenceId: "start", endFrameReferenceId: "end",
    usePreviousSceneLastFrame: true, continuationSceneId: "old", referenceIds: ["start", "end"],
    shots: [{ id: "shot", startSeconds: 0, action: "@[ref:subject] dances." }] };
  config.references = references;
  config.generationJobs = [job];
  const restored = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  expect(restored.generationJobs[0].sceneType).toBe("prompt");
  expect(sceneGenerationReferences(job, references).map((reference) => reference.id)).toEqual(["subject"]);
  const request = sceneGenerationRequest(job, restored, "C:/Project", 20);
  expect(request.referencePaths).toEqual(["C:/Project/references/subject.png"]);
  expect(request.continuationRelativePath).toBeUndefined();
  expect(request.previousSceneId).toBeUndefined();
  expect(request.prompt).toContain("<Subject 1> dances.");
  expect(request.prompt).not.toContain("first frame");
  expect(request.prompt).not.toContain("last frame");
  // A frame reference can still be explicitly cited as appearance guidance.
  const citedAnchor = { ...job, shots: [{ ...job.shots[0], action: "@[ref:start] dances." }] };
  expect(compileGenerationJobPrompt(citedAnchor, references)).toContain("<Subject 1>");
  expect(compileGenerationJobPrompt(citedAnchor, references)).not.toContain("is the first frame");
  const frames = compileGenerationJobPrompt({ ...job, sceneType: "first-last-frame" }, references);
  expect(frames).toContain("is the first frame");
  expect(frames).toContain("is the last frame");
});
