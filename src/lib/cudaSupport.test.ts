import { describe, expect, it } from "vitest";
import { missingCudaDownload } from "./cudaSupport";
import type { SlopfabStatus } from "./runtime";

const status = (names: string[], extra: Partial<SlopfabStatus> = {}): SlopfabStatus => ({
  state: "modelsMissing", dllPath: "slopfab.dll", version: "1.4.0", platform: "Vulkan",
  cudaAvailable: false, cudaDeviceNames: names, detail: "Missing models", models: [], ...extra,
});

describe("CUDA download recommendations", () => {
  it.each(["NVIDIA GeForce RTX 5090", "NVIDIA GeForce RTX 5080 Laptop GPU", "RTX 5060 Ti"])("offers current CUDA for %s", (name) => {
    expect(missingCudaDownload(status([name]))).toEqual({
      gpuName: name, version: "latest", url: "https://developer.nvidia.com/cuda-downloads",
    });
  });

  it.each(["NVIDIA GeForce RTX 4090", "RTX 4070 Ti SUPER", "NVIDIA GeForce RTX 3090", "RTX 3050 Laptop GPU"])("offers CUDA 12.8 for %s", (name) => {
    expect(missingCudaDownload(status([name]))).toEqual({
      gpuName: name, version: "12.8", url: "https://developer.nvidia.com/cuda-12-8-0-download-archive",
    });
  });

  it.each(["NVIDIA GeForce RTX 2080 Ti", "NVIDIA RTX 5000 Ada Generation", "NVIDIA RTX 4000", "NVIDIA RTX A3000", "AMD Radeon RX 7900 XTX", "Intel Arc A770"])("does not recommend a toolkit for other GPU families: %s", (name) => {
    expect(missingCudaDownload(status([name]))).toBeNull();
  });

  it("does not confuse a Vulkan preference, unknown detection, or a broken engine with missing CUDA", () => {
    for (const extra of [{ cudaAvailable: true }, { cudaAvailable: undefined }, { state: "runtimeMissing" as const }, { state: "incompatible" as const }]) {
      expect(missingCudaDownload(status(["RTX 5090"], extra))).toBeNull();
    }
    expect(missingCudaDownload(null)).toBeNull();
    expect(missingCudaDownload(status([]))).toBeNull();
  });

  it("uses the current download when a 50-series card is present alongside older cards", () => {
    expect(missingCudaDownload(status(["RTX 3080", "RTX 5090"]))?.version).toBe("latest");
  });
});
