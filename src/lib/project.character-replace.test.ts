import { expect, it } from "vitest";
import { characterReplaceBlocker, compileGenerationJobPrompt, createDraftGenerationJob, generationJobSchema,
  sceneFrameInputs, sceneGenerationReferences, sceneGenerationSnapshot, createProjectConfig, usableReferenceImages,
  type ProjectReference } from "./project";

const reference = (id: string, kind: "image" | "video"): ProjectReference => ({
  id, kind, name: id, description: "", intendedUse: [], createdAt: "2026-09-21T00:00:00.000Z",
  sourcePath: `C:/references/${id}.${kind === "video" ? "mp4" : "png"}`,
  ...(kind === "video" ? { video: { startSeconds: 1, durationSeconds: 3, includeAudio: false } } : {}),
});
const job = () => createDraftGenerationJob("", { sceneType: "character-replace", shots: [
  { id: "shot-a", startSeconds: 0, action: "Old scene text", videoReferenceId: "motion", characterReferenceId: "hero", characterTarget: "the person in the red jacket" },
] });

it("round trips scene types and each shot's replacement choices without changing legacy jobs", () => {
  const scene = job();
  expect(generationJobSchema.parse(JSON.parse(JSON.stringify(scene)))).toEqual(scene);
  expect(createDraftGenerationJob("Legacy")).not.toHaveProperty("sceneType");
  expect(generationJobSchema.safeParse({ ...job(), sceneType: "unknown" }).success).toBe(false);
});

it("compiles an edit from the selected references and excludes stale anchors, prose and look", () => {
  const scene = { ...job(), referenceIds: ["unrelated"], startFrameReferenceId: "unrelated", usePreviousSceneLastFrame: true };
  const references = [reference("unrelated", "image"), reference("motion", "video"), reference("hero", "image")];
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 6 });
  config.generationJobs = [scene];
  config.references = references;
  const inputs = sceneFrameInputs(scene, config);
  expect(inputs).not.toHaveProperty("previousSceneId");
  expect(inputs.references.map(({ id }) => id)).toEqual(["motion", "hero"]);
  const prompt = compileGenerationJobPrompt(scene, inputs.references, "watercolor");
  expect(prompt).toContain("[video editing + reference generation]");
  expect(prompt).toContain("replace the person in the red jacket with <Subject 1>");
  expect(prompt).toContain("<Subject 1> is the replacement character shown in <Picture 1>");
  expect(prompt).toContain("<Video 1> ([Shot 1]): partially_preserved");
  expect(prompt).toContain("motion, pose, expression, gaze and timing");
  expect(prompt).not.toMatch(/Old scene text|Watercolor|first frame|<Audio/);
  expect(prompt.match(/^\w+:/gm)).toEqual(["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]);
});

it("keeps numbering aligned across reordered references, multi-image characters and multiple shots", () => {
  const scene = job();
  scene.shots!.push({ id: "shot-b", startSeconds: 3, action: "", videoReferenceId: "motion2", characterReferenceId: "hero2" });
  const hero = reference("hero", "image");
  hero.images = [{ id: "profile", name: "Profile", sourcePath: "C:/profile.png" }];
  const references = [reference("hero2", "image"), reference("motion2", "video"), hero, reference("motion", "video")];
  references[1].images = [{ id: "video-still", name: "Video still", sourcePath: "C:/still.png" }];
  const bound = sceneGenerationReferences(scene, references);
  const pictures = usableReferenceImages(bound);
  const prompt = compileGenerationJobPrompt(scene, bound);
  const heroPicture = pictures.findIndex((image) => image.sourcePath === "C:/references/hero.png") + 1;
  expect(prompt).toContain(`<Subject 2> is the replacement character shown in <Picture ${heroPicture}>, <Picture ${heroPicture + 1}>`);
  expect(prompt).toContain("[Shot 1] In <Video 2>, replace the person in the red jacket with <Subject 2>");
  expect(prompt).toContain("[Shot 2] At 00:03.000, In <Video 1>, replace the main character with <Subject 1>");
});

it("includes only enabled soundtracks with independent audio numbering", () => {
  const scene = job();
  scene.shots!.push({ id: "shot-b", startSeconds: 3, action: "", videoReferenceId: "motion2", characterReferenceId: "hero" });
  const motion2 = reference("motion2", "video");
  motion2.video!.includeAudio = true;
  const prompt = compileGenerationJobPrompt(scene, [reference("motion", "video"), motion2, reference("hero", "image")]);
  expect(prompt).toContain("<Audio 1> is the enabled soundtrack of <Video 2>");
  expect(prompt).toContain("[video editing + reference generation + audio reuse]");
  expect(prompt).not.toContain("<Audio 2>");
});

it("blocks missing, unusable and wrongly typed references but accepts blank action text", () => {
  const scene = job();
  const references = [reference("motion", "video"), reference("hero", "image")];
  expect(characterReplaceBlocker(scene, references)).toBeNull();
  expect(characterReplaceBlocker(scene, references.slice(1))).toContain("video reference for shot 1");
  expect(characterReplaceBlocker(scene, [references[0], { ...references[1], intendedUse: ["audio"] }])).toContain("character reference");
  expect(characterReplaceBlocker(scene, [references[0], reference("hero", "video")])).toContain("character reference");
  scene.shots!.push({ id: "blank", startSeconds: 3, action: "" });
  expect(characterReplaceBlocker(scene, references)).toContain("shot 2");
});

it("changes the generation snapshot when the replacement or target changes", () => {
  const scene = job();
  const references = [reference("motion", "video"), reference("hero", "image"), reference("hero2", "image")];
  const snapshot = () => sceneGenerationSnapshot(scene, { prompt: compileGenerationJobPrompt(scene, references), frames: 144,
    steps: 20, seed: 1, canvasWidth: 736, canvasHeight: 416, referencePaths: [] });
  const original = snapshot();
  scene.shots![0].characterTarget = "the person on the left";
  expect(snapshot()).not.toBe(original);
  scene.shots![0].characterReferenceId = "hero2";
  expect(sceneGenerationReferences(scene, references).map(({ id }) => id)).toEqual(["motion", "hero2"]);
});

it("blocks payloads beyond the model's video and image limits", () => {
  const scene = job();
  const motion = reference("motion", "video");
  const hero = reference("hero", "image");
  const references = [motion, hero];
  for (let index = 2; index <= 4; index++) {
    references.push(reference(`motion${index}`, "video"));
    scene.shots!.push({ id: `shot-${index}`, startSeconds: index, action: "", videoReferenceId: `motion${index}`, characterReferenceId: "hero" });
  }
  expect(characterReplaceBlocker(scene, references)).toContain("three video");
  scene.shots!.pop();
  motion.video!.durationSeconds = 10;
  expect(characterReplaceBlocker(scene, references)).toContain("15 seconds");
  motion.video!.durationSeconds = 3;
  hero.images = Array.from({ length: 9 }, (_, index) => ({ id: `image-${index}`, name: "Angle", sourcePath: `C:/angle-${index}.png` }));
  expect(characterReplaceBlocker(scene, references)).toContain("nine reference images");
});
