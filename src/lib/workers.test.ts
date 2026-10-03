// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DMAD_LORA, TURBO_LORA } from "./loras";
import { engineProviderSetting, templateNeedsDownload, templateUsable, viggleAnimateTemplate, type GeneratorTemplate } from "./settings";
import { refreshWorkers, remoteWorkerSelected, selectedWorker, selectWorker, WORKERS_EVENT, type WorkerList } from "./workers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./persistence", async (original) => ({ ...await original<typeof import("./persistence")>(), isTauri: () => true }));

const worker = (overrides: Partial<WorkerList["workers"][number]> = {}): WorkerList["workers"][number] => ({
  key: "aaaaaaaaaaaaaaaa", id: "aaaaaaaaaaaaaaaa", name: "Studio PC", address: "192.168.1.20:47321", online: true, compatible: true,
  discovered: true, manual: false, selected: false, version: "0.2.0", requiresToken: false, hasToken: false,
  gpus: [{ name: "NVIDIA GeForce RTX 5090", memoryBytes: 32 * 1024 ** 3 }], runtime: null, error: null, ...overrides,
});

function choose(list: WorkerList) {
  vi.mocked(invoke).mockResolvedValue(list);
  return selectWorker(list.selectedId);
}

const downloadable = (): GeneratorTemplate => ({
  id: "remote", name: "Remote", modelType: "minimax-h3", defaultSteps: 8, attention: "sage2",
  paths: { transformer: "", textEncoder: "D:/models/encoder.safetensors", tokenizer: "", videoVae: "https://example.com/vae.safetensors", audioVae: "https://example.com/audio.safetensors" },
  sources: { transformer: [
    { url: "https://example.com/small.safetensors", gpuModel: "", minVramGb: 0 },
    { url: "https://example.com/large.safetensors", gpuModel: "", minVramGb: 24 },
  ] },
  loras: [{ loraId: TURBO_LORA.id, enabled: true, strength: 1 }],
});

describe("LAN generation workers", () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); });

  it("mirrors the selection Rust reports and announces changes", async () => {
    const changed = vi.fn();
    window.addEventListener(WORKERS_EVENT, changed);
    await choose({ selectedId: "aaaaaaaaaaaaaaaa", workers: [worker({ selected: true })] });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("select_worker", { id: "aaaaaaaaaaaaaaaa" });
    expect(selectedWorker()).toEqual({ id: "aaaaaaaaaaaaaaaa", name: "Studio PC", gpus: worker().gpus });
    expect(changed).toHaveBeenCalledTimes(1);
    // An offline worker keeps its last known GPUs for weight selection.
    vi.mocked(invoke).mockResolvedValue({ selectedId: "aaaaaaaaaaaaaaaa", workers: [worker({ online: false, gpus: [] })] });
    await refreshWorkers();
    expect(selectedWorker()?.gpus).toEqual(worker().gpus);
    expect(changed).toHaveBeenCalledTimes(1);
    await choose({ selectedId: null, workers: [worker()] });
    expect(remoteWorkerSelected()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    window.removeEventListener(WORKERS_EVENT, changed);
  });

  it("lets a worker download what this computer has not, and picks weights for the worker's GPU", async () => {
    const template = downloadable();
    expect(templateNeedsDownload(template)).toBe(true);
    expect(templateUsable(template)).toBe(false);
    expect(() => engineProviderSetting(template.paths, undefined, "sage2", template.loras, "prompt", [], false, template.sources)).toThrow(/Download or locate LoRA/);

    await choose({ selectedId: "aaaaaaaaaaaaaaaa", workers: [worker()] });
    expect(templateUsable(template)).toBe(true);
    const options = engineProviderSetting(template.paths, undefined, "sage2", template.loras, "prompt", [], false, template.sources).options;
    expect(options).toMatchObject({
      transformer: "https://example.com/large.safetensors",
      textEncoder: "D:/models/encoder.safetensors",
      videoVae: "https://example.com/vae.safetensors",
      audioVae: "https://example.com/audio.safetensors",
      stepOverride: 4,
    });
    expect(options).not.toHaveProperty("tokenizer");
    expect(JSON.parse(options.loras as string)).toEqual([{ path: TURBO_LORA.url, strength: 1 }]);

    const animate = viggleAnimateTemplate();
    const embedding = engineProviderSetting(animate.paths, undefined, animate.attention, [], "animate", animate.additionalSafetensors, false, animate.sources).options;
    expect(embedding.promptEmbedding).toBe(animate.additionalSafetensors![0].url);
  });

  it("sends a DMAD download link with its sampling recipe to a worker", async () => {
    await choose({ selectedId: "aaaaaaaaaaaaaaaa", workers: [worker()] });
    const template = { ...downloadable(), loras: [{ loraId: DMAD_LORA.id, enabled: true, strength: 1 }] };
    const options = engineProviderSetting(template.paths, undefined, "sage2", template.loras, "prompt", [], true, template.sources).options;
    expect(JSON.parse(options.loras as string)).toEqual([{ path: DMAD_LORA.url, strength: 1 }]);
    expect(options).toMatchObject({ samplingPreset: "dmad-4step", stepOverride: 4 });
    expect(options).not.toHaveProperty("motionCache");
  });

  it("still needs a source for every required model on a worker", async () => {
    await choose({ selectedId: "aaaaaaaaaaaaaaaa", workers: [worker()] });
    const template = downloadable();
    template.sources = {};
    expect(templateUsable(template)).toBe(false);
  });
});
