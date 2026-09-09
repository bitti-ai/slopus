import { deriveH3Style, referenceImages, type ProjectReference } from "./project";
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
  const description = reference.description.trim();
  const visual = [
    `${deriveH3Style(description)}, square composition, recognizable at 256 by 256 pixels.`,
    COMPOSITIONS[referenceType(reference)],
    "The camera holds a static shot of a single still image.",
    "Follow the reference description's visual medium and details. No captions, lettering, watermarks, borders, or collage panels.",
    `Reference name: ${reference.name}`,
    reference.subcategory ? `Subcategory: ${reference.subcategory}` : "",
    `Reference description:\n${description}`,
  ].filter(Boolean).join("\n");
  // H3's base three-field format also applies to text-only still-image jobs.
  // Icons have no audio, so both audio fields explicitly use N/A.
  return [
    `integrated_multimodal_description: [Shot 1] ${visual}`,
    "overall_soundscape: N/A",
    "non_diegetic_music: N/A",
  ].join("\n\n");
}

export function needsReferenceIcon(reference: ProjectReference): boolean {
  return Boolean(reference.description.trim()) && !reference.iconRelativePath
    && referenceImages(reference).length === 0 && !selectedReferencePreset(reference)?.icon;
}
