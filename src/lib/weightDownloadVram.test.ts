// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { askNative } from "./nativeShell";
import { loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, type WeightGpu } from "./settings";
import { cancelWeightDownload, downloadH3Component, downloadTemplateWeights, getWeightDownloadState } from "./weightDownloads";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./persistence", () => ({ isTauri: () => true }));
vi.mock("./nativeShell", () => ({ askNative: vi.fn() }));

let devices: WeightGpu[];
const gpu = (gb: number, name = "Test GPU"): WeightGpu => ({ name, memoryBytes: gb * 1024 ** 3 });
const downloads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight")
  .map(([, args]) => (args as { url: string }).url);

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks(); devices = [gpu(8)];
  vi.mocked(askNative).mockResolvedValue(false);
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "weight_download_hardware") return devices;
    if (command === "find_downloaded_weights") return {};
    if (command === "check_weight_files") return Object.fromEntries(args.paths.map((path: string) => [path, true]));
    if (command === "download_weight") return `D:/weights/${args.url.split("/").pop()}`;
  });
});

it("waits for a decision before any transfer and cancels without a download error", async () => {
  let decide!: (answer: boolean) => void;
  vi.mocked(askNative).mockImplementation(() => new Promise((resolve) => { decide = resolve; }));
  const pending = downloadTemplateWeights("minimax-h3-original");
  await vi.waitFor(() => expect(askNative).toHaveBeenCalledOnce());
  expect(downloads()).toEqual([]);
  expect(askNative).toHaveBeenCalledWith(expect.objectContaining({
    title: "Not enough GPU memory", okLabel: "Download anyway", cancelLabel: "Cancel",
    message: expect.stringContaining("Test GPU: 8 GB VRAM"),
  }));
  const message = vi.mocked(askNative).mock.calls[0][0].message;
  expect(message).toContain("12 GB VRAM");
  expect(message).toContain("16 GB VRAM");
  expect(message).not.toContain("21 GB VRAM"); // Report the smallest alternative.
  decide(false);
  await pending;
  expect(downloads()).toEqual([]);
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 0, error: null });
  await downloadTemplateWeights("fibo2-edit-turbo"); // A declined warning releases the queue.
  expect(downloads()).toHaveLength(3);
});

it("downloads the smallest matching variant after accepting the warning", async () => {
  vi.mocked(askNative).mockResolvedValue(true);
  await downloadTemplateWeights("minimax-h3-original");
  expect(askNative).toHaveBeenCalledOnce();
  expect(downloads()).toHaveLength(4);
  expect(downloads()[0]).toContain("w4a8_convrot_pruned");
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 4, error: null });
});

it.each([12, 16, 21, 24])("checks the encoder independently of the transformer on a %s GB GPU", async (gb) => {
  devices = [gpu(gb)];
  vi.mocked(askNative).mockResolvedValue(true);
  await downloadTemplateWeights("minimax-h3-original");
  if (gb < 16) {
    expect(askNative).toHaveBeenCalledOnce();
    expect(vi.mocked(askNative).mock.calls[0][0].message).toContain("16 GB VRAM");
    expect(vi.mocked(askNative).mock.calls[0][0].message).not.toContain("at least 12");
  } else expect(askNative).not.toHaveBeenCalled();
  expect(downloads()[0]).toContain(gb < 21 ? "w4a8_convrot_pruned" : "int8_convrot");
});

it.each([[], [gpu(0)], [gpu(15.4)], [gpu(8), gpu(24)]].map((hardware) => ({ hardware })))("handles unknown capacity, reserved memory and multiple GPUs: $hardware", async ({ hardware }) => {
  devices = hardware;
  await downloadTemplateWeights("minimax-h3-original");
  expect(askNative).not.toHaveBeenCalled();
  expect(downloads()).toHaveLength(4);
});

it("does not add the VRAM of separate GPUs together", async () => {
  devices = [gpu(8, "GPU A"), gpu(8, "GPU B")];
  await downloadTemplateWeights("minimax-h3-original");
  expect(askNative).toHaveBeenCalledOnce();
  expect(downloads()).toEqual([]);
});

it("warns for a known local encoder when downloading the remaining generator weights", async () => {
  devices = [gpu(12)];
  const settings = loadGeneratorTemplateSettings();
  const encoder = settings.h3Components!.templates.find(({ id }) => id === settings.h3Components!.defaultTextEncoderId)!;
  encoder.path = "D:/weights/encoder.safetensors";
  encoder.sources[0].downloadedPath = encoder.path;
  saveGeneratorTemplateSettings(settings);
  await downloadTemplateWeights("minimax-h3-original");
  expect(askNative).toHaveBeenCalledOnce();
  expect(vi.mocked(askNative).mock.calls[0][0].message).toContain("16 GB VRAM");
  expect(downloads()).toEqual([]);
});

it("checks shared components when downloaded directly", async () => {
  await downloadH3Component("h3-text-encoder");
  expect(askNative).toHaveBeenCalledOnce();
  expect(downloads()).toEqual([]);
  vi.mocked(askNative).mockResolvedValue(true);
  await downloadH3Component("h3-text-encoder");
  expect(downloads()).toHaveLength(1);
  expect(getWeightDownloadState()).toMatchObject({ active: false, completed: 1, error: null });
});

it("does not treat an unrelated GPU's memory as sufficient for a restricted variant", async () => {
  devices = [gpu(8, "RTX small"), gpu(32, "Radeon large")];
  const settings = loadGeneratorTemplateSettings();
  const template = settings.templates.find(({ id }) => id === "fibo2-edit-turbo")!;
  template.sources!.transformer![0] = { ...template.sources!.transformer![0], gpuModel: "RTX", minVramGb: 16 };
  saveGeneratorTemplateSettings(settings);
  await downloadTemplateWeights(template.id);
  expect(askNative).toHaveBeenCalledOnce();
  expect(downloads()).toEqual([]);
});

it("does not override GPU model restrictions even when downloading anyway", async () => {
  const settings = loadGeneratorTemplateSettings();
  const template = settings.templates.find(({ id }) => id === "fibo2-edit-turbo")!;
  template.sources!.transformer![0].gpuModel = "Different GPU";
  saveGeneratorTemplateSettings(settings);
  vi.mocked(askNative).mockResolvedValue(true);
  await downloadTemplateWeights(template.id);
  expect(askNative).not.toHaveBeenCalled();
  expect(downloads()).toEqual([]);
  expect(getWeightDownloadState()?.error).toContain("matches this GPU");
});

it("respects cancellation while the warning is open", async () => {
  vi.mocked(askNative).mockImplementation(async () => { await cancelWeightDownload(); return true; });
  await downloadTemplateWeights("minimax-h3-original");
  expect(downloads()).toEqual([]);
  expect(getWeightDownloadState()).toMatchObject({ active: false, error: "Download cancelled." });
});

it("seeds all agreed minimums and upgrades old defaults once without losing custom values or files", () => {
  const settings = loadGeneratorTemplateSettings();
  const limits = Object.fromEntries(settings.templates.filter(({ modelType, id }) => id !== "default" && ["minimax-h3", "minimax_music3"].includes(modelType))
    .map((template) => [template.id, template.sources!.transformer!.map(({ minVramGb }) => minVramGb)]));
  expect(limits).toEqual({ "minimax-h3-original": [21, 12], "minimax-h3-references": [21, 12],
    "minimax-h3-fast": [22], "minimax-h3-singularity": [21], "viggle-animate": [21], minimax_music3: [3] });
  expect(Object.fromEntries(settings.h3Components!.templates.map((entry) => [entry.id, entry.sources[0].minVramGb]))).toEqual({
    "h3-video-vae": 6, "sol-h3-vae": 6, "h3-fast-video-vae": 3, "h3-audio-vae": 1, "h3-text-encoder": 16,
  });
  const music = settings.templates.find(({ id }) => id === "minimax_music3")!;
  expect(music.sources!.textEncoder![0].minVramGb).toBe(9);
  expect(music.sources!.audioVae![0].minVramGb).toBe(1);

  for (const template of settings.templates) for (const source of Object.values(template.sources ?? {}).flat()) source.minVramGb = 0;
  for (const entry of settings.h3Components!.templates) for (const source of entry.sources) source.minVramGb = 0;
  const original = settings.templates.find(({ id }) => id === "minimax-h3-original")!;
  original.paths.transformer = "D:/weights/original.safetensors";
  original.sources!.transformer![0].downloadedPath = original.paths.transformer;
  original.sources!.transformer![1].minVramGb = 10; // Custom positive limit.
  original.sources!.transformer!.push({ url: "https://example.com/custom", gpuModel: "", minVramGb: 0 });
  const encoder = settings.h3Components!.templates.find(({ id }) => id === "h3-text-encoder")!;
  encoder.path = "D:/weights/encoder.safetensors";
  encoder.sources[0].downloadedPath = encoder.path;
  encoder.sources[0].url = encoder.sources[0].url.replace("/blob/", "/resolve/");
  localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ ...settings, catalogVersion: 17 }));
  const migrated = loadGeneratorTemplateSettings();
  const updated = migrated.templates.find(({ id }) => id === original.id)!;
  expect(migrated.catalogVersion).toBe(18);
  expect(updated.paths.transformer).toBe(original.paths.transformer);
  expect(updated.sources!.transformer!.map(({ minVramGb }) => minVramGb)).toEqual([21, 10, 0]);
  expect(updated.sources!.transformer![0].downloadedPath).toBe(original.paths.transformer);
  expect(migrated.h3Components!.templates.find(({ id }) => id === encoder.id)).toMatchObject({
    path: encoder.path, sources: [{ ...encoder.sources[0], minVramGb: 16 }],
  });
  // After migration, setting an unrestricted custom limit stays unrestricted.
  updated.sources!.transformer![0].minVramGb = 0;
  saveGeneratorTemplateSettings(migrated);
  expect(loadGeneratorTemplateSettings().templates.find(({ id }) => id === original.id)!.sources!.transformer![0].minVramGb).toBe(0);
});
