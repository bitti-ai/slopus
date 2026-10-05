import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./persistence";

export type Upscaler = "none" | "realesrgan" | "seedvr2";
export const UPSCALERS = [
  { value: "none", label: "None" },
  { value: "realesrgan", label: "Real-ESRGAN" },
  { value: "seedvr2", label: "SeedVR2" },
] as const;
export const OTHER_WEIGHT_TEMPLATES = [
  { id: "realesrgan", name: "Real-ESRGAN", files: [
    { id: "model", name: "RealESRGAN x4plus", url: "https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors" },
  ] },
  { id: "seedvr2", name: "SeedVR2", files: [
    { id: "model", name: "SeedVR2 3B INT8", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors" },
    { id: "vae", name: "SeedVR2 VAE", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors" },
  ] },
] as const;
const KEY = "slopus.other-weights.v1";
const EVENT = "slopus:other-weights";
export function otherWeightPaths(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path && !/^https?:/i.test(path))) as Record<string, string>;
  } catch { return {}; }
}
const savePaths = (paths: Record<string, string>) => {
  localStorage.setItem(KEY, JSON.stringify(paths));
  window.dispatchEvent(new Event(EVENT));
};
export function subscribeOtherWeights(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); };
}
export interface UpscaleConfig { method: Exclude<Upscaler, "none">; modelPath: string; vaePath?: string }
export function upscaleConfig(method: Upscaler): UpscaleConfig | undefined {
  if (method === "none") return undefined;
  const template = OTHER_WEIGHT_TEMPLATES.find((item) => item.id === method)!;
  const paths = otherWeightPaths();
  if (template.files.some((file) => !paths[file.url])) throw new Error(`Download ${template.name} in Settings → Generator → Other weights first.`);
  return { method, modelPath: paths[template.files[0].url], ...(method === "seedvr2" ? { vaePath: paths[OTHER_WEIGHT_TEMPLATES[1].files[1].url] } : {}) };
}
export async function refreshOtherWeights() {
  if (!isTauri()) return;
  const urls = OTHER_WEIGHT_TEMPLATES.flatMap((item) => item.files.map((file) => file.url));
  const found = await invoke<Record<string, string>>("find_downloaded_weights", { urls });
  if (found) savePaths(found);
}
export interface OtherDownload { templateId: string; file: string; progress: number; requestId: string; error?: string; active: boolean }
let download: OtherDownload | null = null;
let downloadCancelled = false;
export const otherDownloadState = () => download;
const publish = (value: OtherDownload) => { download = value; window.dispatchEvent(new Event(EVENT)); };
export async function downloadOtherWeights(id: string) {
  if (!isTauri() || download?.active) return;
  const template = OTHER_WEIGHT_TEMPLATES.find((item) => item.id === id);
  if (!template) return;
  const requestId = crypto.randomUUID();
  downloadCancelled = false;
  publish({ templateId: id, file: "", progress: 0, requestId, active: true });
  let unlisten: (() => void) | undefined;
  try {
    let completed = 0;
    unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
      if (payload.requestId === requestId && download?.active) publish({ ...download,
        progress: (completed + (payload.total ? payload.downloaded / payload.total : 0)) / template.files.length * 100 });
    });
    for (const file of template.files) {
      if (downloadCancelled) throw new Error("Download cancelled.");
      publish({ ...download!, file: file.name });
      const path = await invoke<string>("download_weight", { requestId, url: file.url });
      if (!path || /^https?:/i.test(path)) throw new Error("The download did not return a local file.");
      savePaths({ ...otherWeightPaths(), [file.url]: path });
      completed++;
    }
    publish({ ...download!, progress: 100, active: false });
  } catch (reason) { publish({ ...download!, active: false, error: String(reason) }); }
  finally { unlisten?.(); }
}
export async function cancelOtherDownload() {
  if (!download?.active) return;
  const requestId = download.requestId;
  downloadCancelled = true;
  await invoke("cancel_weight_download", { requestId });
}
