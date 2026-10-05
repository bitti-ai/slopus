// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./persistence", () => ({ isTauri: () => true }));
type Progress = { requestId: string; downloaded: number; total: number | null };
let progress: (event: { payload: Progress }) => void;
let transfers: { requestId: string; url: string; resolve: (path: string) => void; reject: (error: Error) => void }[];
const unlisten = vi.fn();
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear(); transfers = [];
  vi.mocked(listen).mockImplementation((async (_name, callback) => { progress = callback as typeof progress; return unlisten; }) as typeof listen);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "find_downloaded_weights") return {};
    if (command === "weight_download_hardware") return [];
    if (command === "download_weight") return new Promise<string>((resolve, reject) => transfers.push({ ...args as { requestId: string; url: string }, resolve, reject }));
    if (command === "cancel_weight_download") transfers.find((transfer) => transfer.requestId === (args as { requestId: string }).requestId)?.reject(new Error("Download cancelled."));
  });
});

it("serializes generator, upscaler and LoRA downloads and reports both SeedVR2 files", async () => {
  const queue = await import("./weightDownloads");
  const settings = await import("./settings");
  const loras = await import("./loras");
  const { OTHER_WEIGHT_TEMPLATES, otherWeightPaths } = await import("./upscalers");
  const template = settings.createGeneratorTemplate("Extra");
  template.additionalSafetensors = [{ id: "extra", name: "Extra", url: "https://example.com/extra.safetensors" }];
  settings.saveGeneratorTemplateSettings({ templates: [template], defaultTemplateId: template.id });
  loras.saveLoras([{ id: "adapter", name: "Adapter", path: "", url: "https://example.com/adapter.safetensors" }]);
  const generator = queue.downloadTemplateWeights(template.id);
  const esrgan = queue.downloadOtherWeights("realesrgan");
  const seed = queue.downloadOtherWeights("seedvr2");
  const lora = queue.downloadLora("adapter");
  expect(queue.downloadOtherWeights("seedvr2")).toBe(seed);
  expect(queue.getQueuedWeightDownloads().map((job) => job.name)).toEqual(["Real-ESRGAN", "SeedVR2", "Adapter"]);
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  transfers[0].resolve("C:/extra.safetensors");
  await generator;
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(transfers[1].url).toBe(OTHER_WEIGHT_TEMPLATES[0].files[0].url);
  progress({ payload: { requestId: transfers[1].requestId, downloaded: 50, total: 100 } });
  expect(queue.weightDownloadProgress(queue.getWeightDownloadState()!)).toBe(50);
  transfers[1].resolve("C:/esrgan.safetensors");
  await esrgan;
  await vi.waitFor(() => expect(transfers).toHaveLength(3));
  progress({ payload: { requestId: transfers[1].requestId, downloaded: 100, total: 100 } });
  expect(queue.getWeightDownloadState()?.downloaded).toBe(0); // Ignore the previous job's late events.
  progress({ payload: { requestId: transfers[2].requestId, downloaded: 50, total: 100 } });
  expect(queue.weightDownloadProgress(queue.getWeightDownloadState()!)).toBe(25);
  transfers[2].resolve("C:/seed.safetensors");
  await vi.waitFor(() => expect(transfers).toHaveLength(4));
  expect(transfers[3].url).toBe(OTHER_WEIGHT_TEMPLATES[1].files[1].url);
  expect(queue.weightDownloadProgress(queue.getWeightDownloadState()!)).toBe(50);
  progress({ payload: { requestId: transfers[3].requestId, downloaded: 50, total: 100 } });
  expect(queue.weightDownloadProgress(queue.getWeightDownloadState()!)).toBe(75);
  transfers[3].resolve("C:/vae.safetensors");
  await seed;
  expect(otherWeightPaths()).toMatchObject({ [OTHER_WEIGHT_TEMPLATES[1].files[0].url]: "C:/seed.safetensors", [OTHER_WEIGHT_TEMPLATES[1].files[1].url]: "C:/vae.safetensors" });
  await vi.waitFor(() => expect(transfers).toHaveLength(5));
  transfers[4].resolve("C:/adapter.safetensors");
  await lora;
  expect(invoke).toHaveBeenCalledWith("prepare_lora", { path: "C:/adapter.safetensors", allowDownload: true });
  expect(queue.getQueuedWeightDownloads()).toEqual([]);
  expect(queue.getWeightDownloadState()).toMatchObject({ active: false, error: null });
});

it("cancels queued downloads without touching the active transfer, then advances after cancellation", async () => {
  const queue = await import("./weightDownloads");
  const first = queue.downloadOtherWeights("realesrgan");
  const removed = queue.downloadOtherWeights("seedvr2");
  queue.cancelQueuedWeightDownload("other:seedvr2");
  await removed;
  expect(invoke).not.toHaveBeenCalledWith("cancel_weight_download", expect.anything());
  const second = queue.downloadOtherWeights("seedvr2");
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  await queue.cancelWeightDownload(); await first;
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
  expect(queue.getWeightDownloadState()).toMatchObject({ otherWeightId: "seedvr2", active: true });
  transfers[1].resolve("C:/seed.safetensors");
  await vi.waitFor(() => expect(transfers).toHaveLength(3));
  transfers[2].resolve("C:/vae.safetensors");
  await second;
  expect(queue.getWeightDownloadState()).toMatchObject({ active: false, completed: 2, error: null });
});

it("retries a failed upscaler through the shared pipeline and reuses its completed file", async () => {
  const queue = await import("./weightDownloads");
  const { OTHER_WEIGHT_TEMPLATES } = await import("./upscalers");
  const first = queue.downloadOtherWeights("seedvr2");
  await vi.waitFor(() => expect(transfers).toHaveLength(1));
  transfers[0].resolve("C:/seed.safetensors");
  await vi.waitFor(() => expect(transfers).toHaveLength(2));
  transfers[1].reject(new Error("Connection lost"));
  await first;
  expect(queue.getWeightDownloadState()).toMatchObject({ active: false, completed: 1, error: "Connection lost" });
  vi.mocked(invoke).mockImplementationOnce(async () => ({ [OTHER_WEIGHT_TEMPLATES[1].files[0].url]: "C:/seed.safetensors" }));
  const retry = queue.retryWeightDownload();
  await vi.waitFor(() => expect(transfers).toHaveLength(3));
  expect(transfers[2].url).toBe(OTHER_WEIGHT_TEMPLATES[1].files[1].url);
  transfers[2].resolve("C:/vae.safetensors"); await retry;
  expect(queue.getWeightDownloadState()).toMatchObject({ active: false, completed: 2, error: null });
});
