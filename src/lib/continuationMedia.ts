import { clipPlaybackRate } from "./clipTiming";
import { GENERATION_FRAME_RATE, generationAssetId, sceneOutputFrames, type GenerationJob, type ProjectAsset, type ProjectConfig, type SceneMediaSegment, type TimelineClip } from "./project";

const milliseconds = (frames: number) => frames * 1000 / GENERATION_FRAME_RATE;
export const sceneMediaStartSeconds = (asset?: ProjectAsset) => (asset?.sceneSegments?.at(-1)?.startFrame ?? 0) / GENERATION_FRAME_RATE;

/** Editing coordinates stay relative to the scene, even when its file contains
 * the whole chain. Old, suffix-only assets need no offset. */
export const sceneMediaDurationMs = (asset: ProjectAsset): number | null | undefined =>
  asset.sceneSegments?.length ? Math.round(milliseconds(asset.sceneSegments.at(-1)!.frameCount)) : asset.durationMs;

export function assetSceneSegment(asset: ProjectAsset, jobs: readonly GenerationJob[]): SceneMediaSegment | undefined {
  if (asset.sceneSegments?.length) return asset.sceneSegments.at(-1);
  const job = jobs.find((candidate) => generationAssetId(candidate.id) === asset.id);
  return job?.latentRelativePath && asset.durationMs ? {
    sceneId: job.id, latentRelativePath: job.latentRelativePath, startFrame: 0,
    frameCount: Math.round(asset.durationMs * GENERATION_FRAME_RATE / 1000),
  } : undefined;
}

/** Reconstruct old suffix-only generations when their saved snapshots still
 * identify the exact ancestors. Current editable continuation settings are
 * deliberately ignored: they may describe a different, unrendered branch. */
export function sceneArchiveSegments(config: ProjectConfig, job: GenerationJob, seen = new Set<string>()): SceneMediaSegment[] | undefined {
  if (!job.latentRelativePath || seen.has(job.id)) return undefined;
  seen.add(job.id);
  const asset = config.assets.find((candidate) => candidate.id === generationAssetId(job.id));
  if (asset?.sceneSegments?.at(-1)?.latentRelativePath === job.latentRelativePath) return asset.sceneSegments;
  const frames = sceneOutputFrames(job, config);
  if (!frames) return undefined;
  try {
    const snapshot = JSON.parse(job.generationSnapshot ?? "null");
    if (snapshot?.continuationRelativePath) {
      const source = config.generationJobs.find((candidate) => candidate.id === snapshot.previousSceneId && candidate.latentRelativePath === snapshot.continuationRelativePath);
      if (!source) return undefined;
      const prefix = snapshot.continuationFrom === "start"
        ? [{ sceneId: source.id, latentRelativePath: source.latentRelativePath!, startFrame: 0, frameCount: snapshot.continuationOverlapFrames ?? 22 }]
        : sceneArchiveSegments(config, source, seen);
      if (!prefix?.length) return undefined;
      const last = prefix.at(-1)!;
      return [...prefix, { sceneId: job.id, latentRelativePath: job.latentRelativePath, startFrame: last.startFrame + last.frameCount, frameCount: frames }];
    }
  } catch { return undefined; }
  return [{ sceneId: job.id, latentRelativePath: job.latentRelativePath, startFrame: 0, frameCount: frames }];
}

/** Map adjacent scene clips to one jointly decoded source, without rewriting
 * authored trims, effects, placement or asset identity. Resolve backwards so
 * A -> B -> C uses C's joined decode throughout the chain. */
export function continuationPlaybackTracks(config: ProjectConfig) {
  const assets = new Map(config.assets.map((asset) => [asset.id, asset]));
  const resolved = new Map<string, TimelineClip>();
  const sorted = config.timeline.tracks.flatMap((track) => track.clips).sort((a, b) => a.startMs - b.startMs);
  for (let index = sorted.length - 1; index >= 0; index--) {
    const clip = sorted[index];
    const asset = assets.get(clip.assetId);
    const own = asset && assetSceneSegment(asset, config.generationJobs);
    let source = asset;
    let segment = own;
    if (own) {
      const following = sorted.filter((next) => next.id !== clip.id && Math.abs(clip.startMs + clip.durationMs - next.startMs) <= 1)
        .sort((a, b) => Number(b.trackId === clip.trackId) - Number(a.trackId === clip.trackId));
      for (const next of following) {
        const nextClip = resolved.get(next.id);
        const joined = nextClip && assets.get(nextClip.assetId);
        const matching = joined?.sceneSegments?.find((part) => part.sceneId === own.sceneId && part.latentRelativePath === own.latentRelativePath);
        // A Start continuation contains only the opening overlap, so do
        // not pretend that its source file contains the whole original scene.
        if (matching && clip.sourceStartMs + clip.durationMs * clipPlaybackRate(clip) <= milliseconds(matching.frameCount) + 1) {
          source = joined;
          segment = matching;
          break;
        }
      }
    }
    resolved.set(clip.id, source && segment ? { ...clip, assetId: source.id, sourceStartMs: clip.sourceStartMs + milliseconds(segment.startFrame) } : clip);
  }
  return config.timeline.tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => resolved.get(clip.id)!) }));
}

/** Called with the source metadata captured when the queue attaches latents,
 * rather than with settings that the user may have edited during generation. */
export function joinedSceneSegments(sceneId: string, latentRelativePath: string, totalFrames: number, newFrames: number,
  source?: { sceneId: string; latentRelativePath: string; frameCount: number; segments?: readonly SceneMediaSegment[]; from?: "start" | "end" }): SceneMediaSegment[] {
  const prefix = source ? totalFrames - newFrames : 0;
  if (prefix < 0 || newFrames <= 0 || (source && prefix <= 0)) throw new Error("The continuation output is missing its joined source frames. Update the worker and regenerate.");
  let segments: SceneMediaSegment[] = [];
  if (source) {
    if (source.from === "start") segments = [{ sceneId: source.sceneId, latentRelativePath: source.latentRelativePath, startFrame: 0, frameCount: prefix }];
    else if (source.segments?.length && source.segments.at(-1)!.startFrame + source.segments.at(-1)!.frameCount === prefix) segments = [...source.segments];
    else segments = [{ sceneId: source.sceneId, latentRelativePath: source.latentRelativePath, startFrame: Math.max(0, prefix - source.frameCount), frameCount: Math.min(prefix, source.frameCount) }];
  }
  return [...segments, { sceneId, latentRelativePath, startFrame: prefix, frameCount: source ? newFrames : totalFrames }];
}
