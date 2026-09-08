import { referenceImages, type ProjectReference } from "./project";
import { referenceType, selectedReferencePreset } from "./reference-presets";

export const REFERENCE_ICON_SIZE = 256;
export const REFERENCE_ICON_RENDER_SIZE = 768;
export const REFERENCE_ICON_STEPS = 20;

const COMPOSITIONS = {
  character: "A clear head-and-shoulders character portrait. Emphasize recognizable facial features, hair, clothing, and personality against a simple background.",
  animal: "A clear portrait of the animal with its whole body visible. Emphasize species-accurate anatomy, distinctive markings, fur, feathers, or scales and a recognizable silhouette against a simple natural background.",
  product: "A clean hero view of the product. Show its complete silhouette, materials, colors, and defining details with controlled lighting and an uncluttered background.",
  location: "An establishing view of the location. Show its defining architecture or landscape, atmosphere, lighting, and spatial character in a readable composition.",
  style: "A representative scene demonstrating the visual style. Make its palette, medium, textures, lighting, and composition immediately recognizable.",
  custom: "A clear visual representation of the reference's defining subject, appearance, and atmosphere.",
};

export function referenceIconPrompt(reference: ProjectReference): string {
  return [
    "Create one square reference-library icon, composed to remain recognizable at 256 by 256 pixels.",
    COMPOSITIONS[referenceType(reference)],
    "Follow the reference description's visual medium and details. No captions, lettering, watermarks, borders, or collage panels.",
    `Reference name: ${reference.name}`,
    reference.subcategory ? `Subcategory: ${reference.subcategory}` : "",
    `Reference description:\n${reference.description.trim()}`,
  ].filter(Boolean).join("\n\n");
}

export function needsReferenceIcon(reference: ProjectReference): boolean {
  return Boolean(reference.description.trim()) && !reference.iconRelativePath
    && referenceImages(reference).length === 0 && !selectedReferencePreset(reference)?.icon;
}
