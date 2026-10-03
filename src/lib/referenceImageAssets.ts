import { referenceImages, type ProjectAsset, type ProjectConfig, type ProjectReference, type ProjectReferenceImage, type StoredLocation } from "./project";

const locationKey = (image: StoredLocation) => image.sourcePath ? `external:${image.sourcePath}` : image.relativePath ? `project:${image.relativePath}` : null;
const pictures = (reference: ProjectReference): ProjectReferenceImage[] => [
  ...referenceImages({ ...reference, video: undefined }),
  ...(reference.video?.frames ?? []),
];

/** Register newly attached pictures once. Comparing against the previous references
 * keeps an image removed from the bar from returning on the next reference edit. */
export function addReferenceImageAssets(config: ProjectConfig, previous: readonly ProjectReference[] = []): ProjectConfig {
  if (config.references === previous) return config;
  const known = new Set([
    ...config.assets.filter((asset) => asset.kind === "image").map(locationKey),
    ...previous.flatMap(pictures).map(locationKey),
  ]);
  const added: ProjectAsset[] = [];
  for (const reference of config.references) {
    for (const image of pictures(reference)) {
      const key = locationKey(image);
      if (!key || known.has(key)) continue;
      known.add(key);
      const extension = (image.sourcePath ?? image.relativePath ?? "").split(".").pop()?.toLowerCase();
      const mimeType = extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : extension === "gif" ? "image/gif" : "image/jpeg";
      added.push({ id: `asset-${crypto.randomUUID()}`, kind: "image", name: image.name,
        relativePath: image.relativePath, sourcePath: image.sourcePath, mimeType, createdAt: new Date().toISOString() });
    }
  }
  return added.length ? { ...config, assets: [...config.assets, ...added] } : config;
}
