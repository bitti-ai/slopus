import { generationAssetId, type ProjectConfig } from "./project";

/** Drop a removed scene/song's library asset unless something still uses it. */
export function removeUnusedGenerationAssets(config: ProjectConfig, previous: ProjectConfig): ProjectConfig {
  const removed = new Set<string>();
  for (const job of previous.generationJobs) {
    if (config.generationJobs.some(item => item.id === job.id)) continue;
    removed.add(generationAssetId(job.id));
    for (const asset of previous.assets) {
      if (job.outputRelativePath && asset.kind === "generated" && asset.relativePath === job.outputRelativePath) removed.add(asset.id);
    }
  }
  for (const song of previous.musicSongs ?? []) {
    if (song.assetId && !config.musicSongs?.some(item => item.id === song.id && item.assetId === song.assetId)) removed.add(song.assetId);
  }
  for (const track of config.timeline.tracks) for (const clip of track.clips) removed.delete(clip.assetId);
  for (const song of config.musicSongs ?? []) if (song.assetId) removed.delete(song.assetId);
  for (const job of config.generationJobs) removed.delete(generationAssetId(job.id));
  for (const video of config.videos ?? []) {
    for (const source of [video.musicSource, video.videoSource]) if (source?.kind === "asset") removed.delete(source.id);
  }
  const assets = config.assets.filter(asset => !removed.has(asset.id));
  if (assets.length === config.assets.length) return config;
  const removedPaths = new Set(config.assets.filter(asset => removed.has(asset.id)).map(asset => asset.relativePath));
  return { ...config, assets, thumbnail: config.thumbnail && removedPaths.has(config.thumbnail) ? null : config.thumbnail };
}

/** Mirrors the managed path fields collected by project/cleanup.rs. */
export function generatedFilePaths(value: unknown, paths = new Set<string>(), folderPath?: string): Set<string> {
  if (Array.isArray(value)) for (const item of value) generatedFilePaths(item, paths, folderPath);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && (key.endsWith("RelativePath") || key === "relativePath" || key === "thumbnail" || key === "sourcePath")) {
      let path = item.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
      if (key === "sourcePath") {
        if (!folderPath) continue;
        const root = folderPath.replaceAll("\\", "/").replace(/\/$/, "") + "/";
        if (!path.toLowerCase().startsWith(root.toLowerCase())) continue;
        path = path.slice(root.length);
      }
      if (/^(media\/generated|latents|cache\/(scene-last|image-edits)|thumbnails\/timeline)\//i.test(path)) paths.add(path);
    } else if (typeof item === "object") generatedFilePaths(item, paths, folderPath);
  }
  return paths;
}

export function removesGeneratedFiles(previous: ProjectConfig, next: ProjectConfig, folderPath?: string): boolean {
  const retained = generatedFilePaths(next, new Set(), folderPath);
  return [...generatedFilePaths(previous, new Set(), folderPath)].some(path => !retained.has(path));
}
