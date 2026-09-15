// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { cancelWeightDownload, downloadLora, removeLora, refreshDownloadedLoras, retryWeightDownload } from "./weightDownloads";
import { loadLoras, saveLoras, TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA } from "./loras";
import { beforeEach, expect, it, vi } from "vitest";
import { chooseWeightSource, downloadTemplateWeights, getWeightDownloadState, refreshDownloadedWeights, removeTemplateWeights, updateWeightPath, weightDownloadProgress, type DownloadState } from "./weightDownloads";
import { createGeneratorTemplate, defaultGeneratorTemplate, isDownloadUrl, loadGeneratorTemplateSettings, minimaxOriginalTemplate, minimaxSingularityTemplate, saveGeneratorTemplateSettings, templateNeedsDownload, type WeightSource } from "./settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./persistence", () => ({ isTauri: () => true }));
const files = new Set<string>();
const source = (url: string, gpuModel = "", minVramGb = 0): WeightSource => ({ url, gpuModel, minVramGb });
const saved = () => loadGeneratorTemplateSettings().templates.find((template) => template.id === "minimax-h3-original")!;

it("downloads Animate with its transformer and four-step distillation adapter", async () => {
  await downloadTemplateWeights("viggle-animate");
  const template = loadGeneratorTemplateSettings().templates.find(({ id }) => id === "viggle-animate")!;
  expect(templateNeedsDownload(template)).toBe(false);
  expect(template.paths.transformer).toBe("C:/Slopus/weights/Viggle-Animate-pruned_rank8_int8_convrot.safetensors");
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: VIGGLE_ANIMATE_LORA.url }));
  expect(loadLoras().find(({ id }) => id === VIGGLE_ANIMATE_LORA.id)).toMatchObject({
    path: "C:/Slopus/weights/viggle_animate_distillation_bf16.safetensors", stepOverride: 4,
  });
});

it.each([TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA])("downloads $name through the weight transfer and restores missing downloads", async (lora) => {
  const savedLora = () => loadLoras().find(({ id }) => id === lora.id)!;
  await downloadLora(lora.id);
  expect(invoke).toHaveBeenCalledWith("download_weight", { requestId: expect.any(String), url: lora.url });
  const path = `C:/Slopus/weights/${lora.url!.split('/').at(-1)}`;
  expect(savedLora()).toMatchObject({ path, stepOverride: lora.stepOverride });
  expect(getWeightDownloadState()).toMatchObject({ loraId: lora.id, active: false, completed: 1, error: null });
  files.clear();
  await refreshDownloadedLoras();
  expect(savedLora().path).toBe("");
  await downloadLora(lora.id);
  await removeLora(lora.id);
  expect(invoke).toHaveBeenCalledWith("remove_downloaded_weights", { paths: [path] });
  expect(savedLora().path).toBe("");
});

it("removes manually added adapters without deleting the user's file", async () => {
  saveLoras([{ id: "manual", name: "Manual", path: "D:/personal.safetensors" }]);
  await removeLora("manual");
  expect(loadLoras().some(({ id }) => id === "manual")).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("remove_downloaded_weights", expect.anything());
});

it("retries a failed LoRA download without leaving the shared transfer locked", async () => {
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Network lost"));
  await downloadLora(TAOMATE_LORA.id);
  expect(getWeightDownloadState()).toMatchObject({ active: false, error: "Network lost" });
  expect(loadLoras()[0].path).toBe("");
  vi.mocked(invoke).mockImplementation(normal);
  await retryWeightDownload();
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 1, error: null });
});

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
    if (command === "find_downloaded_weights") return {};
    if (command === "check_weight_files") return Object.fromEntries((args as { paths: string[] }).paths.map((path) => [path, files.has(path)]));
    if (command === "remove_downloaded_weights") { for (const path of (args as { paths: string[] }).paths) files.delete(path); return; }
    if (command === "download_weight") {
      const path = `C:/Slopus/weights/${(args as { url: string }).url.split('/').at(-1)}`;
      files.add(path); return path;
    }
  });
});

it("discovers model weights and LoRAs without saved paths or starting downloads", async () => {
  const normal = vi.mocked(invoke).getMockImplementation()!;
  const template = minimaxSingularityTemplate();
  const cached = Object.fromEntries([...Object.values(template.paths).filter(Boolean), TURBO_LORA.url!]
    .map((url) => [url, `D:/Projects/weights/${url.split('/').at(-1)}`]));
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "find_downloaded_weights"
    ? Object.fromEntries((args as { urls: string[] }).urls.filter((url) => cached[url]).map((url) => [url, cached[url]])) : normal(command, args));
  await refreshDownloadedWeights();
  const discovered = loadGeneratorTemplateSettings().templates.find(({ id }) => id === template.id)!;
  expect(discovered.paths.transformer).toBe(cached[template.paths.transformer]);
  expect(discovered.sources!.transformer![0].downloadedPath).toBe(cached[template.paths.transformer]);
  expect(loadLoras().find(({ id }) => id === TURBO_LORA.id)?.path).toBe(cached[TURBO_LORA.url!]);
  expect(templateNeedsDownload(discovered)).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("download_weight", expect.anything());
});

it("finds moved weights and preserves manual paths and GPU variant selection", async () => {
  const template = minimaxOriginalTemplate();
  const movedUrl = template.paths.videoVae;
  template.paths.videoVae = "C:/old/video.safetensors";
  template.sources!.videoVae![0].downloadedPath = template.paths.videoVae;
  template.paths.audioVae = "D:/personal/audio.safetensors";
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: "", catalogVersion: 6 });
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "find_downloaded_weights") return {
      [movedUrl]: "D:/Projects/weights/video.safetensors",
      [template.sources!.audioVae![0].url]: "D:/Projects/weights/audio.safetensors",
      [template.sources!.transformer![1].url]: "D:/Projects/weights/small.safetensors",
    };
    return normal(command, args);
  });
  await refreshDownloadedWeights();
  expect(saved().paths.videoVae).toBe("D:/Projects/weights/video.safetensors");
  expect(saved().paths.audioVae).toBe("D:/personal/audio.safetensors");
  expect(saved().paths.transformer).toBe(template.paths.transformer);
  expect(saved().sources!.transformer![1].downloadedPath).toBe("D:/Projects/weights/small.safetensors");
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
  expect(Object.values(saved().sources ?? {}).flat()).toHaveLength(5);
});

it.each([8, 11.4, 12, 12.01, 16, 19.4, 20, 20.01, 24, 32])("selects the Minimax weights for %s GiB of VRAM", async (vram) => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "weight_download_hardware"
    ? [{ name: "GPU", memoryBytes: vram * 1024 ** 3 }] : original(command, args));
  await downloadTemplateWeights("minimax-h3-original");
  const filename = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors";
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 4, error: null });
  expect(saved().paths.textEncoder).toBe(`C:/Slopus/weights/${filename}`);
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({
    url: minimaxOriginalTemplate().paths.textEncoder,
  }));
  const transformer = vram <= 20 ? "minimax_h3_ref2va_hybrid_b20-49_pruned_w4a8_mixed.safetensors" : "minimax_h3_fl2va_pruned_int8_convrot.safetensors";
  expect(saved().paths.transformer).toBe(`C:/Slopus/weights/${transformer}`);
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({
    url: vram <= 20
      ? "https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/diffusion_models/minimax_h3_ref2va_hybrid_b20-49_pruned_w4a8_mixed.safetensors"
      : minimaxOriginalTemplate().paths.transformer,
  }));
});

it.each([12, 20, 24])("downloads the References transformer for %s GiB of VRAM", async (vram) => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "weight_download_hardware"
    ? [{ name: "GPU", memoryBytes: vram * 1024 ** 3 }] : original(command, args));
  await downloadTemplateWeights("minimax-h3-references");
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 4, error: null });
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: vram <= 20
    ? "https://huggingface.co/koongrizzly/MiniMax_H3_int4_W4A8_ConvRot_Pruned/resolve/main/diffusion_models/minimax_h3_ref2va_hybrid_b20-49_pruned_w4a8_mixed.safetensors"
    : "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors" }));
  expect(templateNeedsDownload(loadGeneratorTemplateSettings().templates.find(({ id }) => id === "minimax-h3-references")!)).toBe(false);
});

it("downloads the fast transformer and retains its six-step default", async () => {
  await downloadTemplateWeights("minimax-h3-fast");
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 4, error: null });
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({
    url: "https://huggingface.co/datasets/jacokon/fasth3-live/resolve/main/minimax_h3_fl2va_fasth3_dense_pruned_int8_convrot.safetensors",
  }));
  const template = loadGeneratorTemplateSettings().templates.find(({ id }) => id === "minimax-h3-fast")!;
  expect(template.defaultSteps).toBe(6);
  expect(templateNeedsDownload(template)).toBe(false);
});

it.each([0, 12, 20, 32])("downloads Singularity with four steps and the shared weights for %s GiB of VRAM", async (vram) => {
  const original = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "weight_download_hardware"
    ? (vram ? [{ name: "GPU", memoryBytes: vram * 1024 ** 3 }] : []) : original(command, args));
  await downloadTemplateWeights("minimax-h3-singularity");
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 5, files: 5, error: null });
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: TURBO_LORA.url }));
  expect(loadLoras().find(({ id }) => id === TURBO_LORA.id)?.path).not.toBe("");
  expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({
    url: "https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/blob/main/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors",
  }));
  for (const field of ["textEncoder", "videoVae", "audioVae"] as const) {
    expect(invoke).toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: minimaxOriginalTemplate().paths[field] }));
  }
  const settings = loadGeneratorTemplateSettings();
  const template = settings.templates.find(({ id }) => id === "minimax-h3-singularity")!;
  expect(template.paths.transformer).toBe("C:/Slopus/weights/Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors");
  expect(templateNeedsDownload(template)).toBe(false);
  saveGeneratorTemplateSettings({ ...settings, defaultTemplateId: template.id });
  expect(defaultGeneratorTemplate().defaultSteps).toBe(4);
});

it("reuses downloaded template LoRAs and restores readiness when a shared adapter goes missing", async () => {
  await downloadLora(TURBO_LORA.id);
  vi.mocked(invoke).mockClear();
  await downloadTemplateWeights("minimax-h3-singularity");
  expect(getWeightDownloadState()).toMatchObject({ completed: 4, error: null });
  expect(invoke).not.toHaveBeenCalledWith("download_weight", expect.objectContaining({ url: TURBO_LORA.url }));
  const settings = loadGeneratorTemplateSettings();
  const template = settings.templates.find(({ id }) => id === "minimax-h3-singularity")!;
  saveGeneratorTemplateSettings({ ...settings, defaultTemplateId: template.id });
  files.delete(loadLoras().find(({ id }) => id === TURBO_LORA.id)!.path);
  await refreshDownloadedWeights();
  expect(templateNeedsDownload(template)).toBe(true);
  expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe("default");
  vi.mocked(invoke).mockClear();
  await downloadTemplateWeights(template.id);
  expect(getWeightDownloadState()).toMatchObject({ completed: 1, files: 1, error: null });
  expect(templateNeedsDownload(template)).toBe(false);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight")).toHaveLength(1);
});

it.each([{ enabled: false, strength: 1 }, { enabled: true, strength: 0 }])("skips inactive template LoRAs: %j", async (selection) => {
  const template = createGeneratorTemplate();
  template.loras = [{ loraId: TURBO_LORA.id, ...selection }];
  saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id, catalogVersion: 6 });
  expect(templateNeedsDownload(template)).toBe(false);
  await downloadTemplateWeights(template.id);
  expect(invoke).not.toHaveBeenCalledWith("download_weight", expect.anything());
  expect(getWeightDownloadState()).toMatchObject({ files: 0, error: null });
});

it("keeps generator progress and cancellation during its LoRA transfer, then retries only the missing adapter", async () => {
  const normal = vi.mocked(invoke).getMockImplementation()!;
  let started!: () => void;
  const downloadingLora = new Promise<void>((resolve) => { started = resolve; });
  let rejectDownload!: (reason: Error) => void;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "download_weight" && (args as { url: string }).url === TURBO_LORA.url) {
      return new Promise((_resolve, reject) => { rejectDownload = reject; started(); });
    }
    if (command === "cancel_weight_download") { rejectDownload(new Error("Download cancelled.")); return; }
    return normal(command, args);
  });
  const pending = downloadTemplateWeights("minimax-h3-singularity");
  await downloadingLora;
  const state = getWeightDownloadState()!;
  expect(state).toMatchObject({ templateId: "minimax-h3-singularity", currentLoraId: TURBO_LORA.id, completed: 4, files: 5, active: true });
  expect(weightDownloadProgress({ ...state, downloaded: 50, total: 100 })).toBe(90);
  expect(templateNeedsDownload(loadGeneratorTemplateSettings().templates.find(({ id }) => id === state.templateId)!)).toBe(true);
  await cancelWeightDownload();
  await pending;
  expect(getWeightDownloadState()).toMatchObject({ active: false, error: "Download cancelled." });
  vi.mocked(invoke).mockImplementation(normal).mockClear();
  await retryWeightDownload();
  expect(getWeightDownloadState()).toMatchObject({ templateId: state.templateId, completed: 1, files: 1, error: null });
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight")).toHaveLength(1);
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
