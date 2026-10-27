import { expect, it } from "vitest";
import { createDraftGenerationJob, createProjectConfig, generationAssetId, parseProjectConfig, sceneDurationSeconds, type ProjectAsset } from "./project";
import { mergeVideoScenes, newVideo, resolveVideoSource, songScenes, videoGuidedScene, videoLibrary, videoSceneOffset } from "./videoLibrary";
import { sceneGenerationRequest, sendBlocker } from "./sceneGeneration";
import { videoPlaylist } from "../components/workspace/VideoPlayback";
import { longShotBlocker, longShotInputs } from "./longShot";

const project = () => createProjectConfig({ name: "Videos", prompt: "", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 30 });
const scene = (id: string, seconds = 10) => createDraftGenerationJob("A dancer moves", { id, sceneType: "prompt", durationSeconds: seconds });
const asset = (id: string, kind: ProjectAsset["kind"] = "audio", durationMs = 30000): ProjectAsset => ({ id, kind, name: id, relativePath: `media/${id}.${kind === "audio" ? "wav" : "mp4"}`, mimeType: kind === "audio" ? "audio/wav" : "video/mp4", durationMs, createdAt: "2026-10-27T00:00:00.000Z" });

it("keeps Long Shot neighbors within their Video but permits explicit continuation across Videos", () => {
  const config = project(); config.generationJobs = ["a", "other", "b", "c"].map((id) => ({ ...scene(id), sceneType: "long-shot" as const, latentRelativePath: `latents/${id}.safetensors` }));
  config.videos = [{ ...newVideo(null), sceneIds: ["a", "b", "c"] }, { ...newVideo(null), sceneIds: ["other"] }];
  expect(longShotBlocker(config.generationJobs[1], config)).toBeNull();
  expect(longShotInputs(config.generationJobs[2], config)?.bridge).toMatchObject({ leftSceneId: "a", rightSceneId: "c" });
  const continued = { ...config.generationJobs[2], sceneType: "single-shot" as const, continuationSceneId: "other" };
  expect(sceneGenerationRequest(continued, config, "D:/Project", 8).continuationRelativePath).toBe("latents/other.safetensors");
});

it("groups legacy and external scenes without changing scene or timeline identity", () => {
  const config = project(); config.generationJobs = [scene("a"), scene("b")];
  const original = structuredClone(config);
  expect(videoLibrary(config)[0].sceneIds).toEqual(["a", "b"]);
  expect(config).toEqual(original);
  config.videos = videoLibrary(config); config.videoFolders = [{ id: "folder", name: "Campaign" }]; config.videos[0].folderId = "folder";
  config.generationJobs.push(scene("external"));
  expect(videoLibrary(config)[0].sceneIds).toEqual(["a", "b", "external"]);
  const restored = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  expect(restored.videos).toEqual(config.videos); expect(restored.videoFolders).toEqual(config.videoFolders);
  expect(restored.timeline).toEqual(config.timeline);
});

it("edits, adds, reorders and removes scenes within one video while retaining other videos", () => {
  const config = project(); config.generationJobs = [scene("a"), scene("other"), scene("b")];
  const first = { ...newVideo(null), sceneIds: ["a", "b"] }, second = { ...newVideo(null), sceneIds: ["other"] };
  config.videos = [first, second];
  const edited = { ...config, generationJobs: [scene("b"), scene("other"), scene("new")] };
  const merged = mergeVideoScenes(config, first.id, edited);
  expect(merged.videos?.map((video) => video.sceneIds)).toEqual([["b", "new"], ["other"]]);
  expect(merged.generationJobs.map((job) => job.id)).toEqual(["b", "other", "new"]);
  expect(merged.assets).toBe(config.assets); expect(merged.timeline).toBe(config.timeline);
});

it("slices music and video at cumulative scene times in video order and compiles consistent reference numbers", () => {
  const config = project(); config.generationJobs = [scene("second", 8), scene("unrelated", 15), scene("first")];
  const video = { ...newVideo(null), sceneIds: ["first", "second"], prompt: "Neon lights", musicSource: { kind: "asset" as const, id: "song" }, videoSource: { kind: "asset" as const, id: "guide" } };
  config.videos = [video]; config.assets = [asset("song"), asset("guide", "video")];
  const before = structuredClone(config), job = config.generationJobs[0];
  expect(videoSceneOffset(video, job, config)).toBe(10);
  expect(sendBlocker(job, config.references, config)).toBeNull();
  const request = sceneGenerationRequest(job, config, "D:/Project", 8);
  expect(request.referenceAudios?.[0]).toMatchObject({ startSeconds: 10, durationSeconds: 8, relativePath: "media/song.wav" });
  expect(request.referenceVideos?.[0]).toMatchObject({ startSeconds: 10, durationSeconds: 8, includeAudio: false });
  expect(request.prompt).toContain("Neon lights"); expect(request.prompt).toContain("<Audio 1>"); expect(request.prompt).toContain("<Video 1>");
  expect(request.prompt).not.toContain("@[ref:"); expect(config).toEqual(before);
  config.videos[0].sceneIds.reverse();
  expect(sceneGenerationRequest(job, config, "D:/Project", 8).referenceAudios?.[0].startSeconds).toBe(0);
});

it("binds a shared image for a complete song and keeps Single Shot ending guidance", () => {
  const config = project(), video = { ...newVideo(null), prompt: "@[ref:hero] dancing", musicSource: { kind: "asset" as const, id: "song" } };
  config.assets = [asset("song", "audio", 201000)]; config.videos = [video];
  config.references = [{ id: "hero", kind: "image", name: "Hero", description: "", intendedUse: [], relativePath: "references/hero.png", createdAt: config.createdAt }];
  const scenes = songScenes(video, config); config.generationJobs = scenes; video.sceneIds = scenes.map((job) => job.id);
  expect(scenes.length).toBe(21); expect(scenes.reduce((sum, job) => sum + sceneDurationSeconds(job), 0)).toBeCloseTo(201);
  for (const job of scenes) expect(sendBlocker(job, config.references, config)).toBeNull();
  const last = scenes.at(-1)!; const request = sceneGenerationRequest(last, config, "D:/Project", 8);
  expect(request.referencePaths).toEqual(["D:/Project/references/hero.png"]);
  expect(request.referenceAudios![0].startSeconds + request.referenceAudios![0].durationSeconds).toBeCloseTo(201);
  const single = { ...scenes[0], sceneType: "single-shot" as const, endingPrompt: "The dancer bows." };
  expect(sceneGenerationRequest(single, config, "D:/Project", 8).singleShot?.endingPrompt).toContain("<Audio 1>");
  expect(songScenes(video, config)).toEqual([]);
});

it("respects reference trims, detects missing and exhausted sources, and requires a visual anchor for music", () => {
  const config = project(), job = scene("first"); config.generationJobs = [job];
  config.references = [{ id: "trim", kind: "audio", name: "Trimmed song", description: "", intendedUse: [], sourcePath: "D:/song.wav", audio: { startSeconds: 45, durationSeconds: 10 }, createdAt: config.createdAt }];
  const video = { ...newVideo(null), sceneIds: [job.id], musicSource: { kind: "reference" as const, id: "trim" } }; config.videos = [video];
  expect(resolveVideoSource(video.musicSource, config, "audio")?.startSeconds).toBe(45);
  expect(sceneGenerationRequest(job, config, "D:/Project", 8).referenceAudios?.[0].startSeconds).toBe(45);
  expect(sendBlocker(job, config.references, config)).toMatch(/image or video/);
  expect(videoGuidedScene({ ...job, durationSeconds: 11 }, config).blocker).toMatch(/ends before/);
  expect(videoGuidedScene({ ...job, durationSeconds: 1 }, config).blocker).toMatch(/at least 2/);
  config.references = []; expect(sendBlocker(job, [], config)).toMatch(/unavailable/);
});

it("plays scenes in video order, skips drafts and excludes joined continuation prefixes", () => {
  const config = project(); config.generationJobs = [scene("first"), scene("draft"), scene("last", 8)];
  const video = { ...newVideo(null), sceneIds: ["last", "draft", "first"] };
  config.assets = [asset(generationAssetId("first"), "generated", 10250), { ...asset(generationAssetId("last"), "generated", 19000), sceneSegments: [{ sceneId: "last", startFrame: 240, frameCount: 216, latentRelativePath: "latents/last.safetensors" }] }];
  expect(videoPlaylist(video, config).map(({ sceneId, start, end }) => ({ sceneId, start, end }))).toEqual([{ sceneId: "last", start: 10, end: 18 }, { sceneId: "first", start: 0, end: 10 }]);
});
