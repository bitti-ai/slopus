import { createImageEditScene, createImageScene } from "./imageScene";
import type { ImageGenerationSnapshot, ProjectConfig } from "./project";

export function imageGenerationSnapshot(config: ProjectConfig, prompt: string, generatorTemplateId: string): ImageGenerationSnapshot {
  const scene = config.imageScene ?? createImageScene(config.brief.prompt);
  return structuredClone({
    scene: { ...scene, outputAssetId: null },
    resolution: config.settings.resolution,
    aspectRatio: config.settings.aspectRatio,
    defaultLook: config.settings.defaultLook ?? null,
    briefPrompt: config.brief.prompt,
    prompt,
    generatorTemplateId,
    references: scene.referenceIds.map((id) => config.references.find((reference) => reference.id === id)!),
  });
}

/** Restore authored inputs without replacing other results or unrelated references. */
export function restoreGeneratedImage(config: ProjectConfig, id: string): ProjectConfig {
  const asset = config.assets.find((candidate) => candidate.id === id && candidate.kind === "image");
  if (!asset) return config;
  const snapshot = asset.imageGeneration;
  if (!snapshot) return { ...config, thumbnail: asset.relativePath ?? null,
    imageScene: { ...(config.imageScene?.rootType === "image" ? createImageScene() : config.imageScene ?? createImageScene(config.brief.prompt)), outputAssetId: id } };
  const restored = structuredClone(snapshot);
  const scene = restored.scene.rootType === "image" && asset.relativePath && asset.width && asset.height
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
