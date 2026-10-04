import { createImageScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import type { ProjectAsset, ProjectConfig, ProjectReference } from "./project";

export const CHARACTER_SHEET_VIEWS = [
  { label: "Frontal portrait", description: "A frontal close-up portrait, showing the head and shoulders, looking straight at the camera." },
  { label: "Full body front", description: "A full body front view, facing directly toward the camera, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
  { label: "Full body side", description: "A full body side view, in strict left-facing profile, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
  { label: "Full body back", description: "A full body back view, facing directly away from the camera, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
] as const;

export function characterSheetPrompts(config: ProjectConfig, source: ProjectAsset): string[] {
  const reference: ProjectReference = {
    id: "character-sheet-source", kind: "text", name: source.name,
    description: "The character in the source image. Preserve the exact identity, facial features, body proportions, skin tone, hairstyle and hair color, clothing, footwear, accessories, materials and colors. Preserve the source's visual medium and rendering style. Do not redesign or change the outfit.",
    intendedUse: ["character"], createdAt: source.createdAt,
    images: [{ id: "character-sheet-source-image", name: source.name, relativePath: source.relativePath, sourcePath: source.sourcePath }],
  };
  return CHARACTER_SHEET_VIEWS.map((view) => {
    const scene = createImageScene(`Create a character reference view of @[ref:${reference.id}]. ${view.description} Keep the same clothing, appearance and every identifying detail from the source image. Use a plain light gray background, soft even studio lighting, and no text, labels, borders, additional characters or multiple views. Match the source image's visual style.`);
    scene.style = { mode: "art", medium: "the same visual medium and rendering style as <Picture 1>", aesthetics: "", lighting: "", detail: "" };
    return compileImagePrompt({
      ...config, settings: { ...config.settings, defaultLook: null }, references: [reference],
      imageScene: scene,
    }).prompt;
  });
}
