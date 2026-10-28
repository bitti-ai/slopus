import { sceneHistory } from "./sceneHistory";
import type { GenerationJob, ProjectConfig } from "./project";
import type { GeneratorTemplate } from "./settings";
import type { GenerationSubmission } from "./workQueue";

export function selectedUpscaleTake(job: GenerationJob, config: ProjectConfig) {
  const history = sceneHistory(job, config.assets);
  return history.versions.find(take => take.id === history.selectedId);
}

export function sceneUpscaleSubmission(job: GenerationJob, config: ProjectConfig, scale: number, template: GeneratorTemplate): GenerationSubmission {
  const source = selectedUpscaleTake(job, config);
  if (!source?.latentRelativePath) throw new Error("Select a generated Take with saved latents to upscale.");
  if (![1.5, 2, 4].includes(scale)) throw new Error("Choose an upscale factor of 1.5, 2 or 4.");
  if (["queued", "generating", "ready"].includes(job.status)) throw new Error("Wait for this scene to finish before upscaling.");
  return { job, template, upscaleSource: source, snapshot: source.generationSnapshot ?? "",
    request: { jobId: job.id, prompt: "", steps: source.scene.steps ?? 8, seed: source.scene.seed ?? -1,
      frames: Math.round((source.media.durationMs ?? 0) * 24 / 1000), canvasWidth: source.media.width ?? 0, canvasHeight: source.media.height ?? 0,
      referencePaths: [], latentUpscaleSource: { path: source.latentRelativePath, scale } } };
}
