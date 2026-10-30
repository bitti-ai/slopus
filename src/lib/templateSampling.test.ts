// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { effectiveTemplateSampling, engineProviderSetting, fiboBaseTemplate, kreaImageTemplates, loadGeneratorTemplateSettings,
  minimaxFastTemplate, minimaxOriginalTemplate, minimaxSingularityTemplate, mossImageTemplate, musicTemplates,
  saveGeneratorTemplateSettings, templateSamplingOptions, viggleAnimateTemplate, type GeneratorTemplate } from "./settings";
import { DMAD_LORA, saveLoras } from "./loras";
import { parseGeneratorSlop, serializeGeneratorSlop, mergeGeneratorSlop } from "./slop";

beforeEach(() => localStorage.clear());
const provider = (template: GeneratorTemplate, base?: Parameters<typeof engineProviderSetting>[1]) =>
  engineProviderSetting(template.paths, base, template.attention, template.loras ?? [], template.mode ?? "prompt", [], template.motionCache, template.sources, template);

it("preserves legacy defaults without forcing a sampler or scheduler", () => {
  const template = minimaxOriginalTemplate();
  expect(effectiveTemplateSampling(template)).toEqual({ sampler: "default", scheduler: "default" });
  const options = provider(template, { enabled: true, model: null, options: { sampler: "er_sde", scheduler: "beta", schedule: "beta" } }).options;
  expect(options).not.toHaveProperty("sampler");
  expect(options).not.toHaveProperty("scheduler");
  expect(options).not.toHaveProperty("schedule");
});

it.each([mossImageTemplate(), fiboBaseTemplate(), ...kreaImageTemplates()])("offers supported image sampling choices for $name", (template) => {
  expect(templateSamplingOptions(template)).toMatchObject({ samplers: ["default", "euler", "er_sde"], schedulers: ["default", "beta"] });
  const configured = { ...template, sampler: "er_sde" as const, scheduler: "beta" as const, videoSigmaShift: 4 };
  saveGeneratorTemplateSettings({ templates: [configured], defaultTemplateId: "", catalogVersion: 20 });
  const restored = loadGeneratorTemplateSettings().templates[0];
  expect(restored).toMatchObject({ sampler: "er_sde", scheduler: "beta" });
  expect(provider(restored).options).toMatchObject({ sampler: "er_sde", scheduler: "beta", videoSigmaShift: 4 });
  const bundle = parseGeneratorSlop(serializeGeneratorSlop([configured]));
  const imported = mergeGeneratorSlop(bundle, { templates: [], defaultTemplateId: "", catalogVersion: 20 }, []).settings.templates[0];
  expect(imported).toMatchObject({ sampler: "er_sde", scheduler: "beta" });
});

it("limits music, Animate, Omni and fixed recipes without treating step counts as fixed grids", () => {
  for (const template of musicTemplates()) expect(templateSamplingOptions(template)).toMatchObject({ samplers: ["default"], schedulers: ["default"] });
  expect(templateSamplingOptions(viggleAnimateTemplate())).toMatchObject({ samplers: ["default", "euler"], schedulers: ["default", "beta"] });
  expect(templateSamplingOptions(minimaxFastTemplate())).toMatchObject({ samplers: ["default", "euler"], schedulers: ["default"] });
  expect(templateSamplingOptions(minimaxSingularityTemplate()).schedulers).toEqual(["default", "beta"]);
  const template = { ...minimaxOriginalTemplate(), sampler: "er_sde" as const, scheduler: "beta" as const, motionCache: true };
  expect(templateSamplingOptions(template).samplers).toEqual(["default", "euler", "ab2", "renoise", "er_sde"]);
  expect(provider(template).options).not.toHaveProperty("motionCache");
  saveLoras([{ ...DMAD_LORA, path: "D:/dmad.safetensors", globallyEnabled: true }]);
  expect(templateSamplingOptions(template)).toMatchObject({ samplers: ["default"], schedulers: ["default"] });
  expect(provider(template).options).toMatchObject({ samplingPreset: "dmad-4step" });
  expect(provider(template).options).not.toHaveProperty("sampler");
  expect(provider(template).options).not.toHaveProperty("scheduler");
  expect(template).toMatchObject({ sampler: "er_sde", scheduler: "beta" });
});
