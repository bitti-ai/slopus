import { FIBO_MODEL_TYPE } from "./settings";
import { imageSettings } from "./imageSettings";
import { createImageEditScene, createImageScene, imageLassoContours, imageSourceSchema, type ImageNode, type ImageScene, type ImageSource, type ImagePoint } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import type { ProjectConfig, ProjectReference } from "./project";

export interface ImageEditStep {
  prompt: string; x: number; y: number; width: number; height: number;
  feather?: number;
  /** Pixel-space polygon, rasterized to a source-sized mask by the runtime. */
  maskPolygon?: ImagePoint[];
  maskContours?: ImagePoint[][];
  /** Denoising strength; lower values retain more of the source detail. */
  strength?: number;
  /** Preserve this box and generate its surround in a single outpainting pass. */
  invertMask?: boolean;
  /** Native outpainting: odd Gaussian mask kernel (1..51) and inner iterations (0..100). */
  outpaintBlendOverlap?: number;
  outpaintLangevinSteps?: number;
  referencePaths?: string[];
  refmods?: Array<{ path: string; strength: number; copies: number }>;
}
export const imageEditDebugPrompt = (edits: ImageEditStep[]) => edits.map((edit, index) => `Edit ${index + 1} (${edit.x}, ${edit.y}, ${edit.width}, ${edit.height})\n${edit.prompt}`).join("\n\n");
/** Imported images default to their own dimensions, rounded down to the model grid. */
export function imageEditSize(source: Pick<ImageSource, "width" | "height">, shortEdge = Math.min(source.width, source.height)) {
  const scale = shortEdge / Math.min(source.width, source.height);
  const align = (value: number) => Math.max(32, Math.floor(value / 32) * 32);
  return { width: align(source.width * scale), height: align(source.height * scale) };
}
export function imageEditOutputSize(scene: ImageScene) {
  return scene.outputSize ?? imageEditSize(scene.sourceImage!);
}
export function compileImageEdits(config: ProjectConfig, options: { modelType?: string } = {}): { source: ImageSource; edits: (ImageEditStep & { references: ProjectReference[] })[] } {
  const scene = config.imageScene!;
  const source = scene.sourceImage;
  if (!source) throw new Error("Open an image before adding edits.");
  const size = imageEditOutputSize(scene);
  const root = scene.nodes.find((node) => node.kind === "root")!;
  // The root describes a whole-image edit, followed by the local edits in order.
  const ordered: ImageNode[] = root.description.trim() ? [{ ...root, box: { x: 0, y: 0, width: 1000, height: 1000 } }] : [];
  const visit = (parent: string) => { for (const node of scene.nodes.filter((item) => item.parentId === parent)) { ordered.push(node); visit(node.id); } };
  visit(root.id);
  const edits = ordered.filter((node) => node.kind !== "group" || node.description.trim() || node.text).map((node) => {
    if (!node.box) throw new Error(`Set a placement box for '${node.name}'.`);
    if (!node.description.trim() && !node.text) throw new Error(`Describe the edit for '${node.name}'.`);
    const x = Math.min(size.width - 1, Math.floor(node.box.x * size.width / 1000));
    const y = Math.min(size.height - 1, Math.floor(node.box.y * size.height / 1000));
    const right = Math.min(size.width, Math.ceil((node.box.x + node.box.width) * size.width / 1000));
    const bottom = Math.min(size.height, Math.ceil((node.box.y + node.box.height) * size.height / 1000));
    const description = [options.modelType === FIBO_MODEL_TYPE ? "" : "The edited keyframe corresponds to <Picture 1> with the following change. Preserve the composition and any previously completed edits.", node.description,
      node.text ? `Render the exact text "${node.text}".` : ""].filter(Boolean).join(" ");
    const editScene = { ...createImageScene(description), rootType: "image" as const, sourceImage: source, referenceIds: [] };
    const compiled = compileImagePrompt({ ...config, imageSettings: { ...imageSettings(config), defaultLook: null }, imageScene: editScene }, options);
    // A full-canvas edit has no surrounding source to blend into at its edges.
    const wholeImage = x === 0 && y === 0 && right === size.width && bottom === size.height;
    const contours = imageLassoContours(node).map((points) => points.map(({ x, y }) => ({ x: x * size.width / 1000, y: y * size.height / 1000 })));
    return { prompt: compiled.prompt, references: compiled.references, x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y),
      ...(node.lasso ? { ...(contours.length > 1 ? { maskContours: contours } : { maskPolygon: contours[0] }), feather: 0 } : wholeImage ? { feather: 0 } : {}) };
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
