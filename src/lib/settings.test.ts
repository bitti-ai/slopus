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
  saveAgentEndpointSettings,
  saveGeneratorTemplateSettings,
} from "./settings";

describe("generator templates", () => {
  beforeEach(() => localStorage.clear());

  it("migrates the former flat engine paths into the Default template", () => {
    localStorage.setItem("slopus.engine-paths.v1", JSON.stringify({ transformer: "D:\\Models\\main.safetensors" }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.defaultTemplateId).toBe("default");
    expect(settings.templates).toHaveLength(2);
    expect(settings.templates[1].name).toBe("Minimax H3 Original");
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

  it.each(["textEncoder", "transformer"] as const)("upgrades saved Minimax %s variants once and preserves downloaded weights", (field) => {
    const template = minimaxOriginalTemplate();
    const downloadedPath = "D:/Models/encoder.safetensors";
    template.sources![field] = [{ url: template.paths[field], gpuModel: "", minVramGb: 0, downloadedPath }];
    template.paths[field] = downloadedPath;
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], catalogVersion: 1 }));
    const settings = loadGeneratorTemplateSettings();
    expect(settings.catalogVersion).toBe(2);
    expect(settings.templates[0].paths[field]).toBe(downloadedPath);
    expect(settings.templates[0].sources![field]).toEqual([
      { ...minimaxOriginalTemplate().sources![field]![0], downloadedPath },
      minimaxOriginalTemplate().sources![field]![1],
    ]);
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
    expect(loadGeneratorTemplateSettings().templates.map(({ id }) => id)).toEqual([custom.id]);
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
