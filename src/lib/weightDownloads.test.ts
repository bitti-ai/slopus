// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { chooseWeightSource, downloadTemplateWeights, getWeightDownloadState, refreshDownloadedWeights, removeTemplateWeights, updateWeightPath, weightDownloadProgress, type DownloadState } from "./weightDownloads";
import { createGeneratorTemplate, defaultGeneratorTemplate, isDownloadUrl, loadGeneratorTemplateSettings, minimaxOriginalTemplate, saveGeneratorTemplateSettings, templateNeedsDownload, type WeightSource } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./persistence", () => ({ isTauri: () => true }));
const files = new Set<string>();
const source = (url: string, gpuModel = "", minVramGb = 0): WeightSource => ({ url, gpuModel, minVramGb });
const saved = () => loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")!;

it("keeps overall progress continuous across files and below 100 until completion", () => {
  const download: DownloadState = { templateId: "sample", field: "transformer", downloaded: 100, total: 100, completed: 0, files: 4, active: true, error: null };
  expect(weightDownloadProgress(download)).toBe(25);
  expect(weightDownloadProgress({ ...download, completed: 1, field: null, downloaded: 0, total: null })).toBe(25);
  expect(weightDownloadProgress({ ...download, completed: 1, downloaded: 50 })).toBe(37.5);
  expect(weightDownloadProgress({ ...download, completed: 1, total: null })).toBe(25);
  expect(weightDownloadProgress({ ...download, files: 0 })).toBe(0);
  expect(weightDownloadProgress({ ...download, completed: 3 })).toBe(99);
  expect(weightDownloadProgress({ ...download, completed: 4, field: null, active: false })).toBe(100);
});

beforeEach(() => {
  localStorage.clear(); files.clear(); vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "weight_download_hardware") return [{ name: "NVIDIA GeForce RTX 5090", memoryBytes: 32 * 1024 ** 3 }];
    if (command === "check_weight_files") return Object.fromEntries((args as { paths: string[] }).paths.map((path) => [path, files.has(path)]));
    if (command === "remove_downloaded_weights") { for (const path of (args as { paths: string[] }).paths) files.delete(path); return; }
    if (command === "download_weight") {
      const path = `C:/Slopus/weights/${(args as { url: string }).url.split('/').at(-1)}`;
      files.add(path); return path;
    }
  });
});

it("chooses a matching GPU variant and the largest VRAM tier that fits", () => {
  const generic = source("https://example.com/small"), large = source("https://example.com/large", "", 24);
  const specific = source("https://example.com/5090", "RTX 5090", 32);
  const oversized = source("https://example.com/huge", "RTX 5090", 48);
  const variants = [generic, large, specific, oversized];
  expect(chooseWeightSource(variants, [{ name: "NVIDIA GeForce RTX 5090", memoryBytes: 32 * 1024 ** 3 }])).toBe(specific);
  expect(chooseWeightSource(variants, [{ name: "NVIDIA GeForce RTX 5090", memoryBytes: 33753661440 }])).toBe(specific);
  expect(chooseWeightSource(variants, [{ name: "NVIDIA GeForce RTX 4090", memoryBytes: 24 * 1024 ** 3 }])).toBe(large);
  expect(chooseWeightSource(variants, [{ name: "AMD Radeon RX 7600", memoryBytes: 8 * 1024 ** 3 }])).toBe(generic);
  expect(chooseWeightSource(variants, [])).toBe(generic);
  expect(chooseWeightSource([specific], [{ name: "RTX 3090", memoryBytes: 24 * 1024 ** 3 }])).toBeNull();
});

it("preserves the sample links and prevents an unfinished template from being the default", () => {
  const sample = minimaxOriginalTemplate();
  saveGeneratorTemplateSettings({ templates: [sample], defaultTemplateId: sample.id, catalogVersion: 1 });
  expect(templateNeedsDownload(saved())).toBe(true);
  expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("");
  expect(defaultGeneratorTemplate().id).toBe("");
  expect(Object.values(saved().sources ?? {}).flat()).toHaveLength(4);
});

it("replaces a URL being typed instead of accumulating partial download sources", () => {
  let template = createGeneratorTemplate();
  for (const value of ["https://", "https://e", "https://example.com/model"]) template = updateWeightPath(template, "transformer", value);
  expect(template.sources?.transformer).toEqual([source("https://example.com/model")]);
});

it("downloads all sample weights, saves local paths, and restores a deleted weight's URL", async () => {
  await downloadTemplateWeights("minimax-h3-original");
  const template = saved();
  expect(templateNeedsDownload(template)).toBe(false);
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 4, files: 4, error: null });
  const url = template.sources!.transformer![0].url;
  expect(template.paths.transformer).toMatch(/^C:\/Slopus\/weights\//);
  saveGeneratorTemplateSettings({ ...loadGeneratorTemplateSettings(), defaultTemplateId: template.id });
  files.delete(template.paths.transformer);
  await refreshDownloadedWeights();
  expect(saved().paths.transformer).toBe(url);
  expect(saved().sources!.transformer![0].downloadedPath).toBeUndefined();
  expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("default");
  vi.mocked(invoke).mockClear();
  await downloadTemplateWeights(template.id);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight")).toHaveLength(1);
  expect(templateNeedsDownload(saved())).toBe(false);
});

it("removes downloaded files while retaining the template and original URLs", async () => {
  await downloadTemplateWeights("minimax-h3-original");
  await removeTemplateWeights("minimax-h3-original");
  expect(files.size).toBe(0);
  expect(saved().paths).toEqual(minimaxOriginalTemplate().paths);
  expect(Object.values(saved().sources ?? {}).flat().every((source) => !source.downloadedPath)).toBe(true);
  expect(templateNeedsDownload(saved())).toBe(true);
  await downloadTemplateWeights("minimax-h3-original");
  expect(templateNeedsDownload(saved())).toBe(false);
});

it("never sends a manually selected local file to the removal command", async () => {
  const template = minimaxOriginalTemplate();
  template.paths.transformer = "D:/MyModels/personal.safetensors";
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: "", catalogVersion: 1 });
  await removeTemplateWeights(template.id);
  expect(invoke).toHaveBeenCalledWith("remove_downloaded_weights", { paths: [] });
  expect(saved().paths.transformer).toBe(minimaxOriginalTemplate().paths.transformer);
});

it("retains successful files when a later download fails and retries only unfinished weights", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "download_weight" && ++attempts === 2) throw new Error("Network lost");
    return original(command, args);
  });
  await downloadTemplateWeights("minimax-h3-original");
  expect(isDownloadUrl(saved().paths.transformer)).toBe(false);
  expect(isDownloadUrl(saved().paths.textEncoder)).toBe(true);
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 1, error: "Network lost" });
  vi.mocked(invoke).mockImplementation(original);
  vi.mocked(invoke).mockClear();
  await downloadTemplateWeights("minimax-h3-original");
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight")).toHaveLength(3);
});

it("preserves edits made while a download is running", async () => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "download_weight") {
      const settings = loadGeneratorTemplateSettings();
      const template = settings.templates.find((template) => template.id === "minimax-h3-original")!;
      template.paths.transformer = "D:/MyModels/replacement.safetensors";
      saveGeneratorTemplateSettings(settings);
    }
    return original(command, args);
  });
  await downloadTemplateWeights("minimax-h3-original");
  expect(saved().paths.transformer).toBe("D:/MyModels/replacement.safetensors");
});

it("restores all templates sharing a downloaded weight when one removes it", async () => {
  await downloadTemplateWeights("minimax-h3-original");
  const settings = loadGeneratorTemplateSettings();
  settings.templates.push({ ...saved(), id: "copy", name: "Shared copy" });
  saveGeneratorTemplateSettings(settings);
  await removeTemplateWeights("minimax-h3-original");
  const copy = loadGeneratorTemplateSettings().templates.find((template) => template.id === "copy")!;
  expect(templateNeedsDownload(copy)).toBe(true);
  expect(copy.paths).toEqual(minimaxOriginalTemplate().paths);
});
