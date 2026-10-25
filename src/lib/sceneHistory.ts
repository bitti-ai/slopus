import { createDraftGenerationJob, generationAssetId, sceneInputSchema, sceneShots, type GenerationJob, type ProjectConfig, type ProjectAsset, type SceneInput, type SceneGenerationVersion } from "./project";

/** Retention policy, independent of the persisted array and the bar layout. */
export const SCENE_GENERATION_HISTORY_LIMIT = 4;
export const sceneInput = (job: GenerationJob): SceneInput => sceneInputSchema.parse(job);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v != null).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const sameSceneInput = (a: SceneInput, b: SceneInput) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function applyInput(job: GenerationJob, input: SceneInput): GenerationJob {
  // Delete absent optional controls too: a newer take may have added one.
  const next = { ...job };
  for (const key of Object.keys(sceneInputSchema.shape)) delete (next as unknown as Record<string, unknown>)[key];
  return { ...next, ...structuredClone(input), updatedAt: new Date().toISOString() };
}

/** Adopt old projects' existing result before any edit or new generation. */
export function sceneHistory(job: GenerationJob, assets: readonly ProjectAsset[]) {
  if (job.generationHistory) return job.generationHistory;
  if (!job.outputRelativePath) return { versions: [], primaryId: null, selectedId: null, draft: sceneInput(job) };
  const media = assets.find(a => a.id === generationAssetId(job.id) || a.kind === "generated" && a.relativePath === job.outputRelativePath);
  const version: SceneGenerationVersion = { id: `legacy-${job.id}`, createdAt: job.updatedAt, scene: sceneInput(job),
    media: { ...media, id: generationAssetId(job.id), name: job.title, kind: "generated", mimeType: "video/mp4", sourcePath: null, relativePath: job.outputRelativePath, createdAt: media?.createdAt ?? job.createdAt },
    generationSnapshot: job.generationSnapshot, latentRelativePath: job.latentRelativePath };
  return { versions: [version], primaryId: version.id, selectedId: version.id, draft: null };
}

/** Also called by sessions, so agent edits and edits during rendering create a
 * draft just like inspector changes. Merely browsing a take is not an edit. */
export function saveSceneDrafts(config: ProjectConfig, previous?: ProjectConfig): ProjectConfig {
  let changed = false;
  const generationJobs = config.generationJobs.map(job => {
    const before = previous?.generationJobs.find(j => j.id === job.id);
    let history = job.generationHistory;
    if (!history && (job.outputRelativePath || before?.outputRelativePath)) history = sceneHistory(before ?? job, previous?.assets ?? config.assets);
    if (!history) return job;
    const input = sceneInput(job);
    const selectedId = history.selectedId;
    const selected = history.versions.find(v => v.id === selectedId);
    if (selected && !sameSceneInput(input, selected.scene)) history = { ...history, selectedId: null, draft: input };
    else if (!selected) {
      const matching = history.versions.find(v => sameSceneInput(input, v.scene));
      if (matching) history = { ...history, selectedId: matching.id, draft: null };
      else if (!history.draft || !sameSceneInput(input, history.draft)) history = { ...history, selectedId: null, draft: input };
    }
    if (history === job.generationHistory) return job;
    changed = true; return { ...job, generationHistory: history };
  });
  return changed ? { ...config, generationJobs } : config;
}

export function selectSceneGeneration(config: ProjectConfig, sceneId: string, versionId: string | null): ProjectConfig {
  const saved = saveSceneDrafts(config);
  return { ...saved, generationJobs: saved.generationJobs.map(job => {
    if (job.id !== sceneId || ["queued", "generating", "ready"].includes(job.status)) return job;
    const history = sceneHistory(job, saved.assets);
    const input = versionId ? history.versions.find(v => v.id === versionId)?.scene : history.draft;
    if (!input) return job;
    return { ...applyInput(job, input), generationHistory: { ...history, selectedId: versionId } };
  }) };
}

/** Browsing changes the board's preview, never the primary output used by
 * timeline clips, continuations and generation references. */
export function scenePreviewJob(job: GenerationJob, assets: readonly ProjectAsset[]): GenerationJob {
  if (["queued", "generating", "ready"].includes(job.status)) return job;
  const history = sceneHistory(job, assets);
  const selected = history.versions.find(v => v.id === history.selectedId);
  if (selected) return { ...job, status: "completed", outputRelativePath: selected.media.relativePath, latentRelativePath: selected.latentRelativePath };
  return job;
}
export function scenePreviewAsset(job: GenerationJob, assets: readonly ProjectAsset[]) {
  const history = sceneHistory(job, assets);
  return history.versions.find(v => v.id === history.selectedId)?.media ?? assets.find(a => a.id === generationAssetId(job.id));
}

export function makeSceneGenerationPrimary(config: ProjectConfig, sceneId: string, versionId: string): ProjectConfig {
  const job = config.generationJobs.find(j => j.id === sceneId);
  if (!job || ["queued", "generating", "ready"].includes(job.status)) return config;
  const history = sceneHistory(job, config.assets), version = history.versions.find(v => v.id === versionId);
  if (!version) return config;
  const assetId = generationAssetId(sceneId);
  const media = { ...structuredClone(version.media), id: assetId };
  return { ...config,
    generationJobs: config.generationJobs.map(j => j.id !== sceneId ? j : { ...j, generationHistory: { ...history, primaryId: versionId },
      outputRelativePath: media.relativePath, latentRelativePath: version.latentRelativePath, generationSnapshot: version.generationSnapshot, status: "completed", stage: "completed", progress: 1, error: null }),
    assets: [...config.assets.map(a => a.id === assetId || a.kind === "generated" && a.relativePath === job.outputRelativePath
      ? { ...media, id: a.id, name: a.name } : a), ...(config.assets.some(a => a.id === assetId) ? [] : [media])],
  };
}

/** Remove history metadata, keeping media files available to Undo and references. */
export function removeSceneGeneration(config: ProjectConfig, sceneId: string, versionId: string): ProjectConfig {
  const current = config.generationJobs.find(job => job.id === sceneId);
  if (!current || ["queued", "generating", "ready"].includes(current.status)
    || !sceneHistory(current, config.assets).versions.some(version => version.id === versionId)) return config;
  const saved = saveSceneDrafts(config);
  const job = saved.generationJobs.find(job => job.id === sceneId)!;
  const history = sceneHistory(job, saved.assets);
  const versions = history.versions.filter(version => version.id !== versionId);
  const primaryId = history.primaryId === versionId ? versions.at(-1)?.id ?? null : history.primaryId;
  const selectedId = history.selectedId === versionId ? primaryId : history.selectedId;
  const draft = versions.length ? history.draft : history.draft ?? sceneInput(job);
  const input = versions.length ? versions.find(version => version.id === selectedId)?.scene ?? draft : draft;
  const nextJob = { ...(input ? applyInput(job, input) : job), generationHistory: { ...history, versions, primaryId, selectedId, draft } };
  const next = { ...saved, generationJobs: saved.generationJobs.map(item => item.id === sceneId ? nextJob : item) };
  if (versions.length) return history.primaryId === versionId && primaryId ? makeSceneGenerationPrimary(next, sceneId, primaryId) : next;

  // Keep timeline placements as draft placeholders so a new generation can
  // fill them again, without retaining a preview of the removed last take.
  const assetIds = new Set(saved.assets.filter(asset => asset.id === generationAssetId(sceneId)
    || asset.kind === "generated" && job.outputRelativePath && asset.relativePath === job.outputRelativePath).map(asset => asset.id));
  return { ...next,
    generationJobs: next.generationJobs.map(item => item.id !== sceneId ? item : { ...item, status: "draft", stage: "queued", progress: 0,
      outputRelativePath: null, latentRelativePath: null, generationSnapshot: null, error: null }),
    assets: next.assets.map(asset => assetIds.has(asset.id) ? { ...asset, relativePath: null, sourcePath: null, sceneSegments: undefined, hasAudio: false,
      durationMs: Math.round((nextJob.durationSeconds ?? 5) * 1000) } : asset),
    timeline: { ...next.timeline, tracks: next.timeline.tracks.map(track => ({ ...track,
      clips: track.clips.map(clip => assetIds.has(clip.assetId) ? { ...clip, status: "draft" } : clip) })) },
  };
}

/** Replay-safe background result: keep live edits and never duplicate a take
 * when an undo replays this callback. Completed takes become primary. */
export function completeSceneGeneration(config: ProjectConfig, sceneId: string, version: SceneGenerationVersion, note?: string | null): ProjectConfig {
  const saved = saveSceneDrafts(config);
  const job = saved.generationJobs.find(j => j.id === sceneId);
  if (!job) return saved;
  const history = sceneHistory(job, saved.assets);
  const matching = sameSceneInput(sceneInput(job), version.scene);
  const draft = matching ? (history.draft && !sameSceneInput(history.draft, version.scene) ? history.draft : null) : sceneInput(job);
  const versions = [...history.versions.filter(v => v.id !== version.id), structuredClone(version)].slice(-SCENE_GENERATION_HISTORY_LIMIT);
  const next = { ...saved, generationJobs: saved.generationJobs.map(j => j.id === sceneId ? { ...j, status: "completed" as const,
    generationHistory: { versions, primaryId: version.id, selectedId: matching ? version.id : null, draft } } : j) };
  const primary = makeSceneGenerationPrimary(next, sceneId, version.id);
  return { ...primary, generationJobs: primary.generationJobs.map(j => j.id === sceneId ? { ...j, error: note } : j),
    timeline: { ...primary.timeline, tracks: primary.timeline.tracks.map(track => ({ ...track, clips: track.clips.map(clip => clip.assetId === generationAssetId(sceneId) ? { ...clip, status: "generated" as const } : clip) })) } };
}

export function duplicateScene(config: ProjectConfig, sceneId: string): { config: ProjectConfig; id: string } | null {
  const source = config.generationJobs.find(j => j.id === sceneId); if (!source) return null;
  const id = `job-${crypto.randomUUID()}`;
  const base = createDraftGenerationJob("", { id, title: `${source.title} copy` });
  const job = applyInput(base, { ...sceneInput(source), title: `${source.title} copy`,
    shots: sceneShots(source).map(shot => ({ ...structuredClone(shot), id: `shot-${crypto.randomUUID()}` })) });
  const index = config.generationJobs.indexOf(source);
  return { id, config: { ...config, generationJobs: [...config.generationJobs.slice(0, index + 1), job, ...config.generationJobs.slice(index + 1)] } };
}
