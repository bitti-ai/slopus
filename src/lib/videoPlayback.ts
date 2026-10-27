import { generationAssetId, sceneDurationSeconds, type ProjectConfig, type ProjectVideo, type TimelineClip } from "./project";
import { scenePreviewAsset, scenePreviewJob } from "./sceneHistory";
import { continuationPlaybackTracks, sceneMediaDurationMs } from "./continuationMedia";
import { videoScenes } from "./videoLibrary";

/** A temporary timeline for the Video library. Never edits the project's timeline. */
export function videoPlaybackConfig(video: ProjectVideo, config: ProjectConfig): ProjectConfig {
  const members = videoScenes(video, config);
  const assets = new Map(config.assets.map((asset) => [asset.id, asset]));
  const clips: TimelineClip[] = [];
  let startMs = 0;
  for (const scene of members) {
    const selected = scenePreviewAsset(scene, config.assets);
    if (!selected?.relativePath) continue;
    const asset = { ...selected, id: generationAssetId(scene.id) };
    assets.set(asset.id, asset);
    // Generated lengths are frame-aligned and can exceed the requested length.
    // Keep every rendered frame so joined scenes share one uninterrupted decoder.
    const durationMs = Math.round(sceneMediaDurationMs(asset) ?? sceneDurationSeconds(scene) * 1000);
    if (durationMs <= 0) continue;
    clips.push({ id: `video-preview-${scene.id}`, assetId: asset.id, trackId: "video-preview", startMs, durationMs,
      sourceStartMs: 0, label: scene.title, status: "generated" });
    startMs += durationMs;
  }
  const memberIds = new Set(video.sceneIds);
  return { ...config, assets: [...assets.values()],
    generationJobs: config.generationJobs.map((scene) => memberIds.has(scene.id) ? scenePreviewJob(scene, config.assets) : scene),
    timeline: { tracks: [{ id: "video-preview", kind: "video", name: video.title, locked: false, muted: false, clips }] } };
}

/** Use exactly the resolved media/ranges that Timeline's monitor will display. */
export function videoPlaylist(video: ProjectVideo, config: ProjectConfig) {
  const preview = videoPlaybackConfig(video, config);
  return continuationPlaybackTracks(preview)[0].clips.map((clip) => ({
    sceneId: clip.id.slice("video-preview-".length), title: clip.label,
    asset: preview.assets.find((asset) => asset.id === clip.assetId)!,
    start: clip.sourceStartMs / 1000, end: (clip.sourceStartMs + clip.durationMs) / 1000,
    startMs: clip.startMs, durationMs: clip.durationMs,
  }));
}
