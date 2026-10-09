import { generationAssetId, sceneDurationSeconds, sceneOutputFrames, type GenerationJob, type ProjectAsset, type ProjectConfig, type SceneGenerationInput, type SceneMediaSegment } from "./project";

export const LONG_SHOT_CONTEXT = 22;
export const bridgeGapFrames = (frames: number) => Math.max(12, Math.ceil((frames - 12) / 17) * 17 + 12);

/** Alternation restarts at the beginning of each consecutive Long Shot run. */
export function longShotPosition(job: GenerationJob, jobs: readonly GenerationJob[]) {
  if (job.sceneType !== "long-shot") return null;
  const index = jobs.findIndex((candidate) => candidate.id === job.id);
  if (index < 0) return null;
  let start = index;
  while (start > 0 && jobs[start - 1].sceneType === "long-shot") start--;
  const between = (index - start) % 2 === 1;
  const right = between && jobs[index + 1]?.sceneType === "long-shot" ? jobs[index + 1] : undefined;
  return { index, start, bridge: between && !!right, continuation: between && !right,
    left: between ? jobs[index - 1] : undefined, right,
    previousBridge: between && index - start > 1 ? jobs[index - 2] : undefined };
}

export function longShotDependencies(job: GenerationJob, jobs: readonly GenerationJob[]): GenerationJob[] {
  const position = longShotPosition(job, jobs);
  return position?.left ? [position.left, position.right].filter((source): source is GenerationJob => !!source) : [];
}

export function longShotBlocker(job: GenerationJob, config: ProjectConfig, requireCompleted = true): string | null {
  const position = longShotPosition(job, config.generationJobs);
  if (!position?.left) return null;
  const neighbors: [GenerationJob, number][] = [[position.left, position.continuation ? 0 : job.bridgeLeftMargin ?? 17]];
  if (position.right) neighbors.push([position.right, job.bridgeRightMargin ?? 17]);
  for (const [source, margin] of neighbors) {
    if (requireCompleted && (source.status !== "completed" || !source.latentRelativePath || !source.outputRelativePath))
      return `Generate “${source.title}” first, or use Generate all. ${position.continuation ? "The previous clip needs saved latents." : "Both neighboring clips need saved latents."}`;
    const sourceAsset = config.assets.find((asset) => asset.id === generationAssetId(source.id));
    if (requireCompleted && (sourceAsset?.sceneSegments?.length ?? 0) > 1)
      return `Regenerate “${source.title}” as a fresh Long Shot anchor first.`;
    const plannedFrames = Math.max(22, Math.ceil((sceneDurationSeconds(source) * 24 - 5) / 17) * 17 + 5);
    const frames = requireCompleted ? sceneOutputFrames(source, config) : Math.max(sceneOutputFrames(source, config) ?? 0, plannedFrames);
    if (frames != null && frames < margin + LONG_SHOT_CONTEXT) return `“${source.title}” needs at least ${margin + LONG_SHOT_CONTEXT} frames for this bridge. Reduce its editable margin or lengthen the source.`;
    if (!!source.latentUpscale !== !!job.latentUpscale) return "Use the same Latent upscale setting for the bridge and both neighboring clips.";
  }
  return null;
}

export function currentLongShotArchives(config: Pick<ProjectConfig, "assets" | "generationJobs">): ProjectAsset[] {
  const candidates = config.assets.filter((asset) => {
    const parts = asset.sceneSegments;
    const own = parts?.findIndex((part) => generationAssetId(part.sceneId) === asset.id) ?? -1;
    if (!parts || own <= 0) return false;
    const first = config.generationJobs.findIndex((job) => job.id === parts[0].sceneId);
    if (first < 0 || !parts.every((part, offset) => config.generationJobs[first + offset]?.id === part.sceneId && config.generationJobs[first + offset]?.sceneType === "long-shot")) return false;
    if (!parts.every((part) => config.generationJobs.some((job) => job.id === part.sceneId && job.status === "completed" && job.latentRelativePath === part.latentRelativePath))) return false;
    const owner = config.generationJobs.find((job) => generationAssetId(job.id) === asset.id)!;
    const position = longShotPosition(owner, config.generationJobs);
    if (!position?.left || position.left.id !== parts[own - 1].sceneId) return false;
    if (position.continuation ? own !== parts.length - 1 : !position.bridge || position.right?.id !== parts[own + 1]?.sceneId) return false;
    return true;
  }).sort((a, b) => config.generationJobs.findIndex((job) => generationAssetId(job.id) === a.id)
    - config.generationJobs.findIndex((job) => generationAssetId(job.id) === b.id));
  const valid: ProjectAsset[] = [];
  for (const asset of candidates) {
    const owner = config.generationJobs.find((job) => generationAssetId(job.id) === asset.id)!;
    const previous = longShotPosition(owner, config.generationJobs)?.previousBridge;
    // A newly completed earlier bridge changes the shared anchor's head.
    // A suffix must incorporate it, but an invalid earlier bridge is optional.
    if (previous && valid.some((candidate) => candidate.id === generationAssetId(previous.id))
      && !asset.sceneSegments!.some((part) => part.sceneId === previous.id)) continue;
    // Reject chains that embed an earlier, now-incompatible joined archive.
    if (asset.sceneSegments!.some((part) => {
      const job = config.generationJobs.find((job) => job.id === part.sceneId)!;
      return job.id !== owner.id && longShotPosition(job, config.generationJobs)?.bridge
        && !valid.some((candidate) => candidate.id === generationAssetId(job.id));
    })) continue;
    valid.push(asset);
  }
  return valid.sort((a, b) => b.sceneSegments!.length - a.sceneSegments!.length);
}

export function longShotPlaybackSource(job: GenerationJob, config: Pick<ProjectConfig, "assets" | "generationJobs">) {
  const source = currentLongShotArchives(config).find((asset) => asset.sceneSegments?.some((part) => part.sceneId === job.id && part.latentRelativePath === job.latentRelativePath));
  const segment = source?.sceneSegments?.find((part) => part.sceneId === job.id);
  return source && segment ? { source, segment } : null;
}

/** A final unpaired scene extends the latest joined archive, so earlier
 * bridge edits to the preceding anchor survive in its video and audio. */
export function longShotContinuationInputs(job: GenerationJob, config: ProjectConfig) {
  const position = longShotPosition(job, config.generationJobs);
  if (!position?.continuation || !position.left) return null;
  const { left, previousBridge } = position;
  const prefix = previousBridge && currentLongShotArchives(config).find((asset) => asset.id === generationAssetId(previousBridge.id)
    && asset.sceneSegments?.at(-1)?.sceneId === left.id);
  const segments = prefix?.sceneSegments ?? (left.latentRelativePath ? [{ sceneId: left.id, latentRelativePath: left.latentRelativePath,
    startFrame: 0, frameCount: sceneOutputFrames(left, config) ?? 0 }] : undefined);
  return { segments: segments ?? undefined, request: {
    previousSceneId: left.id,
    continuationRelativePath: (prefix ? previousBridge!.latentRelativePath : left.latentRelativePath) ?? undefined,
    continuationSourceFrames: sceneOutputFrames(left, config),
    continuationOverlapFrames: LONG_SHOT_CONTEXT, continuationFrom: "end" as const, continuationLockOverlap: false,
  } };
}

export function longShotInputs(job: GenerationJob, config: ProjectConfig): { bridge: NonNullable<SceneGenerationInput["latentBridge"]>; leftSegments?: SceneMediaSegment[] } | null {
  const position = longShotPosition(job, config.generationJobs);
  if (!position?.bridge) return null;
  const { left, right, previousBridge } = position;
  const prefix = previousBridge && currentLongShotArchives(config).find((asset) => asset.id === generationAssetId(previousBridge.id)
    && asset.sceneSegments?.at(-1)?.sceneId === left?.id);
  const leftSegments = prefix?.sceneSegments ?? (left?.latentRelativePath ? [{ sceneId: left.id, latentRelativePath: left.latentRelativePath, startFrame: 0, frameCount: sceneOutputFrames(left, config) ?? 0 }] : undefined);
  return { bridge: {
    leftSceneId: left?.id ?? "", rightSceneId: right?.id ?? "",
    ...(left?.latentRelativePath ? { leftRelativePath: prefix ? previousBridge!.latentRelativePath! : left.latentRelativePath,
      leftFrames: leftSegments!.at(-1)!.startFrame + leftSegments!.at(-1)!.frameCount } : {}),
    ...(right?.latentRelativePath ? { rightRelativePath: right.latentRelativePath, rightFrames: sceneOutputFrames(right, config) } : {}),
    leftMarginFrames: job.bridgeLeftMargin ?? 17, rightMarginFrames: job.bridgeRightMargin ?? 17, contextFrames: LONG_SHOT_CONTEXT,
  }, leftSegments: leftSegments ?? undefined };
}

export function bridgedSceneSegments(jobId: string, path: string, totalFrames: number, requestedFrames: number,
  bridge: NonNullable<SceneGenerationInput["latentBridge"]>, prefix?: SceneMediaSegment[]): SceneMediaSegment[] {
  const gap = bridgeGapFrames(requestedFrames);
  if (!bridge.leftRelativePath || !bridge.rightRelativePath || !bridge.leftFrames || !bridge.rightFrames
    || totalFrames !== bridge.leftFrames + gap + bridge.rightFrames) throw new Error("The Long Shot output does not contain both anchors and the complete bridge. Update the worker and regenerate.");
  return [...(prefix ?? [{ sceneId: bridge.leftSceneId, latentRelativePath: bridge.leftRelativePath, startFrame: 0, frameCount: bridge.leftFrames }]),
    { sceneId: jobId, latentRelativePath: path, startFrame: bridge.leftFrames, frameCount: gap },
    { sceneId: bridge.rightSceneId, latentRelativePath: bridge.rightRelativePath, startFrame: bridge.leftFrames + gap, frameCount: bridge.rightFrames }];
}
