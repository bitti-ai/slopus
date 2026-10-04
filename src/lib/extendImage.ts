import { createImageEditScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import { outputDimensions } from "./export";
import type { ProjectAsset, ProjectConfig } from "./project";

export const EXTEND_GRID = 32;
// Largest current generation preset (2048p landscape), also usable in portrait.
const MAX_GENERATION_SIZE = outputDimensions("2048p", "16:9");
export const EXTEND_MAX_EDGE = Math.max(MAX_GENERATION_SIZE.width, MAX_GENERATION_SIZE.height);
export const EXTEND_MAX_PIXELS = MAX_GENERATION_SIZE.width * MAX_GENERATION_SIZE.height;
/** Selection bounds in the Extend workspace; negative coordinates extend left/up. */
export interface ExtendBounds { x: number; y: number; width: number; height: number }
export interface ExtendOptions { bounds: ExtendBounds; prompt: string; steps: number; seed: number }
export function extendSourceDimensions(width: number, height: number) {
  // Reserve room to extend even when the source is already at the model limit.
  const scale = Math.min(1, EXTEND_MAX_EDGE / (width * 1.5), EXTEND_MAX_EDGE / (height * 1.5), Math.sqrt(EXTEND_MAX_PIXELS / (width * height)) / 1.5);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export function alignExtendBounds(bounds: ExtendBounds, mode = "se"): ExtendBounds {
  const dimension = (size: number) => Math.max(EXTEND_GRID, Math.min(EXTEND_MAX_EDGE, Math.round(size / EXTEND_GRID) * EXTEND_GRID));
  let width = dimension(bounds.width), height = dimension(bounds.height);
  if (width * height > EXTEND_MAX_PIXELS) {
    if (mode === "e" || mode === "w") width = Math.floor(EXTEND_MAX_PIXELS / height / EXTEND_GRID) * EXTEND_GRID;
    else if (mode === "n" || mode === "s") height = Math.floor(EXTEND_MAX_PIXELS / width / EXTEND_GRID) * EXTEND_GRID;
    else {
      const scale = Math.sqrt(EXTEND_MAX_PIXELS / (width * height));
      width = Math.floor(width * scale / EXTEND_GRID) * EXTEND_GRID;
      height = Math.floor(height * scale / EXTEND_GRID) * EXTEND_GRID;
    }
  }
  return { x: Math.round(bounds.x + (mode.includes("w") && mode !== "draw" ? bounds.width - width : 0)),
    y: Math.round(bounds.y + (mode.includes("n") ? bounds.height - height : 0)), width, height };
}
export function initialExtendBounds(width: number, height: number): ExtendBounds {
  const source = extendSourceDimensions(width, height);
  const box = alignExtendBounds({ x: 0, y: 0, width: source.width * 1.5, height: source.height * 1.5 });
  return { ...box, x: Math.round((source.width - box.width) / 2), y: Math.round((source.height - box.height) / 2) };
}

export function extendOutputDimensions(config: ProjectConfig, source: { width: number; height: number }, bounds: ExtendBounds) {
  const selected = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  const pixelBudget = Math.min(source.width * source.height, selected.width * selected.height, EXTEND_MAX_PIXELS);
  const scale = Math.min(1, Math.sqrt(pixelBudget / (bounds.width * bounds.height)), EXTEND_MAX_EDGE / bounds.width, EXTEND_MAX_EDGE / bounds.height);
  const width = Math.floor(bounds.width * scale / EXTEND_GRID) * EXTEND_GRID;
  const height = Math.floor(bounds.height * scale / EXTEND_GRID) * EXTEND_GRID;
  if (width < EXTEND_GRID || height < EXTEND_GRID) throw new Error("The Extend box is too narrow for a 32-pixel generation grid at this resolution.");
  return { width, height };
}

export function extendLayout(config: ProjectConfig, source: { width: number; height: number }, bounds: ExtendBounds) {
  const workspace = extendSourceDimensions(source.width, source.height);
  extendRegions(workspace, bounds);
  if (bounds.width % EXTEND_GRID || bounds.height % EXTEND_GRID || bounds.width > EXTEND_MAX_EDGE || bounds.height > EXTEND_MAX_EDGE
    || bounds.width * bounds.height > EXTEND_MAX_PIXELS) throw new Error("Use box dimensions in multiples of 32 within the maximum generation resolution.");
  const output = extendOutputDimensions(config, source, bounds);
  const scale = Math.min(output.width / bounds.width, output.height / bounds.height);
  // A uniform scale preserves the source aspect ratio. Grid rounding adds a
  // little generated space instead of stretching the original to fit.
  const scaledSource = { width: Math.max(1, Math.round(workspace.width * scale)), height: Math.max(1, Math.round(workspace.height * scale)) };
  const mappedBounds = { x: Math.round(bounds.x * scale - (output.width - bounds.width * scale) / 2),
    y: Math.round(bounds.y * scale - (output.height - bounds.height * scale) / 2), ...output };
  return { output, source: scaledSource, bounds: mappedBounds, ...extendRegions(scaledSource, mappedBounds) };
}

export function extendRegions(source: { width: number; height: number }, bounds: ExtendBounds) {
  const { x, y, width, height } = bounds;
  if (![source.width, source.height, x, y, width, height].every(Number.isSafeInteger)
    || source.width < 1 || source.height < 1 || source.width > 8192 || source.height > 8192
    || width < 1 || height < 1 || width > 8192 || height > 8192 || Math.abs(x) > 8192 || Math.abs(y) > 8192) {
    throw new Error("Use whole-pixel bounds and dimensions from 1 to 8192 pixels.");
  }
  const left = Math.max(0, -x), top = Math.max(0, -y);
  const right = Math.min(width, source.width - x), bottom = Math.min(height, source.height - y);
  if (right <= left || bottom <= top) throw new Error("The box must overlap the original image.");
  const regions = [
    { x: 0, y: 0, width, height: top },
    { x: 0, y: bottom, width, height: height - bottom },
    { x: 0, y: top, width: left, height: bottom - top },
    { x: right, y: top, width: width - right, height: bottom - top },
  ].filter((region) => region.width > 0 && region.height > 0);
  if (!regions.length) throw new Error("Extend the box beyond at least one edge of the original image.");
  return { preserved: { x: left, y: top, width: right - left, height: bottom - top }, regions };
}

export function compileExtendImage(config: ProjectConfig, source: ProjectAsset, sourceRelativePath: string, options: ExtendOptions) {
  if (!source.width || !source.height) throw new Error("Wait for the source image dimensions to load.");
  const layout = extendLayout(config, { width: source.width, height: source.height }, options.bounds);
  const { regions, output } = layout;
  if (!Number.isInteger(options.steps) || options.steps < 2 || options.steps > 1000) throw new Error("Steps must be a whole number from 2 to 1000.");
  if (!Number.isSafeInteger(options.seed) || options.seed < -1) throw new Error("Seed must be -1 for random or a non-negative safe integer.");
  const scene = createImageEditScene({ relativePath: sourceRelativePath, name: source.name, ...output });
  scene.steps = options.steps; scene.seed = options.seed;
  scene.nodes[0].description = "Expand the field of view beyond the original image. Continue the environment, objects, textures, perspective and lighting into the new space with natural new detail. The original scene remains in its placed area within the larger composition. " + options.prompt.trim();
  const compiled = compileImagePrompt({ ...config, settings: { ...config.settings, defaultLook: null }, imageScene: scene }, { sourceTreatment: "outpaint" });
  // The rectangular editor needs a little original context at each seam.
  // The native finalizer restores the downscaled source pixels after generation.
  const overlap = 32;
  const edits = regions.map((region) => {
    const x = Math.max(0, region.x - overlap), y = Math.max(0, region.y - overlap);
    return { x, y, width: Math.min(output.width, region.x + region.width + overlap) - x,
      height: Math.min(output.height, region.y + region.height + overlap) - y, prompt: compiled.prompt, feather: 0 };
  });
  return { ...compiled, scene, edits, layout };
}
