import { createImageEditScene, createImageScene, imageSceneReferenceIds, imageScenePromptText } from "./imageScene";
import { actionReferenceIds, type ImageGenerationSnapshot, type ProjectAsset, type ProjectConfig } from "./project";

export function imageGenerationSnapshot(config: ProjectConfig, prompt: string, generatorTemplateId: string): ImageGenerationSnapshot {
  const scene = config.imageScene ?? createImageScene(config.brief.prompt);
  const cited = actionReferenceIds(imageScenePromptText(scene));
  return structuredClone({
    scene: { ...scene, outputAssetId: null },
    resolution: config.settings.resolution,
    aspectRatio: config.settings.aspectRatio,
    defaultLook: config.settings.defaultLook ?? null,
    briefPrompt: config.brief.prompt,
    prompt,
    generatorTemplateId,
    // What the prompt cites, plus any ids a scene saved before citations were
    // how references are chosen (the snapshot schema still checks them).
    references: config.references.filter((reference) => imageSceneReferenceIds(scene).includes(reference.id) || cited.includes(reference.id)),
  });
}

/** The first image of `id`'s family: its parent, or itself when it is an
 *  original (or its parent has since been removed). */
export function imageFamilyRoot(assets: readonly ProjectAsset[], id: string | null | undefined): string | undefined {
  const asset = assets.find((candidate) => candidate.id === id && candidate.kind === "image");
  if (!asset) return undefined;
  return asset.parentAssetId && assets.some((candidate) => candidate.id === asset.parentAssetId && candidate.kind === "image") ? asset.parentAssetId : asset.id;
}

/** An image's family in the bar's order: the original, then the images made
 *  from it. An image with no family is a family of one. */
export function imageFamily(assets: readonly ProjectAsset[], id: string | null | undefined): ProjectAsset[] {
  const root = imageFamilyRoot(assets, id);
  if (!root) return [];
  return [assets.find((asset) => asset.id === root)!, ...assets.filter((asset) => asset.id !== root && imageFamilyRoot(assets, asset.id) === root)];
}

/** Removes an image. Its children stay a family: the leftmost of them — the
 *  oldest — becomes the original the others belong to. */
export function removeImageAsset(assets: readonly ProjectAsset[], id: string): ProjectAsset[] {
  const children = assets.filter((asset) => asset.parentAssetId === id);
  const heir = children[0]?.id;
  return assets.filter((asset) => asset.id !== id).map((asset) => asset.parentAssetId !== id ? asset
    : asset.id === heir ? { ...asset, parentAssetId: undefined } : { ...asset, parentAssetId: heir });
}

/** Keep the editable version in history without creating another image file. */
export function saveImageDraft(config: ProjectConfig, generatorTemplateId?: string): ProjectConfig {
  const scene = config.imageScene;
  if (config.generationType !== "image" || !scene) return config;
  const selected = config.assets.find((asset) => asset.id === scene.outputAssetId);
  const source = scene.rootType === "image" ? scene.sourceImage : null;
  if (!source && !selected?.imageDraft) return config;
  if (!selected?.imageDraft && scene.outputAssetId && scene.nodes.length === 1 && !scene.nodes[0].description.trim()) return config;
  const existing = selected?.imageDraft ? selected : undefined;
  const id = existing?.id ?? `image-draft-${crypto.randomUUID()}`;
  const edited = source && config.assets.find((asset) => asset.kind === "image" && !asset.imageDraft && asset.relativePath === source.relativePath);
  const parentAssetId = existing ? existing.parentAssetId : imageFamilyRoot(config.assets, edited?.id);
  const snapshot = imageGenerationSnapshot(config, "", generatorTemplateId || existing?.imageGeneration?.generatorTemplateId || selected?.imageGeneration?.generatorTemplateId || "image-draft");
  if (existing && JSON.stringify(existing.imageGeneration) === JSON.stringify(snapshot)) return config;
  const asset = { id, kind: "image" as const, ...source, name: existing?.name ?? (source ? `Editing ${source.name}` : "New image"),
    imageDraft: true, mimeType: /\.png$/i.test(source?.relativePath ?? "") ? "image/png" : "image/jpeg",
    imageGeneration: snapshot, ...(parentAssetId ? { parentAssetId } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() };
  return { ...config, imageScene: { ...scene, outputAssetId: id }, assets: existing ? config.assets.map((item) => item.id === id ? asset : item) : [...config.assets, asset] };
}

export function createEmptyImage(config: ProjectConfig, generatorTemplateId?: string): ProjectConfig {
  config = saveImageDraft(config);
  const id = `image-draft-${crypto.randomUUID()}`;
  const scene = { ...createImageScene(), steps: config.imageScene?.steps ?? 20, outputAssetId: id };
  const next = { ...config, imageScene: scene };
  const asset: ProjectAsset = { id, kind: "image", name: "New image", mimeType: "image/jpeg", imageDraft: true,
    imageGeneration: imageGenerationSnapshot(next, "", generatorTemplateId || "image-draft"), createdAt: new Date().toISOString() };
  return { ...next, assets: [...config.assets, asset] };
}

export function completeImageDraft(config: ProjectConfig, id: string, result: ProjectAsset): ProjectConfig {
  const draft = config.assets.find((asset) => asset.id === id && asset.imageDraft);
  const selected = config.imageScene?.outputAssetId === id;
  const changed = draft && JSON.stringify({ ...draft.imageGeneration, prompt: "", usedSeed: undefined }) !== JSON.stringify({ ...result.imageGeneration, prompt: "", usedSeed: undefined });
  // Edits made during generation remain a separate draft on the original source.
  const pending = changed ? { ...draft, id: `image-draft-${crypto.randomUUID()}` } : null;
  const asset = { ...result, id, imageDraft: false, ...(draft?.parentAssetId ? { parentAssetId: draft.parentAssetId } : {}) };
  const assets = config.assets.some((item) => item.id === id) ? config.assets.map((item) => item.id === id ? asset : item) : [...config.assets, asset];
  const next = { ...config, assets: pending ? [...assets, pending] : assets };
  if (!selected) return next;
  if (pending) return { ...next, imageScene: { ...config.imageScene!, outputAssetId: pending.id } };
  return restoreGeneratedImage(next, id);
}

/** Restore authored inputs without replacing other results or unrelated references. */
export function restoreGeneratedImage(config: ProjectConfig, id: string): ProjectConfig {
  const asset = config.assets.find((candidate) => candidate.id === id && candidate.kind === "image");
  if (!asset) return config;
  const snapshot = asset.imageGeneration;
  if (!snapshot) return { ...config, thumbnail: asset.relativePath ?? null,
    imageScene: { ...(config.imageScene?.rootType === "image" ? createImageScene() : config.imageScene ?? createImageScene(config.brief.prompt)), outputAssetId: id } };
  const restored = structuredClone(snapshot);
  const scene = !asset.imageDraft && restored.scene.rootType === "image" && asset.relativePath && asset.width && asset.height
    ? createImageEditScene({ relativePath: asset.relativePath, name: asset.name, width: asset.width, height: asset.height }, restored.scene)
    : restored.scene;
  const references = new Map(restored.references.map((reference) => [reference.id, reference]));
  return { ...config, thumbnail: asset.relativePath ?? null,
    imageScene: { ...scene, outputAssetId: id },
    settings: { ...config.settings, resolution: restored.resolution, aspectRatio: restored.aspectRatio, defaultLook: restored.defaultLook },
    brief: { ...config.brief, prompt: restored.briefPrompt, resolution: restored.resolution, aspectRatio: restored.aspectRatio },
    references: [...config.references.map((reference) => references.get(reference.id) ?? reference),
      ...restored.references.filter((reference) => !config.references.some((current) => current.id === reference.id))],
  };
}
