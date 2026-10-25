import { bitrateFor, buildExportPlan, defaultExportSettings } from "./export";
import { type ProjectAsset, type ProjectConfig, type ProjectReference } from "./project";

/** Bake the complete Motion, independent of its current timeline placement.
 * Short motions hold their final pose to satisfy the two-second video input. */
export function motionReferenceExport(config: ProjectConfig, asset: ProjectAsset) {
  if (!asset.motion) throw new Error("Select a Motion to render as a reference.");
  const durationMs = Math.max(2000, Math.round(asset.motion.duration * 1000));
  const snapshot: ProjectConfig = { ...structuredClone(config), generationJobs: [], assets: [structuredClone(asset)],
    timeline: { ...config.timeline, tracks: [{ id: "motion-reference", kind: "video", name: "Motion", locked: false, muted: true,
      clips: [{ id: "motion-reference-clip", assetId: asset.id, trackId: "motion-reference", startMs: 0, durationMs, sourceStartMs: 0, label: asset.name, status: "approved" }] }] } };
  const settings = { ...defaultExportSettings(snapshot), width: Math.ceil(asset.motion.width / 2) * 2, height: Math.ceil(asset.motion.height / 2) * 2, frameRate: 24 as const };
  const plan = buildExportPlan(snapshot, settings);
  if (plan.blockers.length) throw new Error(plan.blockers.join(" "));
  return { config: snapshot, settings, plan, bitrate: bitrateFor(settings.width, settings.height, settings.frameRate, "high") };
}

export function motionVideoReference(asset: ProjectAsset, relativePath: string): ProjectReference {
  return { id: `ref-${crypto.randomUUID()}`, kind: "video", name: `${asset.name} Motion`, description: "", relativePath,
    intendedUse: ["style"], createdAt: new Date().toISOString(),
    video: { mode: "video", startSeconds: 0, durationSeconds: Math.min(15, Math.max(2, asset.motion!.duration)), includeAudio: false } };
}
