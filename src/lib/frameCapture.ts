import { openLayerFrameReader } from "./exportPipeline";
import { GENERATION_FRAME_RATE, sceneDurationSeconds, sceneShots, type ProjectAsset, type ProjectConfig } from "./project";
import { sceneHistory } from "./sceneHistory";
import { captureTimelineFrame } from "./timelineCapture";

/** Read-only agent operations. All locations resolve from the turn's project snapshot. */
export type FrameCaptureTarget =
  | { op: "timeline.capture"; at: number }
  | { op: "scene.capture"; scene: string; at?: number; generation?: string }
  | { op: "shot.capture"; scene: string; shot: string; at?: number; generation?: string }
  | { op: "reference.capture"; reference: string; at?: number; image?: string }
  | { op: "image.capture"; image: string }
  | { op: "motion.capture"; motion: string; at?: number };

function within(at: number, duration?: number | null) {
  if (!Number.isFinite(at) || at < 0 || (duration != null && at >= duration)) {
    throw new Error(`Capture time must be nonnegative and within the requested media${duration == null ? "" : ` (0 to ${duration} seconds, end exclusive)`}.`);
  }
}

/** Resolve scene/shot times against the rendered take, never an unsent Draft. */
export function sourceCapturePlan(config: ProjectConfig, target: Exclude<FrameCaptureTarget, { op: "timeline.capture" }>) {
  let asset: ProjectAsset;
  let at = "at" in target ? target.at ?? 0 : 0;
  within(at);
  switch (target.op) {
    case "motion.capture": {
      const found = config.assets.find(a => a.id === target.motion);
      if (!found || found.kind !== "motion" || !found.motion) throw new Error(`Motion '${target.motion}' does not exist.`);
      within(at, found.motion.duration);
      asset = found;
      break;
    }
    case "image.capture": {
      const found = config.assets.find(a => a.id === target.image);
      if (!found || found.kind !== "image" || found.imageDraft) throw new Error(`Image '${target.image}' has no completed image to capture.`);
      asset = found;
      break;
    }
    case "scene.capture":
    case "shot.capture": {
      const job = config.generationJobs.find(j => j.id === target.scene);
      if (!job) throw new Error(`Scene '${target.scene}' does not exist.`);
      const history = sceneHistory(job, config.assets);
      const version = history.versions.find(v => v.id === (target.generation ?? history.primaryId));
      if (!version) throw new Error(`Scene '${target.scene}' has no ${target.generation ? `generation '${target.generation}'` : "completed primary generation"} to capture.`);
      asset = version.media;
      const rendered = { ...job, ...version.scene, shots: version.scene.shots,
        shotTags: version.scene.shotTags, durationSeconds: version.scene.durationSeconds };
      const segment = asset.sceneSegments?.find(s => s.sceneId === job.id);
      const duration = segment ? segment.frameCount / GENERATION_FRAME_RATE : (asset.durationMs != null ? asset.durationMs / 1000 : sceneDurationSeconds(rendered));
      if (target.op === "shot.capture") {
        const shots = sceneShots(rendered);
        const index = shots.findIndex(s => s.id === target.shot);
        if (index < 0) throw new Error(`Shot '${target.shot}' does not exist in this generation of scene '${target.scene}'.`);
        const start = shots[index].startSeconds;
        within(at, Math.min(duration, shots[index + 1]?.startSeconds ?? duration) - start);
        at += start;
      }
      within(at, duration);
      at += (segment?.startFrame ?? 0) / GENERATION_FRAME_RATE;
      break;
    }
    case "reference.capture": {
      const reference = config.references.find(r => r.id === target.reference);
      if (!reference) throw new Error(`Reference '${target.reference}' does not exist.`);
      const images = [...(reference.images ?? []), ...(reference.video?.frames ?? [])];
      const picture = target.image ? images.find(i => i.id === target.image)
        : reference.kind === "video" ? undefined : images[0];
      if (target.image && !picture) throw new Error(`Image '${target.image}' does not exist in reference '${target.reference}'.`);
      const video = !picture && reference.kind === "video";
      if (!picture && !video && reference.kind !== "image") throw new Error(`Reference '${target.reference}' has no image or video to capture.`);
      if (!video && at !== 0) throw new Error("Still image captures require at: 0 (or omit at).");
      if (video) {
        within(at, reference.video?.durationSeconds);
        at += reference.video?.startSeconds ?? 0;
      }
      const location = picture ?? reference;
      const extension = (location.relativePath ?? ("sourcePath" in location ? location.sourcePath : "") ?? "").split(".").pop()?.toLowerCase();
      const imageMime = extension === "jpg" || extension === "jpeg" ? "image/jpeg"
        : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/png";
      asset = { id: picture?.id ?? reference.id, name: location.name, kind: video ? "video" : "image",
        mimeType: video ? "video/mp4" : imageMime, relativePath: location.relativePath,
        sourcePath: "sourcePath" in location ? location.sourcePath : undefined, createdAt: reference.createdAt };
      break;
    }
  }
  if (!asset.motion && !asset.relativePath && !asset.sourcePath) throw new Error(`'${asset.name}' has no media file to capture.`);
  return { asset, sourceTimeUs: Math.round(at * 1_000_000) };
}

export async function captureFrame(config: ProjectConfig, folderPath: string, target: FrameCaptureTarget, signal: AbortSignal) {
  signal.throwIfAborted();
  if (target.op === "timeline.capture") return captureTimelineFrame(config, folderPath, target.at, signal);
  const plan = sourceCapturePlan(config, target);
  const check = () => signal.throwIfAborted();
  const reader = await openLayerFrameReader(folderPath, plan.asset, plan.sourceTimeUs, check);
  try {
    check();
    if (reader.durationUs != null) within(plan.sourceTimeUs / 1_000_000, reader.durationUs / 1_000_000);
    const frame = await reader.frameAt(plan.sourceTimeUs);
    check();
    const scale = Math.min(1, 1536 / Math.max(frame.displayWidth, frame.displayHeight));
    const width = Math.max(1, Math.round(frame.displayWidth * scale));
    const height = Math.max(1, Math.round(frame.displayHeight * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not encode the frame capture.");
    context.drawImage(frame, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    check();
    const pngBase64 = await new Promise<string>((resolve, reject) => {
      const file = new FileReader();
      file.onerror = () => reject(file.error ?? new Error("Could not read the frame capture."));
      file.onload = () => resolve(String(file.result).split(",")[1]);
      file.readAsDataURL(blob);
    });
    check();
    return { pngBase64, timeMs: frame.timestamp / 1000, width, height };
  } finally { reader.dispose(); }
}
