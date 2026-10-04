// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importGeneratorSlop, MAX_SLOP_BYTES, mergeGeneratorSlop, parseGeneratorSlop, portableGenerator, serializeGeneratorSlop } from "./slop";
import { createGeneratorTemplate, loadGeneratorTemplateSettings, minimaxOriginalTemplate, minimaxSingularityTemplate, saveGeneratorTemplateSettings, viggleAnimateTemplate } from "./settings";
import { loadLoras, saveLoras, TURBO_LORA } from "./loras";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("portable generator bundles", () => {
  it("exports downloaded weights as URL variants, keeping metadata and dropping all machine state", () => {
    const template = minimaxOriginalTemplate();
    template.paths.transformer = "C:/private/person/model.safetensors";
    template.sources!.transformer![0].downloadedPath = template.paths.transformer;
    template.additionalSafetensors = [{ id: "local-extra", name: "Extra", url: "https://example.com/extra.safetensors", downloadedPath: "C:/private/extra.safetensors" }];
    template.loras = [{ loraId: "private-lora-id", enabled: true, strength: .75 }];
    const text = serializeGeneratorSlop([template], [{ id: "private-lora-id", name: "Custom", path: "C:/private/lora.safetensors", url: "https://example.com/lora.safetensors", stepOverride: 6, needsPreparation: true }]);
    expect(text).not.toMatch(/C:\/private|downloadedPath|needsPreparation|private-lora-id|local-extra|"paths"/);
    const data = parseGeneratorSlop(text).items[0].data;
    expect(data.sources.transformer).toEqual(template.sources!.transformer!.map(({ downloadedPath: _path, ...source }) => source));
    expect(data.loras).toEqual([{ name: "Custom", url: "https://example.com/lora.safetensors", enabled: true, strength: .75, stepOverride: 6 }]);
    expect(data.additionalSafetensors).toEqual([{ name: "Extra", url: "https://example.com/extra.safetensors" }]);
  });
  it("round trips prompt, accelerated and Animate templates including LoRA recipes and conditioning", () => {
    const templates = [minimaxOriginalTemplate(), minimaxSingularityTemplate(), viggleAnimateTemplate()];
    templates[0].motionCache = true;
    const bundle = parseGeneratorSlop(serializeGeneratorSlop(templates));
    const current = { templates: [createGeneratorTemplate("Existing")], defaultTemplateId: "existing", catalogVersion: 9 };
    const merged = mergeGeneratorSlop(bundle, current, loadLoras());
    expect(merged.settings.defaultTemplateId).toBe("existing");
    expect(merged.settings.templates[0]).toBe(current.templates[0]);
    expect(merged.imported.map((item) => portableGenerator(item, merged.loras))).toEqual(bundle.items.map(({ data }) => data));
    expect(merged.imported[2].additionalSafetensors![0].role).toBe("promptEmbedding");
    expect(merged.imported[1].loras![0].loraId).toBe(TURBO_LORA.id);
  });
  it("does not silently share missing local files or unresolvable LoRAs", () => {
    const local = minimaxOriginalTemplate(); local.paths.tokenizer = "C:/private/tokenizer";
    expect(() => portableGenerator(local)).toThrow(/Tokenizer/);
    const missing = createGeneratorTemplate("Empty");
    expect(() => portableGenerator(missing)).toThrow(/download URL/);
    const lora = minimaxOriginalTemplate(); lora.loras = [{ loraId: "unknown", enabled: false, strength: 0 }];
    expect(() => portableGenerator(lora, [])).toThrow(/unknown/);
  });
  it("adds fresh template IDs and conflict-free names, reusing matching LoRAs without changing them", () => {
    const template = minimaxSingularityTemplate();
    const existingLora = { ...TURBO_LORA, path: "D:/downloaded.safetensors" };
    const current = { templates: [template, { ...template, id: "other", name: `${template.name} (2)` }], defaultTemplateId: template.id, catalogVersion: 9 };
    const result = mergeGeneratorSlop(parseGeneratorSlop(serializeGeneratorSlop([template, template], [existingLora])), current, [existingLora]);
    expect(result.imported.map((t) => t.name)).toEqual([`${template.name} (3)`, `${template.name} (4)`]);
    expect(new Set(result.settings.templates.map((t) => t.id)).size).toBe(4);
    expect(result.loras).toEqual([existingLora]);
    expect(result.settings.defaultTemplateId).toBe(template.id);
  });
  it("imports custom LoRAs with distinct recipes and preserves unrelated settings", () => {
    const template = minimaxOriginalTemplate(); template.loras = [{ loraId: "custom", enabled: true, strength: 1.25 }];
    const lora = { id: "custom", name: "My adapter", path: "", url: "https://example.com/lora", samplingPreset: "dmad-4step" as const };
    const text = serializeGeneratorSlop([template], [lora]);
    saveLoras([{ ...lora, samplingPreset: undefined, path: "D:/different-recipe.safetensors" }]);
    localStorage.setItem("slopus.test-secret", "private");
    const before = loadGeneratorTemplateSettings();
    const [imported] = importGeneratorSlop(text);
    const reopened = loadGeneratorTemplateSettings();
    expect(reopened.templates).toHaveLength(before.templates.length + 1);
    expect(reopened.defaultTemplateId).toBe(before.defaultTemplateId);
    expect(localStorage.getItem("slopus.test-secret")).toBe("private");
    expect(loadLoras().find((entry) => entry.id === imported.loras![0].loraId)).toMatchObject({ url: lora.url, path: "", samplingPreset: "dmad-4step" });
    expect(imported.loras![0].loraId).not.toBe("custom");
  });
  it("reports storage errors and rolls back newly added LoRAs", () => {
    const template = minimaxOriginalTemplate(); template.loras = [{ loraId: "new", enabled: true, strength: 1 }];
    const text = serializeGeneratorSlop([template], [{ id: "new", name: "New", path: "", url: "https://example.com/new" }]);
    saveGeneratorTemplateSettings(loadGeneratorTemplateSettings());
    const before = loadGeneratorTemplateSettings();
    const loras = loadLoras(); const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "slopus.generator-templates.v1") throw new Error("Storage full");
      setItem.call(this, key, value);
    });
    expect(() => importGeneratorSlop(text)).toThrow("Storage full");
    expect(loadLoras()).toEqual(loras);
    expect(loadGeneratorTemplateSettings()).toEqual(before);
  });
  it("preserves separate LoRA selections even when they share a URL and recipe", () => {
    const template = minimaxOriginalTemplate();
    template.loras = [{ loraId: "a", enabled: true, strength: .5 }, { loraId: "b", enabled: true, strength: .75 }];
    const library = ["a", "b"].map((id) => ({ id, name: id, path: "", url: "https://example.com/adapter" }));
    const [imported] = importGeneratorSlop(serializeGeneratorSlop([template], library));
    const reopened = loadGeneratorTemplateSettings().templates.find(({ id }) => id === imported.id)!;
    expect(reopened.loras?.map(({ strength }) => strength)).toEqual([.5, .75]);
    expect(new Set(reopened.loras?.map(({ loraId }) => loraId)).size).toBe(2);
  });
});

describe("slop validation", () => {
  const valid = () => JSON.parse(serializeGeneratorSlop([minimaxOriginalTemplate()]));
  it("supports a UTF-8 BOM and rejects invalid, empty and oversized documents", () => {
    expect(parseGeneratorSlop("\uFEFF" + JSON.stringify(valid())).items).toHaveLength(1);
    for (const text of ["{", "null", "[]", "{}", '{"format":"slop","version":1,"items":[]}']) expect(() => parseGeneratorSlop(text)).toThrow();
    expect(() => parseGeneratorSlop(" ".repeat(MAX_SLOP_BYTES + 1))).toThrow(/4 MB/);
    expect(() => serializeGeneratorSlop([])).toThrow(/Choose/);
  });
  it.each([
    (bundle: ReturnType<typeof valid>) => { bundle.version = 2; },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].version = 2; },
    (bundle: ReturnType<typeof valid>) => { bundle.items.push({ type: "project-template", version: 1, data: {} }); },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].data.sources.transformer[0].url = "file:///C:/private/model"; },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].data.sources.transformer[0].url = "https://user:secret@example.com/model"; },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].data.sources.transformer[0].downloadedPath = "C:/private/model"; },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].data.defaultSteps = 0; },
    (bundle: ReturnType<typeof valid>) => { delete bundle.items[0].data.sources.audioVae; },
    (bundle: ReturnType<typeof valid>) => { bundle.items[0].data.mode = "animate"; },
  ])("refuses the entire import without changing settings", (invalidate) => {
    const bundle = valid(); invalidate(bundle);
    const settings = loadGeneratorTemplateSettings(), loras = loadLoras();
    expect(() => importGeneratorSlop(JSON.stringify(bundle))).toThrow();
    expect(loadGeneratorTemplateSettings()).toEqual(settings); expect(loadLoras()).toEqual(loras);
  });
});
