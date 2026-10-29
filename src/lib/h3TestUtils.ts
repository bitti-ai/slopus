import { createGeneratorTemplate, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "./settings";

export function localGeneratorTemplate(name?: string, modelType?: string) {
  const template = createGeneratorTemplate(name, modelType);
  if (template.modelType === "minimax-h3") Object.assign(template.paths, {
    textEncoder: "D:/test-weights/text.safetensors", videoVae: "D:/test-weights/video.safetensors", audioVae: "D:/test-weights/audio.safetensors",
  });
  return template;
}

/** Generation/UI tests use installed shared dependencies; download tests use real URL fixtures. */
export function installH3TestDependencies() {
  const settings = loadGeneratorTemplateSettings();
  for (const entry of settings.h3Components!.templates) {
    entry.path = `D:/test-weights/${entry.id}.safetensors`;
    entry.sources = entry.sources.map((source) => ({ ...source, downloadedPath: entry.path }));
  }
  saveGeneratorTemplateSettings(settings);
}
