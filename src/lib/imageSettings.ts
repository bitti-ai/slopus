import type { ProjectConfig } from "./project";

/** Legacy images inherit project defaults until their own settings are saved. */
export function imageSettings(config: ProjectConfig): NonNullable<ProjectConfig["imageSettings"]> {
  const settings = config.imageSettings ?? config.settings;
  return { resolution: settings.resolution, aspectRatio: settings.aspectRatio, defaultLook: settings.defaultLook };
}
