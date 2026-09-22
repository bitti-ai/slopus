import { expect, it } from "vitest";
import { compileGenerationJobPrompt, createDraftGenerationJob, createProjectConfig, generationJobSchema,
  poseBlocker, referenceToken, sceneFrameInputs, sceneGenerationReferences, type ProjectReference } from "./project";

const reference = (id: string, kind: "image" | "video"): ProjectReference => ({
  id, kind, name: id, description: "", intendedUse: [], createdAt: "2026-09-22T00:00:00.000Z",
  sourcePath: `C:/${id}.${kind === "video" ? "mp4" : "png"}`,
  ...(kind === "video" ? { video: { startSeconds: 1, durationSeconds: 3, includeAudio: true } } : {}),
});
const scene = () => ({ ...createDraftGenerationJob("A dancer on a rainy street.", { sceneType: "pose" }), poseVideoReferenceId: "motion" });

it("saves Pose and its video choice while keeping older scenes unchanged", () => {
  const job = scene();
  expect(generationJobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
  expect(createDraftGenerationJob("Legacy")).not.toHaveProperty("poseVideoReferenceId");
  expect(generationJobSchema.safeParse({ ...scene(), poseVideoReferenceId: "" }).success).toBe(false);
});

it("uses the pose video without requiring optional references or copying its appearance", () => {
  const job = scene();
  const refs = [reference("motion", "video")];
  expect(poseBlocker(job, refs)).toBeNull();
  const prompt = compileGenerationJobPrompt(job, refs);
  expect(prompt).toContain("pose and motion guidance from <Video 1>");
  expect(prompt).toContain("A dancer on a rainy street.");
  expect(prompt).toContain("partially_preserved - retain body pose, movement and timing only");
  expect(prompt).not.toContain("fully_preserved");
  expect(prompt).not.toContain("The shot features <Subject 1>");
});

it("sends only the pose and cited references with matching payload numbering", () => {
  const job = { ...scene(), referenceIds: ["stale"], startFrameReferenceId: "stale", usePreviousSceneLastFrame: true };
  job.shots![0].action = `${referenceToken("hero")} dances in ${referenceToken("setting")}.`;
  const motion = reference("motion", "video");
  motion.images = [{ id: "still", name: "Still", sourcePath: "C:/still.png" }];
  const refs = [reference("setting", "video"), reference("stale", "image"), reference("hero", "image"), motion];
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 6 });
  config.references = refs;
  config.generationJobs = [job];
  const inputs = sceneFrameInputs(job, config);
  expect(inputs).not.toHaveProperty("previousSceneId");
  expect(inputs.references.map(({ id }) => id)).toEqual(["setting", "hero", "motion"]);
  expect(inputs.references[2]).toMatchObject({ images: [], refmods: [], video: { startSeconds: 1, durationSeconds: 3, includeAudio: false } });
  expect(motion.video!.includeAudio).toBe(true);
  const prompt = compileGenerationJobPrompt(job, inputs.references);
  expect(prompt).toContain("<Subject 2> is the content shown in <Picture 1>");
  expect(prompt).toContain("<Subject 3> is pose and motion guidance from <Video 2>");
  expect(prompt).toContain("<Subject 2> dances in <Subject 1>");
  expect(prompt).not.toMatch(/first frame|last frame|<Picture 2>/);
  job.shots![0].action = "A dancer.";
  expect(sceneGenerationReferences(job, refs).map(({ id }) => id)).toEqual(["motion"]);
});

it("requires an available video and prompt and enforces payload limits", () => {
  const job = scene();
  expect(poseBlocker(job, [])).toContain("pose video");
  expect(poseBlocker(job, [reference("motion", "image")])).toContain("pose video");
  expect(poseBlocker(job, [{ ...reference("motion", "video"), sourcePath: undefined }])).toContain("pose video");
  const motion = reference("motion", "video");
  job.shots![0].action = "";
  expect(poseBlocker(job, [motion])).toContain("Describe where");
  job.shots![0].action = "A dancer.";
  motion.video!.durationSeconds = 16;
  expect(poseBlocker(job, [motion])).toContain("15 seconds");
  motion.video!.durationSeconds = 3;
  const extra = ["a", "b", "c"].map((id) => reference(id, "video"));
  job.shots![0].action = extra.map(({ id }) => referenceToken(id)).join(" ");
  expect(poseBlocker(job, [motion, ...extra])).toContain("three video");
  const hero = reference("hero", "image");
  hero.images = Array.from({ length: 9 }, (_, i) => ({ id: `image-${i}`, name: "Angle", sourcePath: `C:/angle-${i}.png` }));
  job.shots![0].action = referenceToken("hero");
  expect(poseBlocker(job, [motion, hero])).toContain("nine reference images");
});
