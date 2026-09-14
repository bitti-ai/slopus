// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  agentEndpointProviderSettings,
  createGeneratorTemplate,
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
  templateNeedsDownload,
  saveAgentEndpointSettings,
  saveGeneratorTemplateSettings,
} from "./settings";

describe("generator templates", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the former flat engine paths into the Default template", () => {
    localStorage.setItem("slopus.engine-paths.v1", JSON.stringify({ transformer: "D:\\Models\\main.safetensors" }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.defaultTemplateId).toBe("default");
    expect(settings.templates).toHaveLength(5);
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

  it("adds References with the same settings and VRAM variants except for the main transformer URL", () => {
    const original = minimaxOriginalTemplate();
    const references = minimaxReferencesTemplate();
    const transformer = "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors";
    expect(original.name).toBe("First/Last Frame");
    expect(references).toEqual({ ...original, id: "minimax-h3-references", name: "References",
      paths: { ...original.paths, transformer },
      sources: { ...original.sources, transformer: [{ ...original.sources!.transformer![0], url: transformer }, original.sources!.transformer![1]] },
    });
    expect(loadGeneratorTemplateSettings().templates.map(({ name }) => name)).toEqual(["Default", "First/Last Frame", "References", "First/Last Frame Fast", "Singularity"]);
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
    expect(settings.catalogVersion).toBe(5);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    saveGeneratorTemplateSettings({ ...settings, templates: [settings.templates[0]] });
    expect(loadGeneratorTemplateSettings().templates).toHaveLength(1);
  });

  it("preserves an existing References template during catalog migration", () => {
    const references = minimaxReferencesTemplate();
    references.paths.transformer = "D:/Models/custom.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [references], catalogVersion: 3 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([references, minimaxFastTemplate(), minimaxSingularityTemplate()]);
  });

  it("adds Singularity to the previous catalog once while preserving saved templates", () => {
    const custom = createGeneratorTemplate("My generator");
    custom.defaultSteps = 12;
    custom.paths.transformer = "D:/Models/custom.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [custom], defaultTemplateId: custom.id, catalogVersion: 4 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.templates).toEqual([expect.objectContaining(custom), minimaxSingularityTemplate()]);
    expect(settings.defaultTemplateId).toBe(custom.id);
    expect(settings.catalogVersion).toBe(5);
    expect(loadGeneratorTemplateSettings()).toEqual(settings);
    saveGeneratorTemplateSettings({ ...settings, templates: [custom] });
    expect(loadGeneratorTemplateSettings().templates).toEqual([expect.objectContaining(custom)]);
  });

  it("preserves a customized Singularity during catalog migration", () => {
    const template = minimaxSingularityTemplate();
    template.defaultSteps = 8;
    template.paths.transformer = "D:/Models/singularity.safetensors";
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 4 }));
    expect(loadGeneratorTemplateSettings().templates).toEqual([template]);
  });

  it("adds First/Last Frame Fast with six steps and its transformer URL", () => {
    const original = minimaxOriginalTemplate();
    const fast = minimaxFastTemplate();
    const transformer = "https://huggingface.co/datasets/jacokon/fasth3-live/resolve/main/minimax_h3_fl2va_fasth3_dense_pruned_int8_convrot.safetensors";
    expect(fast).toEqual({ ...original, id: "minimax-h3-fast", name: "First/Last Frame Fast", defaultSteps: 6,
      paths: { ...original.paths, transformer },
      sources: { ...original.sources, transformer: [{ ...original.sources!.transformer![0], url: transformer }, original.sources!.transformer![1]] },
    });
    saveGeneratorTemplateSettings({ templates: [fast], defaultTemplateId: "", catalogVersion: 4 });
    expect(loadGeneratorTemplateSettings().templates[0].defaultSteps).toBe(6);
  });

  it.each(["textEncoder", "transformer"] as const)("upgrades saved Minimax %s variants once and preserves downloaded weights", (field) => {
    const template = minimaxOriginalTemplate();
    const downloadedPath = "D:/Models/encoder.safetensors";
    template.sources![field] = [{ url: template.paths[field], gpuModel: "", minVramGb: 0, downloadedPath }];
    template.paths[field] = downloadedPath;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 1 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.catalogVersion).toBe(5);
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
    expect(loadGeneratorTemplateSettings().templates.map(({ id }) => id)).toEqual([custom.id, "minimax-h3-references", "minimax-h3-fast", "minimax-h3-singularity"]);
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
    expect(settings.catalogVersion).toBe(5);
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
    for (const attention of ["exact", "flash2", "sage2"] as const) {
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
