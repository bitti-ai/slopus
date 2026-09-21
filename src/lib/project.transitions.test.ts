import { expect, it } from "vitest";
import { compileGenerationJobPrompt, createDraftGenerationJob, generationJobSchema, sceneGenerationReferences,
  sceneGenerationSnapshot, videoTransitionBlocker, usableReferenceImages, type ProjectReference } from "./project";

const video = (id: string): ProjectReference => ({ id, kind: "video", name: id, description: "", intendedUse: [],
  sourcePath: `C:/clips/${id}.mp4`, video: { startSeconds: 2, durationSeconds: 3, includeAudio: true }, createdAt: "2026-09-21T00:00:00.000Z" });
const references = [video("end"), video("start")];
const scene = (sceneType: "extend" | "bridge") => ({ ...createDraftGenerationJob("The dancer turns and walks toward the door.", { sceneType }),
  startVideoReferenceId: "start", endVideoReferenceId: "end", startFrameReferenceId: "stale", usePreviousSceneLastFrame: true });

it.each(["extend", "bridge"] as const)("round trips %s and compiles text with explicit temporal roles", (type) => {
  const job = scene(type);
  expect(generationJobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
  const bound = sceneGenerationReferences(job, references);
  expect(bound.map(({ id }) => id)).toEqual(type === "extend" ? ["start"] : ["start", "end"]);
  const prompt = compileGenerationJobPrompt(job, references);
  expect(prompt).toContain("The dancer turns and walks toward the door.");
  expect(prompt).toContain("immediately after the final frame of <Video 1>");
  expect(prompt.includes("before the opening frame of <Video 2>")).toBe(type === "bridge");
  expect(prompt).not.toContain("first frame of the video");
  expect(videoTransitionBlocker(job, references)).toBeNull();
});

it("keeps preview and submission numbering identical when library order differs", () => {
  const job = scene("bridge");
  expect(compileGenerationJobPrompt(job, references)).toBe(compileGenerationJobPrompt(job, sceneGenerationReferences(job, references)));
  const withStills = references.map((reference) => ({ ...reference, images: [{ id: "still", name: "Still", sourcePath: "C:/still.png" }],
    refmods: [{ id: "refmod", name: "Old", sourcePath: "C:/old.safetensors", strength: 1, copies: 1 }] }));
  expect(usableReferenceImages(sceneGenerationReferences(job, withStills))).toEqual([]);
});

it("blocks absent endpoints, identical references, short sources and unbound citations", () => {
  expect(videoTransitionBlocker({ ...scene("extend"), startVideoReferenceId: null }, references)).toContain("start video");
  expect(videoTransitionBlocker({ ...scene("bridge"), endVideoReferenceId: null }, references)).toContain("end video");
  expect(videoTransitionBlocker({ ...scene("bridge"), endVideoReferenceId: "start" }, references)).toContain("different");
  expect(videoTransitionBlocker(scene("extend"), [{ ...video("start"), video: { startSeconds: 0, durationSeconds: .5, includeAudio: false } }])).toContain("22 frames");
  const job = scene("extend");
  job.shots![0].action = "Follow @[ref:end]";
  expect(videoTransitionBlocker(job, references)).toContain("cite only");
});

it("captures the native transition mode in generation snapshots", () => {
  const job = scene("extend");
  const input = { prompt: "Continue", frames: 144, steps: 20, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [] };
  const extend = sceneGenerationSnapshot(job, { ...input, videoTransition: "extend" });
  expect(JSON.parse(extend).videoTransition).toBe("extend");
  expect(extend).not.toBe(sceneGenerationSnapshot(job, { ...input, videoTransition: "bridge" }));
});
