import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";
import { selectedWorker } from "./workers";

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
    { id: "model", name: "SeedVR2 3B FP16", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_fp16.safetensors" },
    { id: "vae", name: "SeedVR2 VAE", url: "https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors" },
  ] },
] as const;
const KEY = "slopus.other-weights.v1";
const LOCAL_KEY = "slopus.other-weights-local.v1";
const EVENT = "slopus:other-weights";
function readPaths(key: string): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path && !/^https?:/i.test(path))) as Record<string, string>;
  } catch { return {}; }
}
export const localOtherWeightPaths = () => readPaths(LOCAL_KEY);
export const otherWeightPaths = () => ({ ...readPaths(KEY), ...localOtherWeightPaths() });
export function saveLocalOtherWeightPaths(paths: Record<string, string>) {
  const saved = localOtherWeightPaths();
  for (const [url, path] of Object.entries(paths)) {
    if (path.trim()) saved[url] = path.trim();
    else delete saved[url];
  }
  localStorage.setItem(LOCAL_KEY, JSON.stringify(saved));
  window.dispatchEvent(new Event(EVENT));
}
const savePaths = (paths: Record<string, string>) => {
  localStorage.setItem(KEY, JSON.stringify(paths));
  window.dispatchEvent(new Event(EVENT));
};
export const saveOtherWeightPath = (url: string, path: string) => savePaths({ ...readPaths(KEY), [url]: path });
export function subscribeOtherWeights(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); };
}
export interface UpscaleConfig { method: Exclude<Upscaler, "none">; modelPath: string; vaePath?: string }
export function upscaleConfig(method: Upscaler): UpscaleConfig | undefined {
  if (method === "none") return undefined;
  if (method === "seedvr2" && selectedWorker()) {
    const local = localOtherWeightPaths();
    return { method, modelPath: local[OTHER_WEIGHT_TEMPLATES[1].files[0].url] ?? "",
      vaePath: local[OTHER_WEIGHT_TEMPLATES[1].files[1].url] };
  }
  const template = OTHER_WEIGHT_TEMPLATES.find((item) => item.id === method)!;
  const paths = otherWeightPaths();
  if (template.files.some((file) => !paths[file.url])) throw new Error(`Download ${template.name} or choose a local weight file in Settings → Generator → Other weights first.`);
  return { method, modelPath: paths[template.files[0].url],
    ...(template.id === "seedvr2" ? { vaePath: paths[template.files[1].url] } : {}) };
}
export async function refreshOtherWeights() {
  if (!isTauri()) return;
  const urls = OTHER_WEIGHT_TEMPLATES.flatMap((item) => item.files.map((file) => file.url));
  const found = await invoke<Record<string, string>>("find_downloaded_weights", { urls });
  if (found) savePaths(found);
}
