// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadLoras, saveLoras, TAOMATE_LORA } from "./loras";
import { createGeneratorTemplate, engineProviderSetting, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, withEngineSettings } from "./settings";
import { createProjectConfig } from "./project";

beforeEach(() => localStorage.clear());

it("starts with only TaoMate and preserves the local library", () => {
  expect(loadLoras()).toEqual([TAOMATE_LORA]);
  saveLoras([{ ...TAOMATE_LORA, path: "C:/weights/TaoMate.safetensors" }, { id: "style", name: "Style", path: "D:/style.safetensors" }]);
  expect(loadLoras().map(({ name }) => name)).toEqual(["TaoMate 3-Step", "Style"]);
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
  expect(runtime.providerSettings.slopfab.options.schedule).toBe("taomate-3step");
  expect(config.providerSettings).toEqual({});
  const without = engineProviderSetting(template.paths, runtime.providerSettings.slopfab, "sage2", []);
  expect(without.options).not.toHaveProperty("loras");
  expect(without.options).not.toHaveProperty("schedule");
});

it("does not silently generate without an active missing adapter", () => {
  const template = createGeneratorTemplate();
  expect(() => engineProviderSetting(template.paths, undefined, "sage2", [{ loraId: TAOMATE_LORA.id, enabled: true, strength: 1 }])).toThrow("Download or locate LoRA TaoMate 3-Step");
  expect(engineProviderSetting(template.paths, undefined, "sage2", [{ loraId: TAOMATE_LORA.id, enabled: true, strength: 0 }]).options).not.toHaveProperty("loras");
});
