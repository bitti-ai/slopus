import { createImageEditScene, createImageScene, imageSourceSchema, type ImageNode, type ImageSource } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import type { ProjectConfig, ProjectReference } from "./project";

export interface ImageEditStep {
  prompt: string; x: number; y: number; width: number; height: number;
  feather?: number;
  referencePaths?: string[];
  refmods?: Array<{ path: string; strength: number; copies: number }>;
}
export const imageEditDebugPrompt = (edits: ImageEditStep[]) => edits.map((edit, index) => `Edit ${index + 1} (${edit.x}, ${edit.y}, ${edit.width}, ${edit.height})\n${edit.prompt}`).join("\n\n");
export function compileImageEdits(config: ProjectConfig): { source: ImageSource; edits: (ImageEditStep & { references: ProjectReference[] })[] } {
  const scene = config.imageScene!;
  const source = scene.sourceImage;
  if (!source) throw new Error("Open an image before adding edits.");
  const root = scene.nodes.find((node) => node.kind === "root")!;
  // The root describes a whole-image edit, followed by the local edits in order.
  const ordered: ImageNode[] = root.description.trim() ? [{ ...root, box: { x: 0, y: 0, width: 1000, height: 1000 } }] : [];
  const visit = (parent: string) => { for (const node of scene.nodes.filter((item) => item.parentId === parent)) { ordered.push(node); visit(node.id); } };
  visit(root.id);
  const edits = ordered.filter((node) => node.kind !== "group" || node.description.trim() || node.text).map((node) => {
    if (!node.box) throw new Error(`Set a placement box for '${node.name}'.`);
    if (!node.description.trim() && !node.text) throw new Error(`Describe the edit for '${node.name}'.`);
    const x = Math.min(source.width - 1, Math.floor(node.box.x * source.width / 1000));
    const y = Math.min(source.height - 1, Math.floor(node.box.y * source.height / 1000));
    const right = Math.min(source.width, Math.ceil((node.box.x + node.box.width) * source.width / 1000));
    const bottom = Math.min(source.height, Math.ceil((node.box.y + node.box.height) * source.height / 1000));
    const description = ["The edited keyframe corresponds to <Picture 1> with the following change. Preserve the composition and any previously completed edits.", node.description,
      node.text ? `Render the exact text "${node.text}".` : ""].filter(Boolean).join(" ");
    const editScene = { ...createImageScene(description), rootType: "image" as const, sourceImage: source, referenceIds: [] };
    const compiled = compileImagePrompt({ ...config, settings: { ...config.settings, defaultLook: null }, imageScene: editScene });
    return { prompt: compiled.prompt, references: compiled.references, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  });
  if (!edits.length) throw new Error("Enter a whole-image edit prompt or add an Edit node before generating.");
  return { source, edits };
}

export function editGeneratedImage(config: ProjectConfig, id: string): ProjectConfig {
  const asset = config.assets.find((item) => item.id === id && item.kind === "image");
  if (!asset?.relativePath || !asset.width || !asset.height) throw new Error("The image must have a saved file and dimensions before editing.");
  const source = imageSourceSchema.parse({ relativePath: asset.relativePath, name: asset.name, width: asset.width, height: asset.height });
  return { ...config, imageScene: createImageEditScene(source, config.imageScene ?? undefined) };
}
