import { createDraftGenerationJob, sceneDurationSeconds, sceneShots, type GenerationJob, type ProjectConfig, type ProjectReference, type ProjectVideo, type VideoSource } from "./project";
import { sceneMediaDurationMs, sceneMediaStartSeconds } from "./continuationMedia";

/** Older projects and scenes added by external tools remain visible. */
export function videoLibrary(config: ProjectConfig): ProjectVideo[] {
  const videos = config.videos ?? [];
  const assigned = new Set(videos.flatMap((video) => video.sceneIds));
  const unassigned = config.generationJobs.filter((scene) => !assigned.has(scene.id)).map((scene) => scene.id);
  if (!unassigned.length) return videos;
  const fallback = videos.find((video) => video.id === "video-default");
  return fallback ? videos.map((video) => video === fallback ? { ...video, sceneIds: [...video.sceneIds, ...unassigned] } : video)
    : [...videos, { id: "video-default", title: config.name || "Video 1", sceneIds: unassigned, prompt: "", createdAt: config.createdAt }];
}
export function videoScenes(video: ProjectVideo, config: ProjectConfig): GenerationJob[] {
  return video.sceneIds.flatMap((id) => { const scene = config.generationJobs.find((job) => job.id === id); return scene ? [scene] : []; });
}
export function newVideo(folderId: string | null): ProjectVideo {
  return { id: `video-${crypto.randomUUID()}`, title: "New video", folderId, sceneIds: [], prompt: "", createdAt: new Date().toISOString() };
}
export function resolveVideoSource(source: VideoSource | null | undefined, config: ProjectConfig, kind: "audio" | "video") {
  if (!source) return undefined;
  if (source.kind === "asset") {
    const asset = config.assets.find((asset) => asset.id === source.id && (asset.kind === kind || kind === "video" && asset.kind === "generated") && (asset.relativePath || asset.sourcePath));
    return asset ? { name: asset.name, relativePath: asset.relativePath, sourcePath: asset.sourcePath, startSeconds: kind === "video" ? sceneMediaStartSeconds(asset) : 0,
      durationSeconds: (kind === "video" ? sceneMediaDurationMs(asset) : asset.durationMs) != null ? (kind === "video" ? sceneMediaDurationMs(asset)! : asset.durationMs!) / 1000 : undefined } : undefined;
  }
  const reference = config.references.find((reference) => reference.id === source.id && reference.kind === kind && (reference.relativePath || reference.sourcePath));
  const range = kind === "audio" ? reference?.audio : reference?.video;
  return reference ? { name: reference.name, relativePath: reference.relativePath, sourcePath: reference.sourcePath,
    startSeconds: range?.startSeconds ?? 0, durationSeconds: range?.durationSeconds ?? undefined } : undefined;
}
export function videoSceneOffset(video: ProjectVideo, job: GenerationJob, config: ProjectConfig): number {
  const scenes = videoScenes(video, config), index = scenes.findIndex((scene) => scene.id === job.id);
  return scenes.slice(0, Math.max(0, index)).reduce((seconds, scene) => seconds + sceneDurationSeconds(scene), 0);
}

/** Generation-only copies: never write the injected prompt/reference bindings to the project. */
export function videoGuidedScene(job: GenerationJob, config: ProjectConfig): { job: GenerationJob; config: ProjectConfig; blocker: string | null } {
  const video = videoLibrary(config).find((video) => video.sceneIds.includes(job.id));
  if (!video || !video.prompt.trim() && !video.musicSource && !video.videoSource) return { job, config, blocker: null };
  const offset = videoSceneOffset(video, job, config), duration = sceneDurationSeconds(job);
  const references: ProjectReference[] = [];
  const guidance: string[] = video.prompt.trim() ? [video.prompt.trim()] : [];
  let blocker: string | null = null;
  if ((video.musicSource || video.videoSource) && ["animate", "character-replace", "extend", "bridge"].includes(job.sceneType ?? "")) {
    blocker = "Video-level references require a Prompt, Single Shot, Continue, First & Last Frame, Backdrop or Pose scene.";
  }
  for (const kind of ["audio", "video"] as const) {
    const chosen = kind === "audio" ? video.musicSource : video.videoSource;
    if (!chosen) continue;
    const source = resolveVideoSource(chosen, config, kind);
    if (!source) { blocker = `The video's ${kind === "audio" ? "music" : "video"} reference is unavailable. Select it again in Video settings.`; continue; }
    if (duration < 2) blocker = "Scenes using video-level references must last at least 2 seconds.";
    if (source.durationSeconds !== undefined && offset + duration > source.durationSeconds + 0.001) blocker = `The ${kind} reference ends before ${job.title}. Shorten the video or choose a longer reference.`;
    const id = `video-guide-${video.id}-${kind}`;
    references.push({ id, kind, name: source.name, description: "", intendedUse: kind === "audio" ? ["audio"] : [], relativePath: source.relativePath, sourcePath: source.sourcePath, createdAt: video.createdAt,
      ...(kind === "audio" ? { audio: { startSeconds: source.startSeconds + offset, durationSeconds: duration } }
        : { video: { startSeconds: source.startSeconds + offset, durationSeconds: duration, includeAudio: !video.musicSource } }) });
    guidance.push(kind === "audio" ? `Create visuals synchronized to the rhythm, mood and progression of @[ref:${id}]. This is the music segment for this scene.`
      : `Use @[ref:${id}] as the visual reference for this scene's time interval.`);
  }
  const text = guidance.join("\n");
  const shots = sceneShots(job).map((shot, index) => index === 0 ? { ...shot, action: [shot.action, text].filter(Boolean).join("\n") } : shot);
  const guided = { ...job, shots, ...(job.sceneType === "single-shot" && job.endingPrompt?.trim() ? { endingPrompt: `${job.endingPrompt}\n${text}` } : {}) };
  return { job: guided, config: { ...config, references: [...config.references, ...references] }, blocker };
}

/** Assign new scenes to the open Video and retain scene ordering after edits. */
export function mergeVideoScenes(current: ProjectConfig, videoId: string, edited: ProjectConfig): ProjectConfig {
  const videos = videoLibrary(current), video = videos.find((video) => video.id === videoId);
  if (!video) return current;
  const ids = new Set(video.sceneIds);
  const before = new Set(current.generationJobs.map((job) => job.id)), after = new Set(edited.generationJobs.map((job) => job.id));
  return { ...edited, videos: videos.map((item) => item.id === videoId
    ? { ...item, sceneIds: edited.generationJobs.filter((job) => ids.has(job.id) || !before.has(job.id)).map((job) => job.id) }
    : { ...item, sceneIds: item.sceneIds.filter((id) => after.has(id)) }) };
}

export function songScenes(video: ProjectVideo, config: ProjectConfig): GenerationJob[] {
  const seconds = resolveVideoSource(video.musicSource, config, "audio")?.durationSeconds;
  if (!seconds || seconds < 2 || video.sceneIds.length) return [];
  const count = Math.ceil(seconds / 10), duration = seconds / count;
  return Array.from({ length: count }, (_, index) => createDraftGenerationJob("", { sceneType: "prompt", title: `Scene ${index + 1}`, durationSeconds: duration }));
}
