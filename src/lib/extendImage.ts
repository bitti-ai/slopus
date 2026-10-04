import { createImageEditScene } from "./imageScene";
import { compileImagePrompt } from "./imagePrompt";
import type { ProjectAsset, ProjectConfig } from "./project";

/** Output bounds in original image pixels; negative coordinates extend left/up. */
export interface ExtendBounds { x: number; y: number; width: number; height: number }
export interface ExtendOptions { bounds: ExtendBounds; prompt: string; steps: number; seed: number }
export function initialExtendBounds(width: number, height: number): ExtendBounds {
  const dx = Math.min(Math.round(width / 4), Math.floor((8192 - width) / 2));
  const dy = Math.min(Math.round(height / 4), Math.floor((8192 - height) / 2));
  return { x: -dx, y: -dy, width: width + dx * 2, height: height + dy * 2 };
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
  const { regions } = extendRegions({ width: source.width, height: source.height }, options.bounds);
  if (!Number.isInteger(options.steps) || options.steps < 2 || options.steps > 1000) throw new Error("Steps must be a whole number from 2 to 1000.");
  if (!Number.isSafeInteger(options.seed) || options.seed < -1) throw new Error("Seed must be -1 for random or a non-negative safe integer.");
  const scene = createImageEditScene({ relativePath: sourceRelativePath, name: source.name, width: options.bounds.width, height: options.bounds.height });
  scene.steps = options.steps; scene.seed = options.seed;
  scene.nodes[0].description = "Extend the scene naturally beyond its original framing. Continue the environment, objects, textures, perspective and lighting into the new space. Preserve the original scene and visual style. Replace the stretched edge placeholders with coherent new content. " + options.prompt.trim();
  const compiled = compileImagePrompt({ ...config, settings: { ...config.settings, defaultLook: null }, imageScene: scene });
  // The rectangular editor needs a little original context at each seam.
  // The native finalizer restores all original pixels after every region is generated.
  const overlap = 32;
  const edits = regions.map((region) => {
    const x = Math.max(0, region.x - overlap), y = Math.max(0, region.y - overlap);
    return { x, y, width: Math.min(options.bounds.width, region.x + region.width + overlap) - x,
      height: Math.min(options.bounds.height, region.y + region.height + overlap) - y, prompt: compiled.prompt };
  });
  return { ...compiled, scene, edits };
}
