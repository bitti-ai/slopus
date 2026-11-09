import { expect, it } from "vitest";
import { createDraftGenerationJob, createProjectConfig, generationAssetId, projectReferenceSchema } from "./project";
import { sceneVideoReference } from "./sceneReference";

it("retains the complete joined video and offsets each shot's selection into it", () => {
  const config = createProjectConfig({ name: "References", prompt: "Action", resolution: "1080p", aspectRatio: "16:9", targetDurationSeconds: 20 });
  const job = createDraftGenerationJob("Action", { id: "scene", title: "Continuation", durationSeconds: 6,
    shots: [{ id: "first", startSeconds: 0, action: "First" }, { id: "last", name: "Ending", startSeconds: 5.5, action: "Last" }] });
  job.outputRelativePath = "media/joined.mp4";
  job.status = "completed";
  config.generationJobs = [job];
  config.assets = [{ id: generationAssetId(job.id), name: job.title, kind: "generated", mimeType: "video/mp4", relativePath: job.outputRelativePath,
    durationMs: 26000, hasAudio: false, createdAt: config.createdAt,
    sceneSegments: [{ sceneId: "previous", latentRelativePath: "latents/previous.safetensors", startFrame: 0, frameCount: 480 },
      { sceneId: job.id, latentRelativePath: "latents/current.safetensors", startFrame: 480, frameCount: 144 }] }];
  const scene = projectReferenceSchema.parse(sceneVideoReference(config, job));
  const first = projectReferenceSchema.parse(sceneVideoReference(config, job, "first"));
  const last = projectReferenceSchema.parse(sceneVideoReference(config, job, "last"));
  expect([scene.relativePath, first.relativePath, last.relativePath]).toEqual(Array(3).fill("media/joined.mp4"));
  expect(scene.video).toMatchObject({ startSeconds: 0, durationSeconds: 26, includeAudio: false });
  expect(first.video).toMatchObject({ startSeconds: 20, durationSeconds: 5.5 });
  expect(last.video).toMatchObject({ startSeconds: 25.5, durationSeconds: 0.5 });
  expect(last.name).toBe("Continuation — Ending");
  expect(sceneVideoReference(config, job, "deleted")).toBeNull();
});
