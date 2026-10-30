// @vitest-environment jsdom
import { installH3TestDependencies } from "./h3TestUtils";
import { beforeEach, expect, it } from "vitest";
import { PIKA_FL2VA_LORA, PIKA_REF2VA_LORA, DMAD_LORA, downloadableTemplateLoras, LIGHTX2V_TURBO_LORA, loadLoras, saveLoras, TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA } from "./loras";
import { createGeneratorTemplate, engineProviderSetting, generationSigmaShifts, generationStepsWithLoras, kreaImageTemplates, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, withEngineSettings } from "./settings";
import { createProjectConfig } from "./project";
import { effectiveLoras, moveLibraryLora, selectionConflict, loraSnapshot } from "./loras";
import { generationStepsForTemplate, templateNeedsDownload } from "./settings";
import { createDraftGenerationJob, parseProjectConfig, sceneGenerationSnapshot } from "./project";
import { sceneLoraBlocker, sceneGenerationRequest } from "./sceneGeneration";
import { sceneInput, duplicateScene } from "./sceneHistory";

beforeEach(() => { localStorage.clear(); installH3TestDependencies(); });

it("does not inherit default-generator or global adapters when Krea omits its LoRA list", () => {
  saveLoras([{ ...DMAD_LORA, path: "D:/dmad.safetensors", globallyEnabled: true }]);
  const defaults = createGeneratorTemplate();
  defaults.loras = [{ loraId: DMAD_LORA.id, enabled: true, strength: 1 }];
  saveGeneratorTemplateSettings({ templates: [defaults], defaultTemplateId: defaults.id, catalogVersion: 20 });
  for (const template of kreaImageTemplates()) {
    const options = engineProviderSetting(template.paths, undefined, template.attention, undefined, "prompt", [], false, template.sources,
      { ...template, sampler: "er_sde", scheduler: "beta" }).options;
    expect(options).toMatchObject({ modelType: "krea2", sampler: "er_sde", scheduler: "beta" });
    for (const key of ["loras", "samplingPreset", "stepOverride", "videoSigmaShiftOverride", "audioSigmaShiftOverride"]) expect(options).not.toHaveProperty(key);
    expect(effectiveLoras(defaults.loras, defaults.loras, template.modelType)).toEqual([]);
  }
});

it("merges global, template and scene LoRAs once in library order and keeps globals active", () => {
  saveLoras([{ id: "style", name: "Style", path: "D:/style", globallyEnabled: true, globalStrength: 0.7 },
    { id: "template", name: "Template", path: "D:/template", stepOverride: 12 },
    { ...PIKA_REF2VA_LORA, path: "D:/pika", globallyEnabled: true }]);
  const template = createGeneratorTemplate();
  template.loras = [{ loraId: "template", enabled: true, strength: 1 }, { loraId: "style", enabled: false, strength: 0 }];
  const overrides = [{ loraId: "style", enabled: false, strength: 0 }, { loraId: "template", enabled: false, strength: 1 }];
  const options = engineProviderSetting(template.paths, undefined, template.attention, template.loras, template.mode, [], true, {}, template, overrides).options;
  expect(JSON.parse(options.loras as string)).toEqual([{ path: "D:/style", strength: 0.7 }, { path: "D:/pika", strength: 1 }]);
  expect(options).toMatchObject({ stepOverride: 6, samplingPreset: "pika-6step", videoSigmaShiftOverride: 12, audioSigmaShiftOverride: 3 });
  expect(options).not.toHaveProperty("motionCache");
  expect(generationStepsForTemplate(30, template, overrides)).toBe(6);
  expect(effectiveLoras([], [], "fibo2")).toEqual([]);
  moveLibraryLora(PIKA_REF2VA_LORA.id, "style");
  expect(effectiveLoras(template.loras, overrides).filter((entry) => entry.enabled).map((entry) => entry.loraId)).toEqual([PIKA_REF2VA_LORA.id, "style"]);
});

it("rejects incompatible global recipes and Pika variants without changing the saved library", () => {
  saveLoras([{ ...DMAD_LORA, globallyEnabled: true }]);
  expect(() => saveLoras(loadLoras().map((lora) => lora.id === PIKA_REF2VA_LORA.id ? { ...lora, globallyEnabled: true } : lora))).toThrow("different sampling recipes");
  expect(loadLoras().find((lora) => lora.id === PIKA_REF2VA_LORA.id)?.globallyEnabled).toBeUndefined();
  expect(selectionConflict([PIKA_REF2VA_LORA, PIKA_FL2VA_LORA].map((lora) => ({ loraId: lora.id, enabled: true, strength: 1 })))).toContain("one Pika");
  expect(() => saveLoras([{ ...DMAD_LORA, globalStrength: 0 }])).toThrow("nonzero");
  expect(templateNeedsDownload(createGeneratorTemplate())).toBe(true);
});

it("allows short global recipes for Single Shot context with automatic native lock timing", () => {
  saveLoras([{ ...DMAD_LORA, path: "D:/dmad", globallyEnabled: true }]);
  const job = { ...createDraftGenerationJob("Continue", { sceneType: "single-shot" }), contextSceneId: "original" };
  const template = createGeneratorTemplate();
  expect(sceneLoraBlocker(job, template)).toBeNull();
  saveLoras(loadLoras().map((lora) => ({ ...lora, globallyEnabled: lora.id === PIKA_REF2VA_LORA.id })));
  expect(sceneLoraBlocker(job, template)).toBeNull();
});

it("persists scene overrides and records effective render settings without persisting machine paths", () => {
  saveLoras([{ id: "style", name: "Style", path: "D:/private/style", stepOverride: 7 }]);
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const job = { ...createDraftGenerationJob("Walk"), loraOverrides: [{ loraId: "style", enabled: true, strength: 0.4 }] };
  config.generationJobs = [job];
  const template = createGeneratorTemplate();
  const request = sceneGenerationRequest(job, config, "D:/project", 30, template);
  const snapshot = sceneGenerationSnapshot(job, request);
  expect(JSON.parse(snapshot)).toMatchObject({ steps: 7, loras: [{ loraId: "style", strength: 0.4 }] });
  expect(snapshot).not.toContain("private");
  expect(sceneGenerationSnapshot(job, { ...request, steps: 7 })).toBe(snapshot);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).generationJobs[0].loraOverrides).toEqual(job.loraOverrides);
  expect(sceneInput(job).loraOverrides).toEqual(job.loraOverrides);
  expect(duplicateScene(config, job.id)?.config.generationJobs[1].loraOverrides).toEqual(job.loraOverrides);
  saveLoras(loadLoras().map((lora) => lora.id === "style" ? { ...lora, stepOverride: 8 } : lora));
  expect(loraSnapshot(effectiveLoras([], job.loraOverrides))).not.toEqual(request.loraSnapshot);
});

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
  expect(loadLoras()).toEqual([TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA, LIGHTX2V_TURBO_LORA, DMAD_LORA, PIKA_FL2VA_LORA, PIKA_REF2VA_LORA]);
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }]);
  expect(loadLoras().map(({ name }) => name)).toEqual(["TaoMate 3-Step", "Style", "Turbo", "Viggle Animate Distillation", "LightX2V Turbo", "DMAD 4-Step", "Pika H3 First/Last", "Pika H3 Reference"]);
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

it.each([PIKA_FL2VA_LORA, PIKA_REF2VA_LORA])("preserves $name edits and applies its fixed six-step recipe", (lora) => {
  saveLoras([{ ...lora, name: "My Pika adapter", path: "D:/pika.safetensors" }]);
  expect(loadLoras().filter(({ id }) => id === lora.id)).toEqual([{ ...lora, name: "My Pika adapter", path: "D:/pika.safetensors" }]);
  const selection = [{ loraId: lora.id, enabled: true, strength: 1 }];
  const provider = engineProviderSetting(createGeneratorTemplate().paths, undefined, "sage2", selection, "prompt", [], true);
  expect(provider.options).toMatchObject({ samplingPreset: "pika-6step", stepOverride: 6, videoSigmaShiftOverride: 12, audioSigmaShiftOverride: 3 });
  expect(provider.options).not.toHaveProperty("motionCache");
  expect(generationSigmaShifts({ videoSigmaShift: 8, audioSigmaShift: 2 }, { ...createGeneratorTemplate(), loras: selection })).toEqual({ videoSigmaShift: 12, audioSigmaShift: 3 });
  for (const inactive of [{ enabled: false, strength: 1 }, { enabled: true, strength: 0 }]) {
    expect(engineProviderSetting(createGeneratorTemplate().paths, provider, "sage2", [{ ...selection[0], ...inactive }]).options).not.toHaveProperty("samplingPreset");
  }
});

it("rejects conflicting fixed LoRA recipes before generation", () => {
  saveLoras([{ ...PIKA_REF2VA_LORA, path: "D:/pika.safetensors" }, { ...DMAD_LORA, path: "D:/dmad.safetensors" }]);
  expect(() => engineProviderSetting(createGeneratorTemplate().paths, undefined, "sage2", [
    { loraId: PIKA_REF2VA_LORA.id, enabled: true, strength: 1 }, { loraId: DMAD_LORA.id, enabled: true, strength: 1 },
  ])).toThrow("different sampling recipes");
});

it("round-trips template order, enabled flags and strengths, and sends only active adapters", () => {
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }, { id: "off", name: "Off", path: "" }]);
  const template = { ...createGeneratorTemplate(), loras: [
    { loraId: "style", enabled: true, strength: -0.5 },
    { loraId: "off", enabled: false, strength: 1 },
    { loraId: TAOMATE_LORA.id, enabled: true, strength: 1 },
  ] };
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id, catalogVersion: 17 });
  expect(loadGeneratorTemplateSettings().templates[0].loras).toEqual(template.loras);
  const config = createProjectConfig({ name: "Test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const runtime = withEngineSettings(config);
  expect(JSON.parse(runtime.providerSettings.slopfab.options.loras as string)).toEqual([
    { path: "C:/weights/TaoMate.safetensors", strength: 1 }, { path: "D:/style.safetensors", strength: -0.5 },
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


it("preserves model ownership while accepting older H3 library entries", () => {
  const entries = [
    { id: "legacy", name: "Legacy H3", path: "D:/h3.safetensors" },
    { id: "moss", name: "MOSS adapter", path: "D:/moss.safetensors", modelType: "moss" },
  ];
  saveLoras(entries);
  expect(loadLoras().filter((entry) => entries.some(({ id }) => id === entry.id))).toEqual(entries);
  saveLoras(loadLoras().map((entry) => ({ ...entry, path: entry.path.replace("D:/", "E:/") })));
  expect(loadLoras().find(({ id }) => id === "moss")).toMatchObject({ modelType: "moss", path: "E:/moss.safetensors" });
});
