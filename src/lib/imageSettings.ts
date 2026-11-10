import type { AspectRatio, ProjectConfig, Resolution } from "./project";
import { outputDimensions } from "./export";

export const H3_IMAGE_MAX_PIXELS = 20 * 1024 * 1024;

/** Keep the stored preset as a stable index across image models. */
export function imageResolutionScale(modelType?: string) {
  return modelType === "h3_image" ? 4 : 1;
}

export function imageGenerationDimensions(resolution: Resolution, aspectRatio: AspectRatio, modelType?: string) {
  const size = outputDimensions(resolution, aspectRatio);
  const scale = imageResolutionScale(modelType);
  return { width: size.width * scale, height: size.height * scale };
}

export function imageGenerationSizeError(size: { width: number; height: number }, modelType?: string) {
  return modelType === "h3_image" && size.width * size.height > H3_IMAGE_MAX_PIXELS
    ? "MiniMax H3 Image supports up to 20 MP. Choose a smaller resolution."
    : null;
}

/** Legacy images inherit project defaults until their own settings are saved. */
export function imageSettings(config: ProjectConfig): NonNullable<ProjectConfig["imageSettings"]> {
  const settings = config.imageSettings ?? config.settings;
  return { resolution: settings.resolution, aspectRatio: settings.aspectRatio, defaultLook: settings.defaultLook };
}
