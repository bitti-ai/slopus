// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { TURBO_LORA, VIGGLE_ANIMATE_LORA, loadLoras, saveLoras } from "./loras";
import {
  agentEndpointProviderSettings,
  selectedImageGeneratorTemplate, createGeneratorTemplate, musicTemplates, mossImageTemplate, fiboImageTemplate, fiboBaseTemplate, templateSupportsEditing, templateSupportsOutpainting, defaultGeneratorTemplate, generatorPathFields, templateSupportsVideo,
  engineProviderSetting,
  loadInferenceBackend,
  saveInferenceBackend,
  loadDefaultGenerationSteps,
  loadAgentEndpointSettings,
  loadEngineSettings,
  loadGeneratorTemplateSettings,
  minimaxOriginalTemplate,
  minimaxReferencesTemplate,
  minimaxFastTemplate,
  minimaxSingularityTemplate,
  viggleAnimateTemplate,
  templateNeedsDownload,
  saveAgentEndpointSettings,
  saveGeneratorTemplateSettings,
} from "./settings";

describe("generator templates", () => {
  beforeEach(() => localStorage.clear());

  it("starts image projects with the remembered Fibo generator's four-step default", async () => {
    const h3 = createGeneratorTemplate("Video"), fibo = createGeneratorTemplate("Fibo", "fibo2");
    saveGeneratorTemplateSettings({ templates: [h3, fibo], defaultTemplateId: h3.id, catalogVersion: 14 });
    localStorage.setItem("slopus.image-generator-template.v1", fibo.id);
    expect(selectedImageGeneratorTemplate().defaultSteps).toBe(4);
    const { createProject } = await import("./persistence");
    const record = await createProject({ name: "Fibo image", generationType: "image", prompt: "A blue vase", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 10 });
    expect(record?.config.imageScene?.steps).toBe(4);
  });

  it("normalizes missing Fibo steps to four while retaining explicit custom defaults", () => {
    const fibo = fiboImageTemplate();
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [{ ...fibo, defaultSteps: undefined }], catalogVersion: 14 }));
    expect(loadGeneratorTemplateSettings().templates[0].defaultSteps).toBe(4);
    saveGeneratorTemplateSettings({ templates: [{ ...fibo, defaultSteps: 8 }], defaultTemplateId: "", catalogVersion: 14 });
    expect(loadGeneratorTemplateSettings().templates[0].defaultSteps).toBe(8);
  });

  it("adds Fibo once without replacing custom settings or restoring a removed template", () => {
    const custom = createGeneratorTemplate("Custom");
    saveGeneratorTemplateSettings({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 13 });
    const migrated = loadGeneratorTemplateSettings();
    expect(migrated.templates).toEqual([expect.objectContaining(custom), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(migrated.defaultTemplateId).toBe(custom.id);
    expect(loadGeneratorTemplateSettings()).toEqual(migrated);
    saveGeneratorTemplateSettings({ ...migrated, templates: [custom] });
    expect(loadGeneratorTemplateSettings().templates).toHaveLength(1);
  });

  it("configures Fibo with three weights, embedded tokenizer and four Flash steps", () => {
    const fibo = fiboImageTemplate();
    expect(createGeneratorTemplate("Fibo", "fibo2")).toMatchObject({ defaultSteps: 4, attention: "flash2" });
    expect(fibo.paths).toEqual({
      transformer: "https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/diffusion_models/fibo2_edit_turbo_int8_convrot.safetensors",
      textEncoder: "https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors",
      videoVae: "https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/vae/flux2-vae.safetensors", audioVae: "", tokenizer: "",
    });
    expect(generatorPathFields(fibo).filter(({ required }) => required).map(({ id }) => id)).toEqual(["transformer", "textEncoder", "videoVae"]);
    expect(templateSupportsVideo(fibo)).toBe(false);
    const paths = { ...fibo.paths, transformer: "transformer", textEncoder: "qwen", videoVae: "flux" };
    const provider = engineProviderSetting(paths, { enabled: true, model: null, options: { tokenizer: "old-tokenizer", audioVae: "old-audio" } }, fibo.attention, [], "prompt", [], false, fibo.sources, fibo);
    expect(provider.options).toMatchObject({ modelType: "fibo2", attention: "flash2", transformer: "transformer", textEncoder: "qwen", videoVae: "flux" });
    expect(provider.options).not.toHaveProperty("audioVae");
    expect(provider.options).not.toHaveProperty("tokenizer");
  });

  it("adds MOSS once, preserving local templates, defaults and catalog removal", () => {
    const custom = createGeneratorTemplate("Custom");
    saveGeneratorTemplateSettings({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 9 });
    const migrated = loadGeneratorTemplateSettings();
    expect(migrated.templates).toEqual([expect.objectContaining(custom), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(migrated.defaultTemplateId).toBe(custom.id);
    expect(loadGeneratorTemplateSettings()).toEqual(migrated);
    saveGeneratorTemplateSettings({ ...migrated, templates: [custom] });
    expect(loadGeneratorTemplateSettings().templates).toHaveLength(1);
  });

  it("uses MOSS image weights and tokenizer without audio and excludes it from video defaults", () => {
    const moss = mossImageTemplate();
    expect(generatorPathFields(moss).filter((field) => field.required).map((field) => field.id)).toEqual(["transformer", "textEncoder", "videoVae", "tokenizer"]);
    expect(generatorPathFields(moss).find((field) => field.id === "tokenizer")?.directory).toBe(false);
    expect(templateSupportsVideo(moss)).toBe(false);
    moss.paths = Object.fromEntries(Object.entries(moss.paths).map(([key, value]) => [key, value ? `D:/weights/${key}` : ""])) as typeof moss.paths;
    const h3 = createGeneratorTemplate("Video");
    const settings = { templates: [moss, h3], defaultTemplateId: moss.id, catalogVersion: 10 };
    expect(defaultGeneratorTemplate(settings).id).toBe(moss.id);
    expect(defaultGeneratorTemplate(settings, "video").id).toBe(h3.id);
    const provider = engineProviderSetting(moss.paths, { enabled: true, model: null, options: { audioVae: "old-audio" } }, moss.attention, [], "prompt", [], false, moss.sources, moss);
    expect(provider.options).toMatchObject({ modelType: "moss", attention: "flash2", tokenizer: "D:/weights/tokenizer", videoVae: "D:/weights/videoVae" });
    expect(provider.options).not.toHaveProperty("audioVae");
  });

  it("assigns MiniMax H3 to current and legacy generators and preserves future model types", () => {
    expect(createGeneratorTemplate().modelType).toBe("minimax-h3");
    expect(loadGeneratorTemplateSettings().templates.filter((template) => ! ["moss-image", "fibo2-edit-turbo", "fibo2-base", "yue2", "minimax_music3"].includes(template.id)).every((template) => template.modelType === "minimax-h3")).toBe(true);
    for (const modelType of [undefined, null, "", 123]) {
      localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({
        templates: [{ id: "legacy", name: "Renamed generator", modelType }], defaultTemplateId: "legacy", catalogVersion: 9,
      }));
      expect(loadGeneratorTemplateSettings().templates[0].modelType).toBe("minimax-h3");
    }
    const future = createGeneratorTemplate("Future generator", "future-model");
    saveGeneratorTemplateSettings({ templates: [future], defaultTemplateId: future.id, catalogVersion: 9 });
    expect(loadGeneratorTemplateSettings().templates[0]).toMatchObject(future);
  });

  it("persists MotionCache per template and replaces stale runtime options", () => {
    const template = createGeneratorTemplate();
    expect(template.motionCache ?? false).toBe(false);
    template.motionCache = true;
    saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id, catalogVersion: 8 });
    expect(loadGeneratorTemplateSettings().templates[0].motionCache).toBe(true);
    const enabled = engineProviderSetting(template.paths);
    expect(enabled.options.motionCache).toBe(true);
    expect(engineProviderSetting(template.paths, enabled, template.attention, [], "prompt", [], false).options).not.toHaveProperty("motionCache");
    expect(engineProviderSetting(template.paths, enabled, template.attention, [], "animate", [], true).options).not.toHaveProperty("motionCache");
    template.motionCache = false;
    saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id, catalogVersion: 8 });
    expect(engineProviderSetting(template.paths, enabled).options).not.toHaveProperty("motionCache");
  });

  it("migrates the former flat engine paths into the Default template", () => {
    localStorage.setItem("slopus.engine-paths.v1", JSON.stringify({ transformer: "D:\\Models\\main.safetensors" }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.defaultTemplateId).toBe("default");
    expect(settings.templates).toHaveLength(11);
    expect(settings.templates[1].name).toBe("First/Last Frame");
    expect(settings.templates[0]).toMatchObject({
      id: "default",
      name: "Default",
      defaultSteps: 20,
      attention: "sage2",
      paths: { transformer: "D:\\Models\\main.safetensors" },
    });
  });

  it("migrates missing or invalid attention to Sage", () => {
    for (const attention of [undefined, "unsupported"]) {
      localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({
        templates: [{ id: "old", name: "Old", attention }], defaultTemplateId: "old",
      }));
      expect(loadGeneratorTemplateSettings().templates[0].attention).toBe("sage2");
    }
  });

  it("adds conditioning to installed Animate templates once without replacing custom files", () => {
    const animate = viggleAnimateTemplate();
    animate.paths.transformer = "D:/models/viggle.safetensors";
    delete animate.additionalSafetensors;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [animate], defaultTemplateId: "", catalogVersion: 7 }));
    const migrated = loadGeneratorTemplateSettings();
    expect(migrated.templates[0].paths.transformer).toBe(animate.paths.transformer);
    expect(migrated.templates[0].additionalSafetensors).toEqual(viggleAnimateTemplate().additionalSafetensors);
    expect(loadGeneratorTemplateSettings()).toEqual(migrated);
    migrated.templates[0].additionalSafetensors![0].url = "https://example.com/custom.safetensors";
    saveGeneratorTemplateSettings(migrated);
    expect(loadGeneratorTemplateSettings().templates[0].additionalSafetensors![0].url).toBe("https://example.com/custom.safetensors");
  });

  it("migrates Animate once and preserves its mode, local weights and four-step adapter", () => {
    const custom = createGeneratorTemplate("Existing");
    saveGeneratorTemplateSettings({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 6 });
    const settings = loadGeneratorTemplateSettings();
    const template = settings.templates.find(({ id }) => id === "viggle-animate")!;
    expect(template).toEqual(viggleAnimateTemplate());
    expect(settings.defaultTemplateId).toBe(custom.id);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    expect(template.paths.transformer).toBe("https://huggingface.co/DeepBeepMeep/MiniMax-H3/resolve/main/Viggle-Animate-pruned_rank8_int8_convrot.safetensors");
    expect(templateNeedsDownload(template)).toBe(true);
    template.additionalSafetensors![0].downloadedPath = "D:/weights/conditioning.safetensors";
    template.name = "My animation";
    template.paths = { transformer: "local", textEncoder: "encoder", videoVae: "video", audioVae: "audio", tokenizer: "" };
    saveLoras(loadLoras().map((lora) => lora.id === VIGGLE_ANIMATE_LORA.id ? { ...lora, path: "adapter" } : lora));
    saveGeneratorTemplateSettings({ ...settings, defaultTemplateId: template.id });
    expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === template.id)).toEqual(template);
    const options = engineProviderSetting(loadEngineSettings()).options;
    expect(options).toMatchObject({ generationMode: "animate", stepOverride: 4, promptEmbedding: "D:/weights/conditioning.safetensors" });
    expect(options).not.toHaveProperty("textEncoder");
    expect(options).not.toHaveProperty("tokenizer");
    expect(JSON.parse(options.loras as string)).toEqual([{ path: "adapter", strength: 1 }]);
    expect(engineProviderSetting(custom.paths, { enabled: true, model: null, options }, "sage2", [], "prompt").options).not.toHaveProperty("generationMode");
    expect(engineProviderSetting(custom.paths, { enabled: true, model: null, options }, "sage2", [], "prompt").options).not.toHaveProperty("promptEmbedding");
  });

  it("keeps References on REF2VA for both VRAM tiers", () => {
    const original = minimaxOriginalTemplate();
    const references = minimaxReferencesTemplate();
    const transformer = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    expect(original.name).toBe("First/Last Frame");
    expect(references).toEqual({ ...original, id: "minimax-h3-references", name: "References",
      paths: { ...original.paths, transformer },
      sources: { ...original.sources, transformer: [{ ...original.sources!.transformer![0], url: transformer }, { url: "https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/diffusion_models/minimax_h3_ref2va_hybrid_b20-49_pruned_w4a8_mixed.safetensors", gpuModel: "", minVramGb: 0 }] },
    });
    expect(loadGeneratorTemplateSettings().templates.map(({ name }) => name)).toEqual(["Default", "First/Last Frame", "References", "FastH3 Omni", "Singularity", "Animate", "MOSS Image", "Fibo 2.0 Edit Turbo", "Fibo 2.0 Base", "YuE2", "MiniMax Music3"]);
  });

  it.each(["Minimax H3 Original", "My custom generator"])("migrates the saved %s template without changing its configuration", (name) => {
    const template = minimaxOriginalTemplate();
    template.name = name;
    template.defaultSteps = 12;
    template.attention = "exact";
    template.paths = { transformer: "transformer", textEncoder: "encoder", videoVae: "video", audioVae: "audio", tokenizer: "" };
    template.sources!.transformer![0].downloadedPath = "transformer";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], defaultTemplateId: template.id, catalogVersion: 3 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates[0]).toEqual({ ...template, name: name === "Minimax H3 Original" ? "First/Last Frame" : name });
    expect(settings.templates[1]).toEqual(minimaxReferencesTemplate());
    expect(settings.templates[2]).toEqual(minimaxFastTemplate());
    expect(settings.templates[3]).toEqual(minimaxSingularityTemplate());
    expect(settings.defaultTemplateId).toBe(template.id);
    expect(settings.catalogVersion).toBe(16);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    saveGeneratorTemplateSettings({ ...settings, templates: [settings.templates[0]] });
    expect(loadGeneratorTemplateSettings().templates).toHaveLength(1);
  });

  it("preserves an existing References template during catalog migration", () => {
    const references = minimaxReferencesTemplate();
    references.paths.transformer = "D:/Models/custom.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [references], catalogVersion: 3 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([references, minimaxFastTemplate(), minimaxSingularityTemplate(), viggleAnimateTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
  });

  it("adds Singularity to the previous catalog once while preserving saved templates", () => {
    const custom = createGeneratorTemplate("My generator");
    custom.defaultSteps = 12;
    custom.paths.transformer = "D:/Models/custom.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 4 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates).toEqual([expect.objectContaining(custom), minimaxSingularityTemplate(), viggleAnimateTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(settings.defaultTemplateId).toBe(custom.id);
    expect(settings.catalogVersion).toBe(16);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    saveGeneratorTemplateSettings({ ...settings, templates: [custom] });
    expect(loadGeneratorTemplateSettings().templates).toEqual([expect.objectContaining(custom)]);
  });

  it("preserves a customized Singularity during catalog migration", () => {
    const template = minimaxSingularityTemplate();
    template.defaultSteps = 8;
    template.paths.transformer = "D:/Models/singularity.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 4 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([template, viggleAnimateTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
  });

  it("adds Turbo to saved Singularity once and preserves other adapters and settings", () => {
    const template = minimaxSingularityTemplate();
    template.defaultSteps = 8;
    template.paths = { transformer: "main", textEncoder: "encoder", videoVae: "video", audioVae: "audio", tokenizer: "" };
    template.loras = [{ loraId: "custom", enabled: false, strength: 0.5 }];
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], defaultTemplateId: template.id, catalogVersion: 5 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates).toEqual([{ ...template, loras: [...template.loras, { loraId: TURBO_LORA.id, enabled: true, strength: 1 }] }, viggleAnimateTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(settings.defaultTemplateId).toBe("");
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    saveGeneratorTemplateSettings({ ...settings, templates: [template] });
    expect(loadGeneratorTemplateSettings().templates[0].loras).toEqual(template.loras);
  });

  it("preserves an existing disabled Turbo selection during migration", () => {
    const template = minimaxSingularityTemplate();
    template.loras = [{ loraId: TURBO_LORA.id, enabled: false, strength: 0.3 }];
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 5 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([template, viggleAnimateTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
  });

  it("adds FastH3 Omni with eight steps and its model URLs", () => {
    const original = minimaxOriginalTemplate();
    const fast = minimaxFastTemplate();
    const transformer = "https://huggingface.co/FastVideo/FastH3-Omni-Comfy/resolve/main/diffusion_models/fasth3_omniref_8step_pruned_int8_convrot.safetensors";
    const videoVae = "https://huggingface.co/Comfy-Org/MiniMax-H3/blob/main/vae/minimax_h3_video_vae_int8_convrot.safetensors";
    expect(fast).toEqual({ ...original, id: "minimax-h3-fast", name: "FastH3 Omni", defaultSteps: 8,
      paths: { ...original.paths, transformer, videoVae },
      sources: { ...original.sources, transformer: [{ url: transformer, gpuModel: "", minVramGb: 0 }],
        videoVae: [{ url: videoVae, gpuModel: "", minVramGb: 0 }] },
    });
    saveGeneratorTemplateSettings({ templates: [fast], defaultTemplateId: "", catalogVersion: 4 });
    expect(loadGeneratorTemplateSettings().templates[0].defaultSteps).toBe(8);
  });

  it.each([false, true])("upgrades saved Fast model URLs and invalidates old downloads: %s", (downloaded) => {
    const template = minimaxFastTemplate();
    template.defaultSteps = 6;
    const oldUrls = {
      transformer: "https://huggingface.co/datasets/jacokon/fasth3-live/resolve/main/minimax_h3_fl2va_fasth3_dense_pruned_int8_convrot.safetensors",
      videoVae: minimaxOriginalTemplate().paths.videoVae.replace("/blob/", "/resolve/"),
    };
    for (const field of ["transformer", "videoVae"] as const) {
      const downloadedPath = `D:/Models/old-${field}.safetensors`;
      template.paths[field] = downloaded ? downloadedPath : oldUrls[field];
      template.sources![field]![0] = { ...template.sources![field]![0], url: oldUrls[field],
        ...(downloaded ? { downloadedPath } : {}) };
    }
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 8 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates).toEqual([minimaxFastTemplate(), mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(settings.catalogVersion).toBe(16);
    expect(templateNeedsDownload(settings.templates[0])).toBe(true);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it.each([false, true])("migrates the FastH3 Omni name and transformer without reusing old downloaded weights (downloaded: %s)", (downloaded) => {
    const template = minimaxFastTemplate();
    const oldUrl = "https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy/resolve/main/diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors";
    template.name = "First/Last Frame Fast";
    template.paths.transformer = downloaded ? "D:/weights/fast-old.safetensors" : oldUrl.replace("/resolve/", "/blob/");
    template.sources!.transformer = [{ url: oldUrl.replace("/resolve/", "/blob/"), gpuModel: "RTX 5090", minVramGb: 24,
      ...(downloaded ? { downloadedPath: template.paths.transformer } : {}) }];
    const otherPaths = { ...template.paths };
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 10 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.catalogVersion).toBe(16);
    expect(settings.templates).toHaveLength(5);
    expect(settings.templates[0]).toMatchObject({ id: template.id, name: "FastH3 Omni", defaultSteps: 8,
      paths: { ...otherPaths, transformer: minimaxFastTemplate().paths.transformer },
      sources: { transformer: [{ url: minimaxFastTemplate().paths.transformer, gpuModel: "RTX 5090", minVramGb: 24 }] } });
    expect(settings.templates[0].sources!.transformer![0].downloadedPath).toBeUndefined();
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it.each(["url", "downloaded", "primary", "custom"])("migrates the First/Last Frame fallback from %s without changing other generators", (selection) => {
    const template = minimaxOriginalTemplate();
    const expectedUrl = "https://huggingface.co/Winnougan/MiniMax-H3-INT4_Convrot_ComfyUI/resolve/main/minimax_h3_fl2va_pruned-w4a8_convrot_pruned.safetensors";
    const oldFallback = { ...minimaxReferencesTemplate().sources!.transformer![1], downloadedPath: "D:/weights/ref2va.safetensors" };
    template.sources!.transformer = [template.sources!.transformer![0], oldFallback];
    template.paths.transformer = selection === "url" ? oldFallback.url.replace("/resolve/", "/blob/")
      : selection === "downloaded" ? oldFallback.downloadedPath : selection === "custom" ? "D:/custom.safetensors" : template.paths.transformer;
    const previousPath = template.paths.transformer;
    template.name = "My first/last generator";
    template.defaultSteps = 12;
    const references = minimaxReferencesTemplate(), fast = minimaxFastTemplate();
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template, references, fast], catalogVersion: 12 }));
    const settings = loadGeneratorTemplateSettings();
    const migrated = settings.templates[0];
    expect(migrated.sources!.transformer).toContainEqual({ url: expectedUrl, gpuModel: "", minVramGb: 0 });
    expect(migrated.sources!.transformer!.some((source) => source.url.includes("ref2va") || source.downloadedPath === oldFallback.downloadedPath)).toBe(false);
    expect(migrated.paths.transformer).toBe(selection === "url" || selection === "downloaded" ? expectedUrl : previousPath);
    expect(migrated.name).toBe(template.name);
    expect(migrated.defaultSteps).toBe(12);
    expect(settings.templates.slice(1)).toEqual([references, fast, fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it.each(["url", "downloaded", "cached omni", "custom", "fallback only"])("removes the FastH3 fallback from saved settings using %s", (selection) => {
    const template = minimaxFastTemplate();
    const omniUrl = template.paths.transformer;
    const fallback = { ...minimaxReferencesTemplate().sources!.transformer![1], downloadedPath: "D:/weights/ref2va.safetensors" };
    template.name = "My Omni";
    template.defaultSteps = 12;
    template.paths = { transformer: selection === "url" ? fallback.url.replace("/resolve/", "/blob/") : selection === "custom" ? "D:/custom.safetensors" : fallback.downloadedPath,
      textEncoder: "encoder", videoVae: "video", audioVae: "audio", tokenizer: "" };
    template.sources!.transformer = [
      ...(selection === "fallback only" ? [] : [{ url: omniUrl, gpuModel: "", minVramGb: 21, ...(selection === "cached omni" ? { downloadedPath: "D:/weights/omni.safetensors" } : {}) }]),
      fallback,
      { url: "https://example.com/custom.safetensors", gpuModel: "Custom GPU", minVramGb: 8 },
    ];
    const original = minimaxOriginalTemplate(), references = minimaxReferencesTemplate();
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template, original, references], defaultTemplateId: template.id, catalogVersion: 11 }));
    const settings = loadGeneratorTemplateSettings();
    const migrated = settings.templates[0];
    expect(migrated.name).toBe("My Omni");
    expect(migrated.defaultSteps).toBe(12);
    expect(migrated.sources!.transformer!.map((source) => source.url)).not.toContain(fallback.url);
    expect(migrated.sources!.transformer).toContainEqual(expect.objectContaining({ url: omniUrl, gpuModel: "", minVramGb: 0 }));
    expect(migrated.sources!.transformer).toContainEqual({ url: "https://example.com/custom.safetensors", gpuModel: "Custom GPU", minVramGb: 8 });
    expect(migrated.paths.transformer).toBe(selection === "custom" ? "D:/custom.safetensors" : selection === "cached omni" ? "D:/weights/omni.safetensors" : omniUrl);
    expect(settings.defaultTemplateId).toBe(selection === "custom" || selection === "cached omni" ? template.id : "");
    expect(settings.templates.slice(1)).toEqual([original, references, fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it("preserves custom Fast names, weights, steps and removed templates during the Omni upgrade", () => {
    const template = minimaxFastTemplate();
    template.name = "My fast generator";
    template.defaultSteps = 12;
    template.paths.transformer = "D:/custom/model.safetensors";
    template.sources!.transformer = [{ url: "https://example.com/custom.safetensors", downloadedPath: template.paths.transformer, gpuModel: "", minVramGb: 0 }];
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 10 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([template, fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    const other = createGeneratorTemplate("Custom");
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [other], defaultTemplateId: other.id, catalogVersion: 10 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates).toEqual([expect.objectContaining(other), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    expect(settings.defaultTemplateId).toBe(other.id);
  });

  it("preserves customized Fast models and steps, and does not restore a removed template", () => {
    const template = minimaxFastTemplate();
    template.defaultSteps = 12;
    template.paths.transformer = "D:/Models/custom-transformer.safetensors";
    template.paths.videoVae = "https://example.com/custom-vae.safetensors";
    template.sources = { ...template.sources, videoVae: [{ url: template.paths.videoVae, gpuModel: "", minVramGb: 0 }] };
    delete template.sources.transformer;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 8 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([template, mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
    const original = minimaxOriginalTemplate();
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [original], catalogVersion: 8 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([original, mossImageTemplate(), fiboImageTemplate(), fiboBaseTemplate(), ...musicTemplates()]);
  });

  it.each(["textEncoder", "transformer"] as const)("upgrades saved Minimax %s variants once and preserves downloaded weights", (field) => {
    const template = minimaxOriginalTemplate();
    const downloadedPath = "D:/Models/encoder.safetensors";
    template.sources![field] = [{ url: template.paths[field], gpuModel: "", minVramGb: 0, downloadedPath }];
    template.paths[field] = downloadedPath;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 1 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.catalogVersion).toBe(16);
    expect(settings.templates[0].paths[field]).toBe(downloadedPath);
    expect(settings.templates[0].sources![field]).toEqual(minimaxOriginalTemplate().sources![field]!.map((source, index) =>
      index === 0 ? { ...source, downloadedPath } : source));
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it.each(["textEncoder", "transformer"] as const)("preserves custom Minimax %s variants and does not restore a removed catalog template", (field) => {
    const template = minimaxOriginalTemplate();
    template.paths[field] = "https://example.com/custom.safetensors";
    template.sources![field] = [{ url: template.paths[field], gpuModel: "", minVramGb: 0 }];
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 1 }));
    expect(loadGeneratorTemplateSettings().templates[0].sources![field]).toEqual(template.sources![field]);
    const custom = createGeneratorTemplate();
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [custom], catalogVersion: 1 }));
    expect(loadGeneratorTemplateSettings().templates.map(({ id }) => id)).toEqual([custom.id, "minimax-h3-references", "minimax-h3-fast", "minimax-h3-singularity", "viggle-animate", "moss-image", "fibo2-edit-turbo", "fibo2-base", "yue2", "minimax_music3"]);
  });

  it.each(["url", "downloaded", "original", "custom", "cached original"])("removes the incompatible encoder from saved templates using %s", (selection) => {
    const template = minimaxOriginalTemplate();
    const originalUrl = template.paths.textEncoder;
    const removedUrl = "https://huggingface.co/Merserk/qwen3vl-4b-int4-convrot/resolve/main/qwen3vl_4b_int4_convrot.safetensors";
    const downloadedPath = "D:/Models/qwen3vl_4b_int4_convrot.safetensors";
    const cachedOriginal = "D:/Models/original.safetensors";
    const custom = { url: "https://example.com/custom.safetensors", gpuModel: "RTX", minVramGb: 8 };
    template.sources!.textEncoder = [
      { url: originalUrl, gpuModel: "", minVramGb: 13, ...(selection === "cached original" ? { downloadedPath: cachedOriginal } : {}) },
      { url: removedUrl, gpuModel: "", minVramGb: 0, downloadedPath },
      custom,
    ];
    template.paths = { transformer: "transformer", videoVae: "video", audioVae: "audio", tokenizer: "",
      textEncoder: selection === "url" ? removedUrl : selection === "original" ? cachedOriginal : selection === "custom" ? "D:/Models/custom.safetensors" : downloadedPath };
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], defaultTemplateId: template.id, catalogVersion: 2 }));
    const settings = loadGeneratorTemplateSettings();
    const migrated = settings.templates[0];
    expect(settings.catalogVersion).toBe(16);
    expect(migrated.sources!.textEncoder).toEqual([
      { url: originalUrl, gpuModel: "", minVramGb: 0, ...(selection === "cached original" ? { downloadedPath: cachedOriginal } : {}) },
      custom,
    ]);
    expect(migrated.paths.textEncoder).toBe(selection === "url" || selection === "downloaded" ? originalUrl
      : selection === "custom" ? "D:/Models/custom.safetensors" : cachedOriginal);
    expect(templateNeedsDownload(migrated)).toBe(selection === "url" || selection === "downloaded");
    expect(settings.defaultTemplateId).toBe(templateNeedsDownload(migrated) ? "" : template.id);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
  });

  it("restores the original encoder when only the removed URL was saved", () => {
    const template = minimaxOriginalTemplate();
    const originalUrl = template.paths.textEncoder;
    template.paths.textEncoder = "https://huggingface.co/Merserk/qwen3vl-4b-int4-convrot/resolve/main/qwen3vl_4b_int4_convrot.safetensors";
    delete template.sources!.textEncoder;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 2 }));
    const migrated = loadGeneratorTemplateSettings().templates[0];
    expect(migrated.paths.textEncoder).toBe(originalUrl);
    expect(migrated.sources!.textEncoder).toEqual(minimaxOriginalTemplate().sources!.textEncoder);
  });

  it("passes the default generator's attention and machine backend to the engine", () => {
    const template = createGeneratorTemplate();
    expect(template.attention).toBe("sage2");
    expect(loadInferenceBackend()).toBe("cuda");
    for (const attention of ["exact", "flash2", "sage2", "sol"] as const) {
      template.attention = attention;
      saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id });
      for (const inferenceBackend of ["cuda", "vulkan"] as const) {
        saveInferenceBackend(inferenceBackend);
        expect(engineProviderSetting(loadEngineSettings()).options).toMatchObject({ attention, inferenceBackend });
      }
    }
  });

  it("uses the selected default template for engine paths and step defaults", () => {
    const fast = createGeneratorTemplate("Fast draft");
    fast.defaultSteps = 8;
    fast.paths.transformer = "D:\\Models\\fast.safetensors";
    saveGeneratorTemplateSettings({ templates: [createGeneratorTemplate("Quality"), fast], defaultTemplateId: fast.id });

    expect(loadEngineSettings().transformer).toBe("D:\\Models\\fast.safetensors");
    expect(loadDefaultGenerationSteps()).toBe(8);
  });
});

describe("machine prompt LLM settings", () => {
  beforeEach(() => localStorage.clear());

  it("only exposes endpoint providers after their required settings are complete", () => {
    const settings = loadAgentEndpointSettings();
    expect(agentEndpointProviderSettings()).toEqual({});

    settings.openrouter.model = "openai/gpt-test";
    saveAgentEndpointSettings(settings);
    expect(agentEndpointProviderSettings()).toEqual({});

    settings.openrouter.apiKey = "sk-or-test";
    saveAgentEndpointSettings(settings);
    expect(agentEndpointProviderSettings().openrouter).toMatchObject({
      enabled: true,
      model: "openai/gpt-test",
      options: { endpoint: "https://openrouter.ai/api/v1", apiKey: "sk-or-test" },
    });

    settings.local = { endpoint: "http://localhost:1234/v1", apiKey: "", model: "local-model" };
    saveAgentEndpointSettings(settings);
    expect(agentEndpointProviderSettings().local).toMatchObject({
      model: "local-model",
      options: { endpoint: "http://localhost:1234/v1" },
    });
  });
});

it("adds Base once and persists per-template editing through runtime options", () => {
  const edit = fiboImageTemplate();
  edit.defaultSteps = 8;
  saveGeneratorTemplateSettings({ templates: [edit], defaultTemplateId: "", catalogVersion: 14 });
  const migrated = loadGeneratorTemplateSettings();
  expect(migrated.templates).toEqual([edit, fiboBaseTemplate(), ...musicTemplates()]);
  expect(loadGeneratorTemplateSettings()).toEqual(migrated);
  const base = migrated.templates[1];
  expect(base.name).toBe("Fibo 2.0 Base");
  expect(base.paths.transformer).toBe("https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/diffusion_models/fibo2_dev_int8_convrot.safetensors");
  expect(base.sources!.transformer![0].url).toBe(base.paths.transformer);
  expect(base.paths.textEncoder).toBe(edit.paths.textEncoder);
  expect(base.paths.videoVae).toBe(edit.paths.videoVae);
  expect(templateSupportsEditing(base)).toBe(false);
  expect(templateSupportsOutpainting(base)).toBe(false);
  expect(templateSupportsOutpainting(edit)).toBe(true);
  expect(templateSupportsEditing({ ...edit, editingModel: false })).toBe(false);
  expect(templateSupportsEditing({ ...mossImageTemplate(), editingModel: true })).toBe(false);
  expect(templateSupportsEditing({ ...edit, editingModel: undefined })).toBe(true);
  const provider = engineProviderSetting(base.paths, undefined, base.attention, [], "prompt", [], false, base.sources, base);
  expect(provider.options.editingModel).toBe(false);
  saveGeneratorTemplateSettings({ ...migrated, templates: [{ ...edit, editingModel: false }] });
  expect(loadGeneratorTemplateSettings().templates).toEqual([{ ...edit, editingModel: false }]);
});
