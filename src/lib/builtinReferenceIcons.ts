import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";

let ids = new Set<string>();
const urls = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const generations = new Map<string, number>();
const listeners = new Set<() => void>();
let revision = 0;
let refreshing: Promise<void> | undefined;
const changed = () => { revision += 1; listeners.forEach((listener) => listener()); };
export const subscribeBuiltinIcons = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const builtinIconRevision = () => revision;
export const hasBuiltinIcon = (id: string) => ids.has(id);
export const builtinIconUrl = (id: string) => urls.get(id);

export function refreshBuiltinIcons(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return refreshing ??= invoke<string[]>("list_builtin_reference_icons").then((found) => {
    ids = new Set(found);
    for (const [id, url] of urls) if (!ids.has(id)) { URL.revokeObjectURL(url); urls.delete(id); }
    changed();
  }).finally(() => { refreshing = undefined; });
}

export function loadBuiltinIcon(id: string): Promise<string> {
  const cached = urls.get(id);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(id);
  if (existing) return existing;
  const generation = generations.get(id) ?? 0;
  const request: Promise<string> = invoke<ArrayBuffer>("read_builtin_reference_icon", { presetId: id }).then((bytes) => {
    if ((generations.get(id) ?? 0) !== generation) return loadBuiltinIcon(id);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    urls.set(id, url);
    return url;
  }).finally(() => { if (pending.get(id) === request) pending.delete(id); });
  pending.set(id, request);
  return request;
}

export async function saveBuiltinIcon(presetId: string, jobId: string) {
  await invoke("save_builtin_reference_icon", { presetId, jobId });
  generations.set(presetId, (generations.get(presetId) ?? 0) + 1);
  pending.delete(presetId);
  const previous = urls.get(presetId);
  if (previous) { URL.revokeObjectURL(previous); urls.delete(presetId); }
  ids.add(presetId);
  changed();
}
