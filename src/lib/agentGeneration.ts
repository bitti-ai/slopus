import { isTauri } from "./persistence";
import { restoreGeneratedImage, saveImageDraft } from "./imageHistory";
import { compileImagePrompt } from "./imagePrompt";
import { compileImageEdits } from "./imageEditing";
import { imageScenePrompt } from "./imageScene";
import { longShotBlocker } from "./longShot";
import { continuationBlocker, continuationSceneId, generationAssetId, sceneGenerationSnapshot } from "./project";
import type { ProjectSession } from "./projectSession";
import { sceneGenerationRequest, sendBlocker, templateSceneBlocker } from "./sceneGeneration";
import { loadGeneratorTemplateSettings, templateUsable } from "./settings";
import { isWorkActive, projectQueueKey, type WorkQueue } from "./workQueue";

export interface SceneGenerateCommand { op: "scene.generate"; scene: string; template: string }
export interface ImageGenerateCommand { op: "image.generate"; image: string; template: string }
export type AgentGenerateCommand = SceneGenerateCommand | ImageGenerateCommand;
export interface GenerationObservation {
  scene?: string;
  image?: string;
  template: string;
  status: "completed" | "failed" | "cancelled" | "rejected";
  workId?: string;
  detail: string;
  error?: string | null;
  needsSave?: boolean;
  assetId?: string;
  outputRelativePath?: string | null;
}

export function generateAgentMedia(queue: WorkQueue, session: ProjectSession, command: AgentGenerateCommand,
  signal: AbortSignal, onProgress: (text: string) => void): Promise<GenerationObservation> {
  return command.op === "image.generate" ? generateAgentImage(queue, session, command, signal, onProgress)
    : generateAgentScene(queue, session, command, signal, onProgress);
}

export async function generateAgentImage(queue: WorkQueue, session: ProjectSession, command: ImageGenerateCommand,
  signal: AbortSignal, onProgress: (text: string) => void): Promise<GenerationObservation> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error("Image generation requires the desktop app.");
  const config = session.getSnapshot().config;
  const draft = config.assets.find((asset) => asset.id === command.image && asset.kind === "image" && asset.imageDraft && asset.imageGeneration && !asset.imageGeneration.template);
  if (!draft) throw new Error(`Editable image draft '${command.image}' was not found.`);
  const template = loadGeneratorTemplateSettings().templates.find((candidate) => candidate.id === command.template);
  if (!template) throw new Error(`Generator template '${command.template}' no longer exists.`);
  if (template.mode === "animate") throw new Error("Choose a prompt generator for images.");
  if (!templateUsable(template)) throw new Error(`Generator '${template.name}' needs its weights or LoRAs prepared before generation.`);
  if (queue.getSnapshot().some((item) => item.projectKey === projectQueueKey(session.record) && (item.imageAssetId === draft.id || item.imageDraftId === draft.id) && isWorkActive(item))) {
    throw new Error(`Image '${draft.name}' already has generation in progress. Do not submit it again.`);
  }
  const restored = restoreGeneratedImage(saveImageDraft(config), draft.id);
  // Validate before switching the editor or submitting work.
  if (!restored.imageScene || !imageScenePrompt(restored.imageScene)) throw new Error("Describe the image or add an object before generating.");
  if (restored.imageScene?.rootType === "image") compileImageEdits(restored);
  else compileImagePrompt(restored);
  session.update(restored);
  const id = queue.enqueueImage(session, template);
  if (!id) throw new Error("This image is already queued.");
  const cancel = () => { void queue.cancel(id).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    let lastDetail = "";
    const item = await queue.waitFor(id, signal, (work) => {
      const detail = `${draft.name} · ${template.name}: ${work.detail}`;
      if (detail !== lastDetail) { lastDetail = detail; onProgress(detail); }
    });
    signal.throwIfAborted();
    const asset = session.getSnapshot().config.assets.find((asset) => asset.id === draft.id);
    return { image: draft.id, template: template.id, workId: id,
      status: item.status === "completed" ? "completed" : item.status === "cancelled" ? "cancelled" : "failed",
      detail: item.detail, error: item.error, needsSave: item.needsSave,
      ...(item.status === "completed" || item.needsSave ? { assetId: asset?.id, outputRelativePath: asset?.relativePath } : {}),
    };
  } finally { signal.removeEventListener("abort", cancel); }
}

/** Choose an engine for this run without changing the user's global selection.
 * The queue snapshots the inputs and owns the output throughout encode/save. */
export async function generateAgentScene(queue: WorkQueue, session: ProjectSession, command: SceneGenerateCommand,
  signal: AbortSignal, onProgress: (text: string) => void): Promise<GenerationObservation> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error("Scene generation requires the desktop app.");
  const config = session.getSnapshot().config;
  const job = config.generationJobs.find((candidate) => candidate.id === command.scene);
  if (!job) throw new Error(`Scene '${command.scene}' no longer exists.`);
  const template = loadGeneratorTemplateSettings().templates.find((candidate) => candidate.id === command.template);
  if (!template) throw new Error(`Generator template '${command.template}' no longer exists.`);
  if (!templateUsable(template)) throw new Error(`Generator '${template.name}' needs its weights or LoRAs prepared before generation.`);
  if (queue.getSnapshot().some((item) => item.projectKey === projectQueueKey(session.record) && item.sceneId === job.id && isWorkActive(item))) {
    throw new Error(`Scene '${job.title}' already has generation in progress. Do not submit it again.`);
  }
  const source = config.generationJobs.find((candidate) => candidate.id === continuationSceneId(job, config.generationJobs));
  const blocker = continuationBlocker(job, config.generationJobs)
    ?? longShotBlocker(job, config)
    ?? (source && (!source.latentRelativePath || source.status !== "completed") ? "Generate the selected source scene first." : null)
    ?? templateSceneBlocker(job.sceneType ?? "first-last-frame", template) ?? sendBlocker(job, config.references);
  if (blocker) throw new Error(blocker);
  const request = sceneGenerationRequest(job, config, session.record.folderPath, template.defaultSteps, template);
  const [id] = queue.enqueue(session, [{ job, request, snapshot: sceneGenerationSnapshot(job, request) }], template);
  if (!id) throw new Error("This scene is already queued.");
  // Stop affects only the work this agent started. Encoding already in progress
  // is allowed to finish safely, but the stopped agent will not resume.
  const cancel = () => { void queue.cancel(id).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    let lastDetail = "";
    const item = await queue.waitFor(id, signal, (work) => {
      const detail = `${job.title} · ${template.name}: ${work.detail}`;
      if (detail !== lastDetail) { lastDetail = detail; onProgress(detail); }
    });
    signal.throwIfAborted();
    const current = session.getSnapshot().config;
    const asset = current.assets.find((asset) => asset.id === generationAssetId(job.id));
    return { scene: job.id, template: template.id, workId: id,
      status: item.status === "completed" ? "completed" : item.status === "cancelled" ? "cancelled" : "failed",
      detail: item.detail, error: item.error, needsSave: item.needsSave,
      ...(item.status === "completed" || item.needsSave ? { assetId: asset?.id, outputRelativePath: asset?.relativePath } : {}),
    };
  } finally { signal.removeEventListener("abort", cancel); }
}
