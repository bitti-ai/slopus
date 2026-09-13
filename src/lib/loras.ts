/** Machine-local adapter library; paths never belong in portable projects. */
export interface Lora {
  id: string;
  name: string;
  path: string;
  url?: string;
  schedule?: "taomate-3step";
}
export interface TemplateLora { loraId: string; enabled: boolean; strength: number }
export const TAOMATE_LORA: Lora = {
  id: "taomate-3step", name: "TaoMate 3-Step", path: "",
  url: "https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/resolve/main/TaoMate-H3-3step-ComfyUI.safetensors",
  schedule: "taomate-3step",
};
const KEY = "slopus.loras.v1";
const EVENT = "slopus:loras-changed";
export function loadLoras(): Lora[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    const ids = new Set<string>();
    const entries: Lora[] = Array.isArray(raw) ? raw.flatMap((entry) => {
      if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
        || typeof entry.name !== "string" || !entry.name.trim() || typeof entry.path !== "string") return [];
      ids.add(entry.id);
      return [{ id: entry.id, name: entry.name, path: entry.path,
        ...(typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? { url: entry.url } : {}),
        ...(entry.schedule === "taomate-3step" ? { schedule: "taomate-3step" as const } : {}) }];
    }) : [];
    if (!ids.has(TAOMATE_LORA.id)) entries.unshift({ ...TAOMATE_LORA });
    return entries;
  } catch { return [{ ...TAOMATE_LORA }]; }
}
export function saveLoras(loras: Lora[]): void {
  localStorage.setItem(KEY, JSON.stringify(loras));
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeLoras(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", storage); };
}
export function normalizeTemplateLoras(value: unknown): TemplateLora[] {
  const ids = new Set<string>();
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (!entry || typeof entry.loraId !== "string" || !entry.loraId || ids.has(entry.loraId)) return [];
    ids.add(entry.loraId);
    return [{ loraId: entry.loraId, enabled: entry.enabled !== false,
      strength: typeof entry.strength === "number" && Number.isFinite(entry.strength) && Math.abs(entry.strength) <= 3.4028234663852886e38 ? entry.strength : 1 }];
  }) : [];
}

export function resolveTemplateLoras(selection: TemplateLora[] = []) {
  const library = loadLoras();
  return selection.filter((entry) => entry.enabled && entry.strength !== 0).map((entry) => {
    const lora = library.find(({ id }) => id === entry.loraId);
    if (!lora?.path.trim() || /^https?:\/\//i.test(lora.path)) {
      throw new Error(`Download or locate LoRA ${lora?.name ?? entry.loraId}, or disable it in the generator template.`);
    }
    return { path: lora.path.trim(), strength: entry.strength, schedule: lora.schedule };
  });
}
