import { z } from "zod";
import { createImageScene } from "./imageScene";
import { imageGenerationSnapshot, restoreGeneratedImage, saveImageDraft } from "./imageHistory";
import { imageSettings } from "./imageSettings";
import { actionReferenceIds, type ProjectConfig } from "./project";

const id = z.string().min(1).refine((value) => value.trim().length > 0);
export const imageDraftCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("image.draft.add"), id, name: id, prompt: z.string(), resolution: z.string().optional(), aspectRatio: z.string().optional() }).strict(),
  z.object({ op: z.literal("image.draft.select"), id }).strict(),
]);
export type ImageDraftCommand = z.infer<typeof imageDraftCommandSchema>;

export function applyImageDraftCommand(config: ProjectConfig, input: ImageDraftCommand, now: string): ProjectConfig {
  const command = imageDraftCommandSchema.parse(input);
  config = saveImageDraft(config);
  if (command.op === "image.draft.select") {
    const asset = config.assets.find((asset) => asset.id === command.id && asset.kind === "image" && asset.imageDraft && asset.imageGeneration && !asset.imageGeneration.template);
    if (!asset) throw new Error(`Editable image draft '${command.id}' was not found.`);
    return restoreGeneratedImage(config, asset.id);
  }
  if (config.assets.some((asset) => asset.id === command.id)) throw new Error(`Asset '${command.id}' already exists.`);
  for (const reference of actionReferenceIds(command.prompt)) {
    if (!config.references.some((item) => item.id === reference && ["image", "text"].includes(item.kind))) throw new Error(`Image reference '${reference}' must name an existing image or text reference.`);
  }
  const settings = imageSettings(config);
  const next = { ...config, imageScene: { ...createImageScene(command.prompt), outputAssetId: command.id },
    imageSettings: { ...settings, resolution: (command.resolution ?? settings.resolution) as typeof settings.resolution,
      aspectRatio: (command.aspectRatio ?? settings.aspectRatio) as typeof settings.aspectRatio } };
  return { ...next, assets: [...next.assets, { id: command.id, name: command.name, kind: "image", mimeType: "image/jpeg", imageDraft: true,
    createdAt: now, imageGeneration: imageGenerationSnapshot(next, "", "image-draft") }] };
}
