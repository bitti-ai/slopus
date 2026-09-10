import type { SlopfabStatus } from "./runtime";

export interface CudaDownload {
  gpuName: string;
  version: "latest" | "12.8";
  url: string;
}

export function missingCudaDownload(status: SlopfabStatus | null | undefined): CudaDownload | null {
  if (!status || status.cudaAvailable !== false || !["ready", "modelsMissing"].includes(status.state)) return null;
  const devices = (status.cudaDeviceNames ?? []).flatMap((gpuName) => {
    // Match GeForce model numbers, including Ti/SUPER/laptop variants. Exclude
    // workstation names such as RTX 4000 Ada and RTX 5000, which use other chips.
    const series = /\bRTX\s+(30|40|50)([1-9]\d)\b/i.exec(gpuName)?.[1];
    return series ? [{ gpuName, series }] : [];
  });
  const gpu = devices.find((device) => device.series === "50") ?? devices[0];
  if (!gpu) return null;
  return {
    gpuName: gpu.gpuName,
    version: gpu.series === "50" ? "latest" : "12.8",
    url: gpu.series === "50"
      ? "https://developer.nvidia.com/cuda-downloads"
      : "https://developer.nvidia.com/cuda-12-8-0-download-archive",
  };
}
