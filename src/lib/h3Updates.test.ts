// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { loadLoras, PI_H3_LORAS, saveLoras } from "./loras";
import { engineProviderSetting, loadGeneratorTemplateSettings, newH3Templates, saveGeneratorTemplateSettings, templateSamplingOptions, templateSupportsImages } from "./settings";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, projectReferenceSchema, sceneGenerationSnapshot } from "./project";
import { sceneGenerationRequest, sendBlocker, templateSceneBlocker } from "./sceneGeneration";
import { portableGenerator } from "./slop";

beforeEach(() => localStorage.clear());
const project = () => createProjectConfig({ name: "H3", prompt: "A robot waves", resolution: "544p", aspectRatio: "16:9", targetDurationSeconds: 5 });
const picture = (id: string) => projectReferenceSchema.parse({ id, name: id, description: "", createdAt: new Date().toISOString(), kind: "image", relativePath: `references/${id}.png` });

it("adds the five new templates once and preserves removals and the selected default", () => {
  const initial = loadGeneratorTemplateSettings();
  const ids = new Set(newH3Templates().map((entry) => entry.id));
  saveGeneratorTemplateSettings({ ...initial, catalogVersion: 23, templates: initial.templates.filter((entry) => !ids.has(entry.id)) });
  const upgraded = loadGeneratorTemplateSettings();
  expect(upgraded.catalogVersion).toBe(24);
  expect(upgraded.defaultTemplateId).toBe(initial.defaultTemplateId);
  expect(upgraded.templates.filter((entry) => ids.has(entry.id))).toHaveLength(5);
  saveGeneratorTemplateSettings({ ...upgraded, templates: upgraded.templates.filter((entry) => !ids.has(entry.id)) });
  expect(loadGeneratorTemplateSettings().templates.some((entry) => ids.has(entry.id))).toBe(false);
});

it("ships both requested DWD download URLs and preserves their recipes in portable templates", () => {
  expect(PI_H3_LORAS.map((entry) => entry.url)).toEqual([
    "https://huggingface.co/Lakonik/pi-H3/resolve/main/pi_h3_2step_dwd_adapter_int8_convrot.safetensors",
    "https://huggingface.co/Lakonik/pi-H3/resolve/main/pi_h3_4step_dwd_adapter_int8_convrot.safetensors",
  ]);
  for (const template of newH3Templates().filter((entry) => entry.mode === "pi-h3")) {
    const portable = portableGenerator(template);
    expect(portable.mode).toBe("pi-h3");
    expect(portable.loras[0]).toMatchObject({ strength: 1, stepOverride: template.defaultSteps });
    expect(templateSamplingOptions(template)).toMatchObject({ samplers: ["default", "euler"], schedulers: ["default"] });
    expect(templateSupportsImages(template)).toBe(false);
    expect(templateSceneBlocker("continue", template)).toContain("pi-H3");
  }
});

it("sends the new mode and update counts without changing old template semantics", () => {
  saveLoras(loadLoras().map((entry) => ({ ...entry, path: `C:/weights/${entry.id}.safetensors` })));
  for (const template of newH3Templates()) {
    const provider = engineProviderSetting(template.paths, undefined, template.attention, template.loras ?? [], template.mode, [], true, template.sources, template);
    expect(provider.options.generationMode).toBe(template.mode);
    if (template.mode !== "h3-hybrid") {
      expect(provider.options.motionCache).toBeUndefined();
      expect(provider.options.previewVae).toBeUndefined();
    }
  }
});

it("maps last-only and shared endpoint images to portable native anchor indices", () => {
  const config = project();
  config.references = [picture("end"), picture("start")];
  const job = createDraftGenerationJob("A robot waves", { sceneType: "first-last-frame", endFrameReferenceId: "end" });
  const last = sceneGenerationRequest(job, config, "C:/project", 20);
  expect(last.startAnchorIndex).toBeUndefined();
  expect(last.endAnchorIndex).toBe(0);
  job.startFrameReferenceId = "end";
  const both = sceneGenerationRequest(job, config, "C:/project", 20);
  expect(both.referencePaths).toHaveLength(1);
  expect([both.startAnchorIndex, both.endAnchorIndex]).toEqual([0, 0]);
  expect(sceneGenerationSnapshot(job, both)).not.toBe(sceneGenerationSnapshot(job, last));
});

it("persists Remake pins, compiles six sections, and validates the selected source duration", () => {
  const config = project();
  config.references = [picture("painted"), projectReferenceSchema.parse({ id: "source", name: "Source", description: "", createdAt: new Date().toISOString(), kind: "video", relativePath: "references/source.mp4", video: { startSeconds: 0, durationSeconds: 6, includeAudio: true } })];
  const job = createDraftGenerationJob("A blue robot waves", { sceneType: "remake", durationSeconds: 5 });
  job.referenceIds = ["source", "painted"];
  job.steps = 12; job.remakePins = [60]; job.remakeKeyframeUntil = 0.85;
  config.generationJobs = [job];
  const restored = parseProjectConfig(config).generationJobs[0];
  expect(restored.remakePins).toEqual([60]);
  expect(sendBlocker(restored, config.references)).toBeNull();
  const request = sceneGenerationRequest(restored, config, "C:/project", 12, newH3Templates().find((entry) => entry.mode === "remake-swap"));
  expect(request).toMatchObject({ steps: 12, remakePins: [60], remakeKeyframeUntil: 0.85 });
  const sections = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"];
  expect(sections.map((section) => request.prompt.indexOf(`${section}:`))).toEqual([...sections.map((section) => request.prompt.indexOf(`${section}:`))].sort((a, b) => a - b));
  expect(sections.every((section) => request.prompt.includes(`${section}:`))).toBe(true);
  expect(sendBlocker({ ...restored, remakePins: [120] }, config.references)).toContain("timeline frame");
});
