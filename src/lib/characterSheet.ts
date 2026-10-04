import { createImageScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import { outputDimensions } from "./export";
import type { ProjectAsset, ProjectConfig, ProjectReference } from "./project";

export const CHARACTER_SHEET_VIEWS = [
  { label: "Upper body front", description: "A frontal upper-body shot framed from the waist up, looking straight at the camera. Include the entire head, both shoulders, arms and torso down to the waist, clearly showing the upper-body clothing. Do not crop tightly around the face or shoulders." },
  { label: "Full body front", description: "A full body front view, facing directly toward the camera, standing in a neutral pose. Show the entire figure from head to feet without cropping." },
  { label: "Full body side", description: "A full body side view, in strict left-facing profile, standing in a neutral pose. The head, shoulders, torso, hips and feet all face left, perpendicular to the camera. Show only the profile, with no turn toward the camera or three-quarter angle. Show the entire figure from head to feet without cropping." },
  { label: "Full body back", description: "A full body back view, facing directly away from the camera, standing in a neutral pose. The camera is directly behind the character: show the back of the head, back of the shoulders and outfit, and the heels. The head, torso, hips and feet all face away together. The face, eyes and front of the chest are hidden. No head turn, over-the-shoulder look, profile or three-quarter angle. Show the entire figure from head to feet without cropping." },
] as const;

// Establish the complete outfit before asking for any other camera angle.
export const CHARACTER_SHEET_ORDER = [1, 0, 2, 3] as const;

export const CHARACTER_SHEET_HEIGHTS = [512, 1024, 1536, 2048] as const;
export interface CharacterSheetOptions { prompt: string; height?: number; steps?: number; seed?: number }
export const emptyCharacterSheetOptions = (): CharacterSheetOptions => ({ prompt: "" });

export function characterSheetDimensions(resolution: ProjectConfig["settings"]["resolution"], requestedHeight?: number) {
  // A shared height divisible by 512 makes both 1:1 and 9:16 exact on H3's
  // 32px grid, and keeps the combined image below the editor's 8192px limit.
  if (requestedHeight !== undefined && !CHARACTER_SHEET_HEIGHTS.some((height) => height === requestedHeight)) throw new Error("Choose a supported character sheet height.");
  const height = requestedHeight ?? Math.max(512, Math.min(2048, Math.round(outputDimensions(resolution, "1:1").height / 512) * 512));
  return CHARACTER_SHEET_VIEWS.map((_, index) => ({ width: index === 0 ? height : height * 9 / 16, height }));
}

export function compileCharacterSheet(config: ProjectConfig, source: ProjectAsset, frontRelativePath: string, options: CharacterSheetOptions = emptyCharacterSheetOptions()) {
  if (options.steps !== undefined && (!Number.isInteger(options.steps) || options.steps < 2 || options.steps > 1000)) throw new Error("Steps must be a whole number from 2 to 1000.");
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < -1)) throw new Error("Seed must be -1 for random or a whole number from 0 to 9007199254740991.");
  let sourceReferenceId = "character-sheet-source";
  while (config.references.some((reference) => reference.id === sourceReferenceId)) sourceReferenceId += "-source";
  const reference: ProjectReference = {
    id: sourceReferenceId, kind: "text", name: source.name,
    description: "The character in the source image. Preserve the exact identity, body proportions, skin tone, hairstyle and hair color. Preserve clothing, footwear, accessories, materials and colors unless the template instructions explicitly change them. Preserve the source's visual medium and rendering style. The reference pose, gaze, camera angle and framing are not to be copied; use the required output view.",
    intendedUse: ["character"], createdAt: source.createdAt,
    images: [{ id: "character-sheet-source-image", name: source.name, relativePath: source.relativePath, sourcePath: source.sourcePath }],
  };
  return CHARACTER_SHEET_VIEWS.map((view, index) => {
    const wardrobe = index === 1
      ? "Apply the template's clothing instructions and references to establish the outfit. Where no change is requested, copy visible garments from <Picture 1> exactly. For clothing outside its crop, complete one coherent outfit for this character; this full body front view will define the outfit for all other views."
      : "<Picture 1> is the original identity reference. <Picture 2> is the full body front view of this same character and the fixed wardrobe reference. Use it for outfit design only, not its pose, gaze or camera angle. Reproduce that exact outfit from the requested camera angle. Keep identical garment types, layers, cuts, lengths, fit, seams, closures, patterns, colors, fabric, footwear, jewelry and accessories. Do not add, remove, replace, restyle or recolor any clothing. Preserve anatomical left/right placement of asymmetric details when turning the character. Infer hidden surfaces consistently with the same garments; details on the front stay on the front and need not be visible from other angles." + (index === 0 ? " Use frontal waist-up framing while retaining the exact visible upper-body clothing." : index === 2 ? " Rotate the character into the required strict left-facing profile." : " Rotate the character 180 degrees from the wardrobe reference into the required straight rear view. Show the back of the outfit, without moving front closures or front graphics onto its back.");
    const orientation = `Required output view (takes precedence over reference poses and template pose or framing instructions): ${view.description}`;
    const selectedReference = { ...reference,
      description: `${reference.description} ${index === 3 ? "Identity must remain recognizable from the rear silhouette, hair and outfit; facial features are out of view." : "Retain the same facial features wherever visible from the required angle."} ${orientation}`,
      images: index === 1 ? reference.images : [...reference.images!, { id: "character-sheet-front", name: "Full body front wardrobe reference", relativePath: frontRelativePath }],
    };
    const instructions = options.prompt.trim() ? `Template instructions: ${options.prompt.trim()}` : "";
    const scene = createImageScene(`Create a character reference view of @[ref:${reference.id}]. ${view.description} ${wardrobe} Preserve the character's identity. Use a plain light gray background and soft even studio lighting unless the template instructions specify otherwise. Render no text, labels, borders, additional characters or multiple views. Match the source image's visual style.\n${instructions}\n${orientation}`);
    scene.style = { mode: "art", medium: "the same visual medium and rendering style as <Picture 1>", aesthetics: "", lighting: "", detail: "" };
    return compileImagePrompt({
      ...config, settings: { ...config.settings, defaultLook: null }, references: [selectedReference, ...config.references],
      imageScene: scene,
    }, { referenceTransformations: { [reference.id]: `Retain identity, body proportions, hair, clothing and visual style, but replace the reference pose, gaze, camera angle and framing. ${orientation}` } });
  });
}
