import { sceneMediaStartSeconds } from "./continuationMedia";
import { longShotPlaybackSource } from "./longShot";
import { GENERATION_FRAME_RATE, sceneDurationSeconds, sceneShots, type GenerationJob, type ProjectConfig, type ProjectReference } from "./project";
import { scenePreviewAsset, scenePreviewJob } from "./sceneHistory";

/** Keep the complete generated file; a shot is a non-destructive clip selection. */
export function sceneVideoReference(config: ProjectConfig, job: GenerationJob, shotId?: string): ProjectReference | null {
  const joined = job.generationHistory?.selectedId ? null : longShotPlaybackSource(job, config);
  const asset = joined?.source ?? scenePreviewAsset(job, config.assets);
  const relativePath = joined?.source.relativePath ?? scenePreviewJob(job, config.assets).outputRelativePath;
  if (!relativePath) return null;
  const offset = joined ? joined.segment.startFrame / GENERATION_FRAME_RATE : sceneMediaStartSeconds(asset);
  const segments = asset?.sceneSegments;
  const sourceDuration = asset?.durationMs ? asset.durationMs / 1000
    : segments?.length ? Math.max(...segments.map(part => part.startFrame + part.frameCount)) / GENERATION_FRAME_RATE
    : offset + sceneDurationSeconds(job);
  const shots = sceneShots(job);
  const index = shotId ? shots.findIndex(shot => shot.id === shotId) : -1;
  if (shotId && index < 0) return null;
  const shot = shots[index];
  const startSeconds = shot ? offset + shot.startSeconds : 0;
  const endSeconds = shot ? Math.min(sourceDuration, offset + (shots[index + 1]?.startSeconds ?? sceneDurationSeconds(job))) : sourceDuration;
  if (endSeconds <= startSeconds) return null;
  return {
    id: `ref-${crypto.randomUUID()}`, kind: "video", name: shot ? `${job.title} — ${shot.name ?? `Shot ${index + 1}`}` : job.title,
    description: "", relativePath, intendedUse: [], createdAt: new Date().toISOString(),
    video: { mode: "video", startSeconds, durationSeconds: endSeconds - startSeconds, includeAudio: asset?.hasAudio ?? true },
  };
}
