import { expect, it } from "vitest";
import { compileGenerationJobPrompt, createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneGenerationReferences, sceneTypeFor, type ProjectReference } from "./project";
import { sceneGenerationRequest } from "./sceneGeneration";

it.each([
  [undefined, undefined, null],
  ["start", undefined, "For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced."],
  [undefined, "end", "How the reference pictures align with the target video — <Picture 1> (from [Shot 2]) aligns with the 6.58-second mark of the target video."],
  ["start", "end", "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the 6.58-second mark of the target video."],
] as const)("uses the base prompt mapping for start=%s, end=%s", (startFrameReferenceId, endFrameReferenceId, instruction) => {
  const config = createProjectConfig({ name: "Anchors", prompt: "A cyclist opens an umbrella.", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 6 });
  // Library order must not change the picture numbers in the prompt or payload.
  config.references = ["end", "unused", "start"].map((id) => ({ id, name: id, kind: "image", description: "", intendedUse: [], relativePath: `references/${id}.png`, createdAt: config.createdAt }));
  const job = { ...config.generationJobs[0], sceneType: "first-last-frame" as const, durationSeconds: 6,
    startFrameReferenceId, endFrameReferenceId,
    shots: [{ id: "one", startSeconds: 0, action: "A cyclist opens an umbrella." }, { id: "two", startSeconds: 3, action: "Water rolls off the fabric." }] };
  config.generationJobs = [job];
  const request = sceneGenerationRequest(job, config, "C:/Project", 20);
  const preview = compileGenerationJobPrompt(job, config.references);
  expect(request.prompt).toBe(preview);
  expect(request.referencePaths).toEqual([startFrameReferenceId, endFrameReferenceId].filter(Boolean).map((id) => `C:/Project/references/${id}.png`));
  expect(preview).toMatch(/integrated_multimodal_description: \[Shot 1\]/);
  expect(preview).toContain("[Shot 2] At 00:03.000");
  expect(preview).not.toContain("[Shot 3]");
  expect(preview).toContain("A cyclist opens an umbrella.");
  expect(preview).toContain("Water rolls off the fabric.");
  expect(preview).toContain("\n\noverall_soundscape: ");
  expect(preview).toContain("\n\nnon_diegetic_music: ");
  expect(preview).not.toContain("subject_definitions:");
  if (instruction) {
    expect(preview.startsWith(`${instruction}\n\nintegrated_multimodal_description:`)).toBe(true);
    expect(preview).toContain("Use the visual style established by <Picture 1>.");
  } else {
    expect(preview.startsWith("integrated_multimodal_description:")).toBe(true);
    expect(preview).not.toContain("<Picture");
  }
  if (endFrameReferenceId) {
    expect(preview).toContain("6.58 seconds, the end of [Shot 2].");
    expect(preview.indexOf("Gradually converge")).toBeGreaterThan(preview.indexOf("[Shot 2] At"));
    if (!startFrameReferenceId) expect(preview).toContain("this picture is the ending, not the opening");
  }
});

it("uses the aligned duration and keeps anchor citations when both anchors share an image", () => {
  const reference: ProjectReference = { id: "image", name: "Image", kind: "image", description: "", intendedUse: [], relativePath: "references/image.png", createdAt: "2026-10-28T00:00:00Z" };
  const job = { ...createDraftGenerationJob("@[ref:image]comes to life."), sceneType: "first-last-frame" as const, durationSeconds: 8, startFrameReferenceId: "image", endFrameReferenceId: "image" };
  const prompt = compileGenerationJobPrompt(job, [reference]);
  expect(sceneGenerationReferences(job, [reference])).toHaveLength(1);
  expect(prompt.split("\n")[0]).toBe("How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 1 (from Shot 1) aligns with the 8.00-second mark of the target video.");
  expect(prompt).toContain("<Picture 1> comes to life.");
  expect(prompt).not.toContain("Picture 2");
});

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
