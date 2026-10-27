import { isTauri } from "./persistence";
import { restoreGeneratedImage, saveImageDraft } from "./imageHistory";
import { compileImagePrompt } from "./imagePrompt";
import { compileImageEdits } from "./imageEditing";
import { imageScenePrompt } from "./imageScene";
import { longShotBlocker } from "./longShot";
import { continuationBlocker, continuationSceneId, generationAssetId, sceneGenerationPending, sceneGenerationSnapshot, sceneTypeFor } from "./project";
import type { ProjectSession } from "./projectSession";
import { sceneGenerationRequest, sendBlocker, templateSceneBlocker } from "./sceneGeneration";
import { generatorPathFields, loadGeneratorTemplateSettings, templateSupportsMusic, templateUsable } from "./settings";
import { isWorkActive, projectQueueKey, type WorkQueue } from "./workQueue";

export interface SceneGenerateCommand { op: "scene.generate"; scene: string; template: string }
export interface ImageGenerateCommand { op: "image.generate"; image: string; template: string }
export interface MusicGenerateCommand { op: "music.generate"; song: string; template: string }
export type AgentGenerateCommand = SceneGenerateCommand | ImageGenerateCommand | MusicGenerateCommand;
export interface GenerationObservation {
  scene?: string;
  image?: string;
  song?: string;
  sourceSong?: string;
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
    : command.op === "music.generate" ? generateAgentMusic(queue, session, command, signal, onProgress)
    : generateAgentScene(queue, session, command, signal, onProgress);
}

export async function generateAgentMusic(queue: WorkQueue, session: ProjectSession, command: MusicGenerateCommand,
  signal: AbortSignal, onProgress: (text: string) => void): Promise<GenerationObservation> {
  signal.throwIfAborted();
  if (!isTauri()) throw new Error("Music generation requires the desktop app.");
  const source = session.getSnapshot().config.musicSongs?.find((song) => song.id === command.song);
  if (!source) throw new Error(`Song '${command.song}' was not found. Use music.add first.`);
  const template = loadGeneratorTemplateSettings().templates.find((item) => item.id === command.template);
  if (!template || !templateSupportsMusic(template)) throw new Error("Choose an existing music generator template.");
  if (!templateUsable(template) || !generatorPathFields(template).every(({ id, required }) => !required || template.paths[id].trim() || template.sources?.[id]?.length))
    throw new Error(`Generator '${template.name}' needs its weights prepared before generation.`);
  if (queue.getSnapshot().some((item) => item.projectKey === projectQueueKey(session.record) && item.kind === "music" && item.sceneId === source.id && isWorkActive(item)))
    throw new Error(`Song '${source.title}' already has generation in progress.`);
  const songId = queue.enqueueMusic(session, source.id, template);
  const work = queue.getSnapshot().find((item) => item.projectKey === projectQueueKey(session.record) && item.kind === "music" && item.sceneId === songId && isWorkActive(item));
  if (!work) throw new Error("Music could not be queued.");
  const cancel = () => { void queue.cancel(work.id).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) { cancel(); signal.throwIfAborted(); }
    let lastDetail = "";
    const item = await queue.waitFor(work.id, signal, (progress) => {
      if (lastDetail !== progress.detail) { lastDetail = progress.detail; onProgress(`${source.title}: ${progress.detail}`); }
    });
    signal.throwIfAborted();
    const config = session.getSnapshot().config;
    const song = config.musicSongs?.find((song) => song.id === songId);
    const asset = config.assets.find((asset) => asset.id === song?.assetId);
    return { song: songId, sourceSong: source.id, template: template.id, workId: work.id,
      status: item.status === "completed" ? "completed" : item.status === "cancelled" ? "cancelled" : "failed",
      detail: item.detail, error: item.error, needsSave: item.needsSave,
      ...(item.status === "completed" || item.needsSave ? { assetId: asset?.id, outputRelativePath: asset?.relativePath } : {}) };
  } finally { signal.removeEventListener("abort", cancel); }
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
    ?? longShotBlocker(job, config, true, true)
    ?? (source && !sceneGenerationPending(source) && (!source.latentRelativePath || source.status !== "completed") ? "Generate or queue the selected source scene first." : null)
    ?? templateSceneBlocker(sceneTypeFor(job), template) ?? sendBlocker(job, config.references, config);
  if (blocker) throw new Error(blocker);
  const request = sceneGenerationRequest(job, config, session.record.folderPath, template.defaultSteps, template);
  const [id] = queue.enqueue(session, [{ job, request, snapshot: sceneGenerationSnapshot(job, request) }], template);
  if (!id) throw new Error("This scene is already queued.");
  // Stop cancels this run and its linked generation group. Encoding already in
  // progress is allowed to finish safely, but the stopped agent will not resume.
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
