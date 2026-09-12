import { expect, it } from "vitest";
import { compileMiniMaxH3Prompt, createDraftGenerationJob, isReferenceUsable, projectReferenceSchema, sceneGenerationSnapshot, usableReferenceImages, usableVideoReferences, type ProjectReference } from "./project";

const reference = (id: string, kind: ProjectReference["kind"], description = ""): ProjectReference => ({
  id, kind, name: id, description, intendedUse: [], createdAt: "2026-09-12T00:00:00.000Z",
  ...(kind !== "text" ? { sourcePath: `C:/references/${id}.${kind === "video" ? "mp4" : "png"}` } : {}),
});

it("keeps image and video numbering independent and stable in a mixed prompt", () => {
  const references = [reference("motion", "video"), reference("hero", "image"), reference("style", "text", "Ink drawing"), reference("camera", "video")];
  references[0].images = [{ id: "still", name: "Still", sourcePath: "C:/still.png" }];
  expect(isReferenceUsable(references[0])).toBe(true);
  expect(usableVideoReferences(references).map((item) => item.id)).toEqual(["motion", "camera"]);
  expect(usableReferenceImages(references).map((item) => item.sourcePath)).toEqual(["C:/still.png", "C:/references/hero.png"]);
  const prompt = compileMiniMaxH3Prompt("Follow the movement.", references);
  expect(prompt).toContain("<Subject 1> is the content shown in <Picture 1> and <Video 1>.");
  expect(prompt).toContain("<Subject 2> is the content shown in <Picture 2>.");
  expect(prompt).toContain("<Subject 4> is the content shown in <Video 2>.");
});

it("round trips clip options and rejects invalid persisted ranges", () => {
  const video = { ...reference("motion", "video"), video: { startSeconds: 3, durationSeconds: 5, includeAudio: false } };
  expect(projectReferenceSchema.parse(JSON.parse(JSON.stringify(video))).video).toEqual(video.video);
  expect(projectReferenceSchema.safeParse({ ...video, video: { ...video.video, durationSeconds: 16 } }).success).toBe(false);
  expect(projectReferenceSchema.safeParse({ ...video, video: { ...video.video, startSeconds: -1 } }).success).toBe(false);
});

it("records video paths and trims in generation snapshots without temporary handles", () => {
  const request = { prompt: "Motion", frames: 120, steps: 12, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [],
    referenceVideos: [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 3, durationSeconds: 5, includeAudio: false }], referenceVideoIds: ["temporary"] };
  const job = createDraftGenerationJob("Motion");
  const snapshot = JSON.parse(sceneGenerationSnapshot(job, request));
  expect(snapshot.referenceVideos).toEqual(request.referenceVideos);
  expect(snapshot.referenceVideoIds).toBeUndefined();
  expect(sceneGenerationSnapshot(job, { ...request, referenceVideos: [{ ...request.referenceVideos[0], startSeconds: 4 }] })).not.toBe(JSON.stringify(snapshot));
});
