import { createImageScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import { outputDimensions } from "./export";
import { imageGenerationSizeError, imageResolutionScale } from "./imageSettings";
import type { ProjectAsset, ProjectConfig, ProjectReference } from "./project";

export const CHARACTER_SHEET_VIEWS = [
  { id: "closeUp", label: "Close up", description: "Waist-up front view, facing the camera, entire head visible." },
  { id: "front", label: "Front view", description: "Full body front view, facing the camera, neutral standing pose, head to feet visible." },
  { id: "side", label: "Side view", description: "Full body side view, head and body in left-facing profile, neutral standing pose, head to feet visible." },
  { id: "back", label: "Back view", description: "Full body back view, head and body facing away, face hidden, neutral standing pose, head to feet visible." },
] as const;

// Establish the complete outfit before asking for any other camera angle.
export const CHARACTER_SHEET_ORDER = [1, 0, 2, 3] as const;

export const CHARACTER_SHEET_HEIGHTS = [512, 1024, 1536, 2048] as const;
export type CharacterSheetViews = Record<typeof CHARACTER_SHEET_VIEWS[number]["id"], boolean>;
export interface CharacterSheetOptions { prompt: string; height?: number; steps?: number; seed?: number; views?: CharacterSheetViews }
export const characterSheetViews = (options?: CharacterSheetOptions): CharacterSheetViews => ({ closeUp: true, front: true, side: false, back: true, ...options?.views });
export const characterSheetViewIndices = (options?: CharacterSheetOptions) => CHARACTER_SHEET_VIEWS.flatMap((view, index) => characterSheetViews(options)[view.id] ? [index] : []);
export const emptyCharacterSheetOptions = (): CharacterSheetOptions => ({ prompt: "", views: characterSheetViews() });

/** Dimensions from a saved output height; never apply the model scale twice. */
export function characterSheetViewDimensions(height: number) {
  return CHARACTER_SHEET_VIEWS.map((_, index) => ({ width: index === 0 ? height : Math.round(height * 9 / 16 / 32) * 32, height }));
}

export function characterSheetDimensions(resolution: ProjectConfig["settings"]["resolution"], requestedHeight?: number, modelType?: string) {
  if (requestedHeight !== undefined && !CHARACTER_SHEET_HEIGHTS.some((height) => height === requestedHeight)) throw new Error("Choose a supported character sheet height.");
  const preset = requestedHeight ?? Math.max(512, Math.min(2048, Math.round(outputDimensions(resolution, "1:1").height / 512) * 512));
  const height = Math.floor(preset * imageResolutionScale(modelType) / 32) * 32;
  const dimensions = characterSheetViewDimensions(height);
  const error = dimensions.map((size) => imageGenerationSizeError(size, modelType)).find(Boolean);
  if (error) throw new Error(error);
  return dimensions;
}

export function compileCharacterSheet(config: ProjectConfig, source: ProjectAsset, frontRelativePath: string, options: CharacterSheetOptions = emptyCharacterSheetOptions(), modelType?: string) {
  const indices = characterSheetViewIndices(options);
  if (!indices.length) throw new Error("Enable at least one character sheet view.");
  if (options.steps !== undefined && (!Number.isInteger(options.steps) || options.steps < 2 || options.steps > 1000)) throw new Error("Steps must be a whole number from 2 to 1000.");
  if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed < -1)) throw new Error("Seed must be -1 for random or a whole number from 0 to 9007199254740991.");
  let sourceReferenceId = "character-sheet-source";
  while (config.references.some((reference) => reference.id === sourceReferenceId)) sourceReferenceId += "-source";
  const reference: ProjectReference = {
    id: sourceReferenceId, kind: "text", name: "the character",
    description: "Keep the same character and visual style.",
    intendedUse: ["character"], createdAt: source.createdAt,
    images: [{ id: "character-sheet-source-image", name: source.name, relativePath: source.relativePath, sourcePath: source.sourcePath }],
  };
  return Object.fromEntries(indices.map((index) => {
    const view = CHARACTER_SHEET_VIEWS[index];
    const useFront = index !== 1 && characterSheetViews(options).front;
    const wardrobe = !useFront
      ? "Keep the outfit from <Picture 1> unless the template instructions change it; complete any unseen clothing."
      : "Use <Picture 1> for identity and match the outfit in <Picture 2> from the requested angle.";
    const selectedReference = { ...reference,
      images: !useFront ? reference.images : [...reference.images!, { id: "character-sheet-front", name: "Full body front wardrobe reference", relativePath: frontRelativePath }],
    };
    const instructions = options.prompt.trim() ? `Template instructions: ${options.prompt.trim()}` : "";
    const scene = createImageScene(`One character reference view of @[ref:${reference.id}]. ${wardrobe} Plain light gray background, soft even lighting, no text.\n${instructions}\nRequired view: ${view.description}`);
    scene.style = { mode: "art", medium: "the same visual medium and rendering style as <Picture 1>", aesthetics: "", lighting: "", detail: "" };
    return [index, compileImagePrompt({
      ...config, settings: { ...config.settings, defaultLook: null }, references: [selectedReference, ...config.references],
      imageScene: scene,
    }, { modelType, referenceTransformations: { [reference.id]: "Keep the character's identity; use the requested outfit and view." } })] as const;
  }));
}
