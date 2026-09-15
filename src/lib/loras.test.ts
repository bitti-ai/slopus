// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadLoras, saveLoras, TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA } from "./loras";
import { createGeneratorTemplate, engineProviderSetting, generationStepsWithLoras, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, withEngineSettings } from "./settings";
import { createProjectConfig } from "./project";

beforeEach(() => localStorage.clear());

it("migrates the old schedule to an editable step override", () => {
  localStorage.setItem("slopus.loras.v1", JSON.stringify([{ id: "legacy", name: "Legacy", path: "D:/legacy.safetensors", schedule: "taomate-3step" }]));
  expect(loadLoras().find(({ id }) => id === "legacy")).toMatchObject({ stepOverride: 3 });
  saveLoras(loadLoras().map((lora) => ({ ...lora, stepOverride: undefined })));
  expect(loadLoras().every((lora) => lora.stepOverride === undefined)).toBe(true);
});

it("uses the highest active override regardless of order, excluding disabled and zero-strength LoRAs", () => {
  saveLoras([
    { id: "low", name: "Low", path: "D:/low.safetensors", stepOverride: 5 },
    { id: "high", name: "High", path: "D:/high.safetensors", stepOverride: 12 },
    { id: "disabled", name: "Disabled", path: "", stepOverride: 40 },
    { id: "zero", name: "Zero", path: "", stepOverride: 50 },
  ]);
  const selection = [
    { loraId: "high", enabled: true, strength: -0.5 },
    { loraId: "low", enabled: true, strength: 1 },
    { loraId: "disabled", enabled: false, strength: 1 },
    { loraId: "zero", enabled: true, strength: 0 },
  ];
  const paths = createGeneratorTemplate().paths;
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  config.providerSettings.slopfab = engineProviderSetting(paths, undefined, "sage2", selection);
  expect(generationStepsWithLoras(30, config)).toBe(12);
  expect(generationStepsWithLoras(3, config)).toBe(12);
  expect(engineProviderSetting(paths, undefined, "sage2", [...selection].reverse()).options.stepOverride).toBe(12);
  config.providerSettings.slopfab = engineProviderSetting(paths, config.providerSettings.slopfab, "sage2", []);
  expect(generationStepsWithLoras(30, config)).toBe(30);
});

it.each([0, 1, -3, 2.5, NaN, Infinity, 2147483648])("rejects invalid step override %s", (stepOverride) => {
  expect(() => saveLoras([{ id: "bad", name: "Bad", path: "D:/bad.safetensors", stepOverride }])).toThrow("Step override must be a whole number");
});

it("starts with TaoMate and Turbo and preserves the local library", () => {
  expect(loadLoras()).toEqual([TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA]);
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }]);
  expect(loadLoras().map(({ name }) => name)).toEqual(["TaoMate 3-Step", "Style", "Turbo", "Viggle Animate Distillation"]);
});

it("round-trips template order, enabled flags and strengths, and sends only active adapters", () => {
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }, { id: "off", name: "Off", path: "" }]);
  const template = { ...createGeneratorTemplate(), loras: [
    { loraId: "style", enabled: true, strength: -0.5 },
    { loraId: "off", enabled: false, strength: 1 },
    { loraId: TAOMATE_LORA.id, enabled: true, strength: 1 },
  ] };
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id, catalogVersion: 4 });
  expect(loadGeneratorTemplateSettings().templates[0].loras).toEqual(template.loras);
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const runtime = withEngineSettings(config);
  expect(JSON.parse(runtime.providerSettings.slopfab.options.loras as string)).toEqual([
    { path: "D:/style.safetensors", strength: -0.5 }, { path: "C:/weights/TaoMate.safetensors", strength: 1 },
  ]);
  expect(runtime.providerSettings.slopfab.options.stepOverride).toBe(3);
  expect(runtime.providerSettings.slopfab.options).not.toHaveProperty("schedule");
  expect(config.providerSettings).toEqual({});
  const without = engineProviderSetting(template.paths, runtime.providerSettings.slopfab, "sage2", []);
  expect(without.options).not.toHaveProperty("loras");
  expect(without.options).not.toHaveProperty("schedule");
  expect(without.options).not.toHaveProperty("stepOverride");
});

it("does not silently generate without an active missing adapter", () => {
  const template = createGeneratorTemplate();
  expect(() => engineProviderSetting(template.paths, undefined, "sage2", [{ loraId: TAOMATE_LORA.id, enabled: true, strength: 1 }])).toThrow("Download or locate LoRA TaoMate 3-Step");
  expect(engineProviderSetting(template.paths, undefined, "sage2", [{ loraId: TAOMATE_LORA.id, enabled: true, strength: 0 }]).options).not.toHaveProperty("loras");
});
