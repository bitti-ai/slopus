import { expect, it } from "vitest";
import { compileMiniMaxH3Prompt, createDraftGenerationJob, isReferenceUsable, projectReferenceSchema, sceneGenerationReferences, sceneGenerationSnapshot, usableReferenceImages, usableVideoReferences, type ProjectReference } from "./project";

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

it("routes selected video frames as pictures and restores clip routing when switching modes", () => {
  const video = projectReferenceSchema.parse({ ...reference("motion", "video"), video: {
    mode: "frames", startSeconds: 3, durationSeconds: 5, includeAudio: true,
    frames: [{ id: "frame", name: "Still", timeSeconds: 42, relativePath: "references/frames/still.png" }],
  } });
  expect(projectReferenceSchema.parse(JSON.parse(JSON.stringify(video)))).toEqual(video);
  expect(usableVideoReferences([video])).toEqual([]);
  expect(usableReferenceImages([video]).map((image) => image.relativePath)).toEqual(["references/frames/still.png"]);
  expect(compileMiniMaxH3Prompt("A still", [video])).toContain("<Picture 1>");
  expect(compileMiniMaxH3Prompt("A still", [video])).not.toContain("<Video 1>");
  const job = { ...createDraftGenerationJob("Still"), startFrameReferenceId: video.id };
  const anchors = sceneGenerationReferences(job, [video]);
  expect(usableReferenceImages(anchors)).toHaveLength(1);
  expect(projectReferenceSchema.safeParse(anchors[0]).success).toBe(true);
  const clip = { ...video, video: { ...video.video!, mode: "video" as const } };
  expect(usableVideoReferences([clip])).toHaveLength(1);
  expect(usableReferenceImages([clip])).toEqual([]);
  expect(isReferenceUsable({ ...video, video: { ...video.video!, frames: [] } })).toBe(false);
  expect(projectReferenceSchema.safeParse({ ...video, video: { ...video.video, frames: [{ ...video.video!.frames![0], timeSeconds: -1 }] } }).success).toBe(false);
});
