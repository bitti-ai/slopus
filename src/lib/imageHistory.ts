import { createImageEditScene, createImageScene, imageSceneReferenceIds, imageScenePromptText, imageSourceSchema } from "./imageScene";
import { actionReferenceIds, type ImageGenerationSnapshot, type ProjectAsset, type ProjectConfig } from "./project";
import { imageSettings } from "./imageSettings";

export function imageGenerationSnapshot(config: ProjectConfig, prompt: string, generatorTemplateId: string): ImageGenerationSnapshot {
  const scene = config.imageScene ?? createImageScene(config.brief.prompt);
  const cited = actionReferenceIds(imageScenePromptText(scene));
  return structuredClone({
    scene: { ...scene, outputAssetId: null },
    ...imageSettings(config),
    defaultLook: imageSettings(config).defaultLook ?? null,
    briefPrompt: config.brief.prompt,
    prompt,
    generatorTemplateId,
    // What the prompt cites, plus any ids a scene saved before citations were
    // how references are chosen (the snapshot schema still checks them).
    references: config.references.filter((reference) => imageSceneReferenceIds(scene).includes(reference.id) || cited.includes(reference.id)),
  });
}

/** The primary image of `id`'s family: its parent, or itself when it is the
 *  primary (or its parent has since been removed). */
export function imageFamilyRoot(assets: readonly ProjectAsset[], id: string | null | undefined): string | undefined {
  const asset = assets.find((candidate) => candidate.id === id && candidate.kind === "image");
  if (!asset) return undefined;
  return asset.parentAssetId && assets.some((candidate) => candidate.id === asset.parentAssetId && candidate.kind === "image") ? asset.parentAssetId : asset.id;
}

/** An image's family in the bar's order: the primary, then its other versions.
 *  An image with no family is a family of one. */
export function imageFamily(assets: readonly ProjectAsset[], id: string | null | undefined): ProjectAsset[] {
  const root = imageFamilyRoot(assets, id);
  if (!root) return [];
  return [assets.find((asset) => asset.id === root)!, ...assets.filter((asset) => asset.id !== root && imageFamilyRoot(assets, asset.id) === root)];
}

/** Promote a version without moving its family in the main bar or changing
 *  any image's contents. All other versions point directly to the new primary. */
export function makeImagePrimary(assets: ProjectAsset[], id: string): ProjectAsset[] {
  const primary = assets.find((asset) => asset.id === id && asset.kind === "image");
  const root = imageFamilyRoot(assets, id);
  if (!primary || !root || root === id || (!primary.relativePath && !primary.sourcePath)) return assets;
  const family = new Set(imageFamily(assets, id).map((asset) => asset.id));
  return assets.flatMap((asset) => asset.id === root
    ? [{ ...primary, parentAssetId: undefined }, { ...asset, parentAssetId: id }]
    : asset.id === id ? []
    : family.has(asset.id) ? [{ ...asset, parentAssetId: id }] : [asset]);
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
  if (!scene) return config;
  const selected = config.assets.find((asset) => asset.id === scene.outputAssetId);
  // Template entries record a submitted job. Selecting one must not replace its
  // recipe with the editor's generic image settings. Edits become another draft.
  const templateDraft = selected?.imageDraft && selected.imageGeneration?.template;
  if (templateDraft && JSON.stringify({ ...scene, outputAssetId: null }) === JSON.stringify(selected.imageGeneration!.scene)) return config;
  const source = scene.rootType === "image" ? scene.sourceImage : null;
  if (!source && !selected?.imageDraft) return config;
  if (!selected?.imageDraft && scene.outputAssetId && scene.nodes.length === 1 && !scene.nodes[0].description.trim()) return config;
  const existing = selected?.imageDraft && !templateDraft ? selected : undefined;
  const id = existing?.id ?? `image-draft-${crypto.randomUUID()}`;
  const edited = source && config.assets.find((asset) => asset.kind === "image" && !asset.imageDraft && asset.relativePath === source.relativePath);
  const parentAssetId = existing ? existing.parentAssetId : imageFamilyRoot(config.assets, templateDraft ? selected.id : edited?.id);
  const snapshot = imageGenerationSnapshot(config, "", generatorTemplateId || existing?.imageGeneration?.generatorTemplateId || selected?.imageGeneration?.generatorTemplateId || "image-draft");
  if (existing && JSON.stringify(existing.imageGeneration) === JSON.stringify(snapshot)) return config;
  const asset = { id, kind: "image" as const, ...source, name: existing?.name ?? (source ? `Editing ${source.name}` : "New image"),
    imageDraft: true, mimeType: /\.png$/i.test(source?.relativePath ?? "") ? "image/png" : "image/jpeg",
    imageGeneration: snapshot, ...(parentAssetId ? { parentAssetId } : {}), createdAt: existing?.createdAt ?? new Date().toISOString() };
  return { ...config, imageScene: { ...scene, outputAssetId: id }, assets: existing ? config.assets.map((item) => item.id === id ? asset : item) : [...config.assets, asset] };
}

export function createEmptyImage(config: ProjectConfig, generatorTemplateId?: string, familyAssetId?: string | null): ProjectConfig {
  config = saveImageDraft(config);
  const parentAssetId = imageFamilyRoot(config.assets, familyAssetId);
  const id = `image-draft-${crypto.randomUUID()}`;
  const scene = { ...createImageScene(), steps: config.imageScene?.steps ?? 20, outputAssetId: id };
  const next = { ...config, imageScene: scene };
  const asset: ProjectAsset = { id, kind: "image", name: "New image", mimeType: "image/jpeg", imageDraft: true,
    ...(parentAssetId ? { parentAssetId } : {}),
    imageGeneration: imageGenerationSnapshot(next, "", generatorTemplateId || "image-draft"), createdAt: new Date().toISOString() };
  return { ...next, assets: [...config.assets, asset] };
}

/** Publish the selectable entry before a template job starts using the engine. */
export function createTemplateImageDraft(config: ProjectConfig, id: string, name: string, generation: ImageGenerationSnapshot, size: { width: number; height: number }): ProjectConfig {
  const parentAssetId = imageFamilyRoot(config.assets, generation.template!.sourceId);
  const asset: ProjectAsset = { id, kind: "image", name, mimeType: "image/png", ...size, imageDraft: true,
    parentAssetId, imageGeneration: structuredClone(generation), createdAt: new Date().toISOString() };
  return restoreGeneratedImage({ ...config, assets: [...config.assets, asset] }, id);
}

export function completeImageDraft(config: ProjectConfig, id: string, result: ProjectAsset): ProjectConfig {
  const draft = config.assets.find((asset) => asset.id === id && asset.imageDraft);
  const selected = config.imageScene?.outputAssetId === id;
  const changed = draft && !draft.imageGeneration?.template && JSON.stringify({ ...draft.imageGeneration, prompt: "", usedSeed: undefined }) !== JSON.stringify({ ...result.imageGeneration, prompt: "", usedSeed: undefined });
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
  const source = !snapshot && imageSourceSchema.safeParse(asset);
  if (source && source.success) {
    return { ...config, thumbnail: asset.relativePath ?? null,
      imageScene: { ...createImageEditScene(source.data, config.imageScene ?? undefined), outputAssetId: id } };
  }
  if (!snapshot) return { ...config, thumbnail: asset.relativePath ?? null,
    imageScene: { ...(config.imageScene?.rootType === "image" ? createImageScene() : config.imageScene ?? createImageScene(config.brief.prompt)), outputAssetId: id } };
  const restored = structuredClone(snapshot);
  const scene = !asset.imageDraft && restored.scene.rootType === "image" && asset.relativePath && asset.width && asset.height
    ? createImageEditScene({ relativePath: asset.relativePath, name: asset.name, width: asset.width, height: asset.height }, restored.scene)
    : restored.scene;
  const references = new Map(restored.references.map((reference) => [reference.id, reference]));
  return { ...config, thumbnail: asset.relativePath ?? null,
    imageScene: { ...scene, outputAssetId: id },
    imageSettings: { resolution: restored.resolution, aspectRatio: restored.aspectRatio, defaultLook: restored.defaultLook },
    brief: { ...config.brief, prompt: restored.briefPrompt },
    references: [...config.references.map((reference) => references.get(reference.id) ?? reference),
      ...restored.references.filter((reference) => !config.references.some((current) => current.id === reference.id))],
  };
}
