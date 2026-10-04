import { continuationPlaybackTracks } from "./continuationMedia";
import { clipFrameStyle, clipVisualSettings, outputDimensions, videoDurationMs, visibleClipsAt } from "./export";
import { createCaptureCompositor, openLayerFrameReader } from "./exportPipeline";
import type { ProjectConfig } from "./project";

/** Resolve just one output frame, without building a whole export plan. */
export function timelineCapturePlan(config: ProjectConfig, at: number) {
  const tracks = continuationPlaybackTracks(config);
  const durationMs = videoDurationMs({ ...config, timeline: { tracks } });
  if (!Number.isFinite(at) || at < 0 || at * 1000 >= durationMs) {
    throw new Error(`Capture time must be within the video timeline (0 to ${durationMs / 1000} seconds, end exclusive).`);
  }
  const frameRate = config.settings.frameRate;
  const frameIndex = Math.floor(at * frameRate + 1e-8);
  const timeMs = frameIndex * 1000 / frameRate;
  const assets = new Map(config.assets.map((asset) => [asset.id, asset]));
  const layers = visibleClipsAt(tracks, timeMs, assets).reverse().map((clip) => {
    const asset = assets.get(clip.assetId);
    if (!asset) throw new Error(`Clip "${clip.label}" points at missing media.`);
    if (!asset.relativePath && !asset.sourcePath) throw new Error(`Clip "${clip.label}" has no generated or imported media to capture.`);
    return { asset, sourceTimeUs: Math.round((clip.sourceStartMs + timeMs - clip.startMs) * 1000),
      style: clipFrameStyle(clipVisualSettings(clip), timeMs - clip.startMs) };
  });
  const dimensions = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  // Vision context stays bounded. Never upscale a small project.
  const scale = Math.min(1, 1536 / Math.max(dimensions.width, dimensions.height));
  return { timeMs, frameRate, layers, background: config.settings.backgroundColor,
    width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)) };
}

export async function captureTimelineFrame(config: ProjectConfig, folderPath: string, at: number, signal: AbortSignal) {
  const plan = timelineCapturePlan(config, at);
  const check = () => signal.throwIfAborted();
  const readers: Awaited<ReturnType<typeof openLayerFrameReader>>[] = [];
  let compositor: Awaited<ReturnType<typeof createCaptureCompositor>> | undefined;
  try {
    check();
    const pictures = [];
    for (const layer of plan.layers) {
      const reader = await openLayerFrameReader(folderPath, layer.asset, layer.sourceTimeUs, check);
      readers.push(reader);
      pictures.push({ frame: await reader.frameAt(layer.sourceTimeUs), style: layer.style });
    }
    check();
    compositor = await createCaptureCompositor(plan.width, plan.height, plan.background);
    check();
    // No await between clear/draw/take: WebGPU canvas textures expire on yield.
    compositor.clear();
    for (const picture of pictures) compositor.draw(picture.frame, picture.style);
    const frame = compositor.take(Math.round(plan.timeMs * 1000), Math.round(1_000_000 / plan.frameRate));
    let blob: Blob;
    try {
      const canvas = new OffscreenCanvas(plan.width, plan.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not encode the timeline capture.");
      context.drawImage(frame, 0, 0);
      blob = await canvas.convertToBlob({ type: "image/png" });
    } finally { frame.close(); }
    check();
    const pngBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("Could not read the timeline capture."));
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.readAsDataURL(blob);
    });
    check();
    return { pngBase64, timeMs: plan.timeMs, width: plan.width, height: plan.height };
  } finally {
    readers.forEach((reader) => reader.dispose());
    compositor?.dispose();
  }
}
