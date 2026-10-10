// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { DMAD_LORA, downloadableTemplateLoras, LIGHTX2V_TURBO_LORA, loadLoras, saveLoras, TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA } from "./loras";
import { createGeneratorTemplate, engineProviderSetting, generationSigmaShifts, generationStepsWithLoras, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, withEngineSettings } from "./settings";
import { createProjectConfig } from "./project";

beforeEach(() => localStorage.clear());

it("ignores legacy library multipliers and uses template strengths directly", () => {
  localStorage.setItem("slopus.loras.v1", JSON.stringify([
    { id: "style", name: "Style", path: "D:/style.safetensors", multiplier: 0.75 },
    { ...TURBO_LORA, multiplier: 0 },
  ]));
  const selection = [
    { loraId: "style", enabled: true, strength: -0.5 },
    { loraId: TURBO_LORA.id, enabled: true, strength: 1 },
  ];
  expect(loadLoras().find(({ id }) => id === "style")).not.toHaveProperty("multiplier");
  expect(downloadableTemplateLoras(selection)).toEqual([TURBO_LORA]);
  const options = engineProviderSetting(createGeneratorTemplate().paths, undefined, "sage2", [selection[0]]).options;
  expect(JSON.parse(options.loras as string)).toEqual([{ path: "D:/style.safetensors", strength: -0.5 }]);
  expect(options).not.toHaveProperty("stepOverride");
  saveLoras(loadLoras());
  expect(localStorage.getItem("slopus.loras.v1")).not.toContain('"multiplier"');
});

it.each([NaN, Infinity, -Infinity, 1e39])("rejects template strength %s outside the engine's numeric range", (strength) => {
  saveLoras([{ ...TURBO_LORA, path: "D:/turbo.safetensors" }]);
  expect(() => engineProviderSetting(createGeneratorTemplate().paths, undefined, "sage2", [
    { loraId: TURBO_LORA.id, enabled: true, strength },
  ])).toThrow("Strength for LoRA Turbo");
});

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

it("starts with the bundled adapters and preserves the local library", () => {
  expect(loadLoras()).toEqual([TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA, LIGHTX2V_TURBO_LORA, DMAD_LORA]);
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }]);
  expect(loadLoras().map(({ name }) => name)).toEqual(["TaoMate 3-Step", "Style", "Turbo", "Viggle Animate Distillation", "LightX2V Turbo", "DMAD 4-Step"]);
});

it("preserves DMAD's recipe and local path and gives its fixed grid priority over step overrides", () => {
  saveLoras([{ ...DMAD_LORA, path: "D:/renamed.safetensors" }, { ...LIGHTX2V_TURBO_LORA, path: "D:/style.safetensors" }]);
  expect(loadLoras().find(({ id }) => id === DMAD_LORA.id)).toMatchObject({ path: "D:/renamed.safetensors", samplingPreset: "dmad-4step" });
  const paths = createGeneratorTemplate().paths;
  const selection = [
    { loraId: DMAD_LORA.id, enabled: true, strength: 1 },
    { loraId: LIGHTX2V_TURBO_LORA.id, enabled: true, strength: 0.5 },
  ];
  const provider = engineProviderSetting(paths, undefined, "sage2", selection, "prompt", [], true);
  expect(provider.options).toMatchObject({ samplingPreset: "dmad-4step", stepOverride: 4 });
  expect(provider.options).not.toHaveProperty("motionCache");
  expect(engineProviderSetting(paths, provider, "sage2", [...selection].reverse()).options.stepOverride).toBe(4);
  for (const inactive of [{ enabled: false, strength: 1 }, { enabled: true, strength: 0 }]) {
    const without = engineProviderSetting(paths, provider, "sage2", [{ ...selection[0], ...inactive }, selection[1]], "prompt", [], true);
    expect(without.options).not.toHaveProperty("samplingPreset");
    expect(without.options).toMatchObject({ stepOverride: 6, motionCache: true });
  }
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

it("persists sigma defaults and applies the highest active override per stream before scene values", () => {
  saveLoras([
    { id: "a", name: "A", path: "D:/a.safetensors", videoSigmaShiftOverride: 6, audioSigmaShiftOverride: 2 },
    { id: "b", name: "B", path: "D:/b.safetensors", videoSigmaShiftOverride: 8.5 },
    { id: "off", name: "Off", path: "", audioSigmaShiftOverride: 50 },
  ]);
  const template = { ...createGeneratorTemplate(), videoSigmaShift: 10, audioSigmaShift: 3.5,
    loras: [{ loraId: "a", enabled: true, strength: 1 }, { loraId: "b", enabled: true, strength: -0.5 },
      { loraId: "off", enabled: false, strength: 1 }] };
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id });
  const restored = loadGeneratorTemplateSettings().templates.find(({ id }) => id === template.id)!;
  expect(restored).toMatchObject({ videoSigmaShift: 10, audioSigmaShift: 3.5 });
  expect(generationSigmaShifts({ videoSigmaShift: 12, audioSigmaShift: 5 }, restored)).toEqual({ videoSigmaShift: 8.5, audioSigmaShift: 2 });
  template.loras = template.loras.map((entry) => ({ ...entry, strength: 0 }));
  expect(generationSigmaShifts({ videoSigmaShift: 7 }, template)).toEqual({ videoSigmaShift: 7, audioSigmaShift: 3.5 });
  expect(generationSigmaShifts({}, { ...template, loras: [{ loraId: DMAD_LORA.id, enabled: true, strength: 1 }] })).toEqual({ videoSigmaShift: 12, audioSigmaShift: 2 });
  const options = engineProviderSetting(restored.paths, undefined, "sage2", restored.loras, "prompt", [], false, {}, restored).options;
  expect(options).toMatchObject({ videoSigmaShift: 10, audioSigmaShift: 3.5, videoSigmaShiftOverride: 8.5, audioSigmaShiftOverride: 2 });
  const cleared = engineProviderSetting(restored.paths, { enabled: true, model: null, options }, "sage2", [], "prompt", [], false, {}, {}).options;
  for (const key of ["videoSigmaShift", "audioSigmaShift", "videoSigmaShiftOverride", "audioSigmaShiftOverride"]) expect(cleared).not.toHaveProperty(key);
});

it.each([0, -1, Infinity, NaN, 1e39, 1e-50])("rejects invalid LoRA sigma shift %s", (shift) => {
  expect(() => saveLoras([{ id: "bad", name: "Bad", path: "D:/bad.safetensors", videoSigmaShiftOverride: shift }])).toThrow("Sigma shift");
  expect(() => saveLoras([{ id: "bad", name: "Bad", path: "D:/bad.safetensors", audioSigmaShiftOverride: shift }])).toThrow("Sigma shift");
});
