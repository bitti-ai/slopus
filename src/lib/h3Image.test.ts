// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { minimaxImageTemplate, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, generationStepsForTemplate, generationStepsWithLoras, generatorPathFields, engineProviderSetting, templateSupportsVideo, templateSupportsEditing, templateSamplingOptions } from "./settings";
import { resolveH3Components } from "./h3Components";
import { compileImagePrompt } from "./imagePrompt";
import { compileExtendImage } from "./extendImage";
import { createImageEditScene } from "./imageScene";
import { createProjectConfig } from "./project";

beforeEach(() => localStorage.clear());
const project = () => createProjectConfig({ name: "Image", generationType: "image", prompt: "A blue teapot", aspectRatio: "1:1", resolution: "416p", targetDurationSeconds: 15 });

it("adds MiniMax H3 Image once without changing selected or custom generators, and respects removal", () => {
  const custom = { ...minimaxImageTemplate(), id: "custom", name: "My images", paths: { ...minimaxImageTemplate().paths, transformer: "D:/model.safetensors" } };
  saveGeneratorTemplateSettings({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 22 });
  const migrated = loadGeneratorTemplateSettings();
  expect(migrated.templates).toEqual([custom, minimaxImageTemplate()].map(template => ({ ...resolveH3Components(template, migrated.h3Components!), sharedTextEncoder: true })));
  expect(loadGeneratorTemplateSettings()).toEqual(migrated);
  saveGeneratorTemplateSettings({ ...migrated, templates: [custom] });
  expect(loadGeneratorTemplateSettings().templates).toEqual([{ ...resolveH3Components(custom, migrated.h3Components!), sharedTextEncoder: true }]);
});

it("offers image-only weights, all supported download variants and the fixed recipe", () => {
  const template = minimaxImageTemplate();
  expect(template).toMatchObject({ name: "MiniMax H3 Image", modelType: "h3_image", defaultSteps: 6, attention: "flash2" });
  expect(templateSupportsVideo(template)).toBe(false);
  expect(templateSupportsEditing(template)).toBe(true);
  expect(generatorPathFields(template).map(({ id }) => id)).not.toContain("audioVae");
  const sources = Object.values(template.sources!).flat();
  expect(sources).toHaveLength(6);
  expect(sources.every(({ url }) => url.startsWith("https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/"))).toBe(true);
  expect(sources.some(({ url }) => url.includes("qwen3.5"))).toBe(false);
  expect(templateSamplingOptions(template)).toMatchObject({ samplers: ["default", "euler"], schedulers: ["default"] });
  expect(generationStepsForTemplate(20, template)).toBe(6);
  const config = project();
  config.providerSettings.slopfab = engineProviderSetting(template.paths, undefined, template.attention, [], "prompt", [], false, template.sources, template);
  expect(config.providerSettings.slopfab.options).toMatchObject({ modelType: "h3_image", attention: "flash2" });
  expect(config.providerSettings.slopfab.options.audioVae).toBeUndefined();
  expect(generationStepsWithLoras(20, config)).toBe(6);
});

it("uses plain image prompts and ordered Picture slots including an edit or outpaint source", () => {
  const config = project();
  config.references = Array.from({ length: 16 }, (_, i) => ({ id: `ref${i}`, kind: "image" as const, name: `Style ${i}`, description: "Blue glaze", relativePath: `references/${i}.png`, intendedUse: [], createdAt: config.createdAt }));
  const prompt = config.references.map(({ id }) => `@[ref:${id}]`).join(" ");
  config.imageScene!.nodes[0].description = prompt;
  expect(compileImagePrompt(config, { modelType: "h3_image" }).prompt).toContain("<Picture 16>");
  expect(compileImagePrompt(config, { modelType: "h3_image" }).prompt).not.toMatch(/Shot 1|overall_soundscape|non_diegetic_music/);
  config.imageScene = createImageEditScene({ relativePath: "source.png", name: "Source", width: 128, height: 96 });
  config.imageScene.nodes[0].description = prompt;
  expect(() => compileImagePrompt(config, { modelType: "h3_image" })).toThrow("16 pictures including the edit source");
  config.imageScene.nodes[0].description = "Use @[ref:ref0]";
  for (const sourceTreatment of [undefined, "outpaint"] as const) {
    const compiled = compileImagePrompt(config, { modelType: "h3_image", sourceTreatment });
    expect(compiled.prompt).toContain("Edit <Picture 1>");
    expect(compiled.prompt).toContain("Style 0 (<Picture 2>)");
  }
});

it("uses zero refinement for outpainting and full strength for crop edits", () => {
  const config = project();
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt };
  const options = { bounds: { x: -32, y: -32, width: 192, height: 160 }, prompt: "Forest", steps: 6, seed: 0 };
  const extended = compileExtendImage(config, source, "canvas.png", options, "h3_image");
  expect(extended.edits[0]).toMatchObject({ invertMask: true, outpaintLangevinSteps: 0, outpaintBlendOverlap: 9 });
  expect(extended.prompt).toContain("<Picture 1>");
  expect(extended.prompt).not.toContain("Source scene");
  const cropped = compileExtendImage(config, source, "canvas.png", { ...options, bounds: { x: 0, y: 0, width: 64, height: 64 } }, "h3_image");
  expect(cropped.edits[0]).toMatchObject({ invertMask: false, strength: 1 });
});
