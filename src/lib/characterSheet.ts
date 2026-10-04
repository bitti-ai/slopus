import { createImageScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import { outputDimensions } from "./export";
import type { ProjectAsset, ProjectConfig, ProjectReference } from "./project";

export const CHARACTER_SHEET_VIEWS = [
  { label: "Frontal portrait", description: "A frontal close-up portrait, showing the head and shoulders, looking straight at the camera." },
  { label: "Full body front", description: "A full body front view, facing directly toward the camera, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
  { label: "Full body side", description: "A full body side view, in strict left-facing profile, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
  { label: "Full body back", description: "A full body back view, facing directly away from the camera, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
] as const;

// Establish the complete outfit before asking for any other camera angle.
export const CHARACTER_SHEET_ORDER = [1, 0, 2, 3] as const;

export function characterSheetDimensions(resolution: ProjectConfig["settings"]["resolution"]) {
  // A shared height divisible by 512 makes both 1:1 and 9:16 exact on H3's
  // 32px grid, and keeps the combined image below the editor's 8192px limit.
  const height = Math.max(512, Math.min(2048, Math.round(outputDimensions(resolution, "1:1").height / 512) * 512));
  return CHARACTER_SHEET_VIEWS.map((_, index) => ({ width: index === 0 ? height : height * 9 / 16, height }));
}

export function characterSheetPrompts(config: ProjectConfig, source: ProjectAsset, frontRelativePath: string): string[] {
  const reference: ProjectReference = {
    id: "character-sheet-source", kind: "text", name: source.name,
    description: "The character in the source image. Preserve the exact identity, facial features, body proportions, skin tone, hairstyle and hair color, clothing, footwear, accessories, materials and colors. Preserve the source's visual medium and rendering style. Do not redesign or change the outfit.",
    intendedUse: ["character"], createdAt: source.createdAt,
    images: [{ id: "character-sheet-source-image", name: source.name, relativePath: source.relativePath, sourcePath: source.sourcePath }],
  };
  return CHARACTER_SHEET_VIEWS.map((view, index) => {
    const wardrobe = index === 1
      ? "Copy every visible garment from <Picture 1> exactly. For clothing outside its crop, complete one coherent outfit for this character; this full body front view will define the outfit for all other views."
      : "<Picture 1> is the original identity reference. <Picture 2> is the full body front view of this same character and the fixed wardrobe reference. Reproduce that exact outfit from the requested camera angle. Keep identical garment types, layers, cuts, lengths, fit, seams, closures, patterns, colors, fabric, footwear, jewelry and accessories. Do not add, remove, replace, restyle or recolor any clothing. Preserve anatomical left/right placement of asymmetric details when turning the character. Infer only hidden surfaces consistently with the same garments." + (index === 0 ? " Use frontal close-up framing while retaining the exact visible upper-body clothing." : " Change the camera angle from <Picture 2> to the requested side or back view.");
    const selectedReference = index === 1 ? reference : { ...reference, images: [...reference.images!, { id: "character-sheet-front", name: "Full body front wardrobe reference", relativePath: frontRelativePath }] };
    const scene = createImageScene(`Create a character reference view of @[ref:${reference.id}]. ${view.description} ${wardrobe} Keep the same clothing, appearance and every identifying detail from the source image. Use a plain light gray background, soft even studio lighting, and no text, labels, borders, additional characters or multiple views. Match the source image's visual style.`);
    scene.style = { mode: "art", medium: "the same visual medium and rendering style as <Picture 1>", aesthetics: "", lighting: "", detail: "" };
    return compileImagePrompt({
      ...config, settings: { ...config.settings, defaultLook: null }, references: [selectedReference],
      imageScene: scene,
    }).prompt;
  });
}
