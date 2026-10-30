import { isSigmaShift, type SigmaShifts } from "./sampling";
import { MAX_GENERATION_STEPS } from "./project";

/** Machine-local adapter library; paths never belong in portable projects. */
export interface Lora {
  id: string;
  name: string;
  /** Older library entries are MiniMax H3 adapters. */
  modelType?: string;
  path: string;
  url?: string;
  stepOverride?: number;
  videoSigmaShiftOverride?: number;
  audioSigmaShiftOverride?: number;
  samplingPreset?: "dmad-4step" | "pika-6step";
  needsPreparation?: boolean;
  globallyEnabled?: boolean;
  globalStrength?: number;
}
export interface TemplateLora { loraId: string; enabled: boolean; strength: number }
export const TAOMATE_LORA: Lora = {
  id: "taomate-3step", name: "TaoMate 3-Step", path: "",
  url: "https://huggingface.co/CZMartin22/TaoMate-H3-3step-ComfyUI/resolve/main/TaoMate-H3-3step-ComfyUI.safetensors",
  stepOverride: 3,
};
export const TURBO_LORA: Lora = {
  id: "turbo-4step", name: "Turbo", path: "",
  url: "https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/main/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
  stepOverride: 4,
};
export const VIGGLE_ANIMATE_LORA: Lora = {
  id: "viggle-animate-4step", name: "Viggle Animate Distillation", path: "",
  url: "https://huggingface.co/DeepBeepMeep/MiniMax-H3/resolve/main/loras/viggle_animate_distillation_bf16.safetensors",
  stepOverride: 4,
};
export const LIGHTX2V_TURBO_LORA: Lora = {
  id: "lightx2v-turbo-6step", name: "LightX2V Turbo", path: "",
  url: "https://huggingface.co/silveroxides/MiniMax-H3_tests/resolve/main/experimental/minimax_h3_fl2v_lightx2v_turbo_4to8step_v0.1-v1.0_768p_v4_step600_dareties.safetensors",
  stepOverride: 6,
};
export const DMAD_LORA: Lora = {
  id: "dmad-4step", name: "DMAD 4-Step", path: "",
  url: "https://huggingface.co/ZhengmingYu/DMAD/resolve/main/minimax_h3/dmad_minimax_h3_4step_full_critic.safetensors",
  samplingPreset: "dmad-4step",
};
export const PIKA_FL2VA_LORA: Lora = {
  id: "pika-h3-flex-fl2va", name: "Pika H3 Flex FL2VA", modelType: "minimax-h3", path: "",
  url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/pika_h3_flex_fl2va_v1_bf16.safetensors",
  samplingPreset: "pika-6step",
};
export const PIKA_REF2VA_LORA: Lora = {
  id: "pika-h3-flex-ref2va", name: "Pika H3 Flex Ref2VA", modelType: "minimax-h3", path: "",
  url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/pika_h3_flex_ref2va_v1_bf16.safetensors",
  samplingPreset: "pika-6step",
};
const BUNDLED_LORAS = [TAOMATE_LORA, TURBO_LORA, VIGGLE_ANIMATE_LORA, LIGHTX2V_TURBO_LORA, DMAD_LORA, PIKA_FL2VA_LORA, PIKA_REF2VA_LORA];
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
        ...(typeof entry.modelType === "string" && entry.modelType.trim() ? { modelType: entry.modelType.trim() } : {}),
        ...(entry.samplingPreset === "dmad-4step" || entry.samplingPreset === "pika-6step" ? { samplingPreset: entry.samplingPreset as Lora["samplingPreset"] } : {}),
        ...(isSigmaShift(entry.videoSigmaShiftOverride) ? { videoSigmaShiftOverride: entry.videoSigmaShiftOverride } : {}),
        ...(isSigmaShift(entry.audioSigmaShiftOverride) ? { audioSigmaShiftOverride: entry.audioSigmaShiftOverride } : {}),
        ...(entry.needsPreparation === true ? { needsPreparation: true } : {}),
        ...(entry.globallyEnabled === true ? { globallyEnabled: true } : {}),
        ...(isLoraStrength(entry.globalStrength) && entry.globalStrength !== 0 ? { globalStrength: entry.globalStrength } : {}),
        ...(typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? { url: entry.url } : {}),
        ...(isLoraStepOverride(entry.stepOverride) ? { stepOverride: entry.stepOverride }
          : entry.stepOverride === undefined && entry.schedule === "taomate-3step" ? { stepOverride: 3 } : {}) }];
    }) : [];
    for (const lora of BUNDLED_LORAS) if (!ids.has(lora.id)) {
      if (lora.id === TAOMATE_LORA.id) entries.unshift({ ...lora });
      else entries.push({ ...lora });
    }
    return entries;
  } catch { return BUNDLED_LORAS.map((lora) => ({ ...lora })); }
}
export function saveLoras(loras: Lora[]): void {
  if (loras.some((lora) => lora.globalStrength !== undefined && (!isLoraStrength(lora.globalStrength) || lora.globalStrength === 0)))
    throw new Error("Global LoRA strength must be finite, nonzero and within the supported range.");
  const conflict = loraConflict(loras.filter((lora) => lora.globallyEnabled && (lora.modelType ?? "minimax-h3") === "minimax-h3"));
  if (conflict) throw new Error(conflict);
  if (loras.some((lora) => lora.stepOverride !== undefined && !isLoraStepOverride(lora.stepOverride))) {
    throw new Error(`Step override must be a whole number from 2 to ${MAX_GENERATION_STEPS}.`);
  }
  if (loras.some((lora) => [lora.videoSigmaShiftOverride, lora.audioSigmaShiftOverride].some((shift) => shift !== undefined && !isSigmaShift(shift)))) {
    throw new Error("Sigma shift overrides must be finite, positive numbers in the float32 range.");
  }
  localStorage.setItem(KEY, JSON.stringify(loras));
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeLoras(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", storage); };
}

export function moveLibraryLora(id: string, targetId: string): void {
  const library = loadLoras();
  const from = library.findIndex((lora) => lora.id === id), to = library.findIndex((lora) => lora.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [entry] = library.splice(from, 1);
  library.splice(to, 0, entry);
  saveLoras(library);
}
export function normalizeTemplateLoras(value: unknown): TemplateLora[] {
  const ids = new Set<string>();
  return Array.isArray(value) ? value.flatMap((entry) => {
    if (!entry || typeof entry.loraId !== "string" || !entry.loraId || ids.has(entry.loraId)) return [];
    ids.add(entry.loraId);
    return [{ loraId: entry.loraId, enabled: entry.enabled !== false,
      strength: isLoraStrength(entry.strength) ? entry.strength : 1 }];
  }) : [];
}

export function downloadableTemplateLoras(selection: TemplateLora[] = []): Lora[] {
  const active = new Set(selection.filter((entry) => entry.enabled && entry.strength !== 0).map((entry) => entry.loraId));
  return loadLoras().filter((lora) => active.has(lora.id) && lora.url
    && (lora.needsPreparation || !lora.path.trim() || /^https?:\/\//i.test(lora.path)));
}

/** `worker`: generation runs on a LAN worker, which downloads and prepares
 *  URL adapters itself, so only adapters with neither a file nor a URL fail. */
export function resolveTemplateLoras(selection: TemplateLora[] = [], worker = false) {
  const library = loadLoras();
  const conflict = selectionConflict(selection, library);
  if (conflict) throw new Error(conflict);
  return selection.filter((entry) => entry.enabled && entry.strength !== 0).flatMap((entry) => {
    const lora = library.find(({ id }) => id === entry.loraId);
    const strength = entry.strength;
    if (!isLoraStrength(strength)) throw new Error(`Strength for LoRA ${lora?.name ?? entry.loraId} is outside the supported range.`);
    if (worker) {
      const local = lora?.path.trim() && !/^https?:\/\//i.test(lora.path) && !lora.needsPreparation ? lora.path.trim() : undefined;
      const path = local ?? lora?.url;
      if (!path) throw new Error(lora?.needsPreparation ? `Prepare LoRA ${lora.name} in Settings before using it.`
        : `Locate LoRA ${lora?.name ?? entry.loraId}, or disable it in the generator template.`);
      return [{ path, strength, stepOverride: lora?.stepOverride, samplingPreset: lora?.samplingPreset, videoSigmaShiftOverride: lora?.videoSigmaShiftOverride, audioSigmaShiftOverride: lora?.audioSigmaShiftOverride }];
    }
    if (lora?.needsPreparation) throw new Error(`Prepare LoRA ${lora.name} in Settings before using it.`);
    if (!lora?.path.trim() || /^https?:\/\//i.test(lora.path)) {
      throw new Error(`Download or locate LoRA ${lora?.name ?? entry.loraId}, or disable it in the generator template.`);
    }
    return [{ path: lora.path.trim(), strength, stepOverride: lora.stepOverride, samplingPreset: lora.samplingPreset, videoSigmaShiftOverride: lora.videoSigmaShiftOverride, audioSigmaShiftOverride: lora.audioSigmaShiftOverride }];
  });
}

/** Scene choices override templates; global adapters are always applied last.
 * The library order is the execution order, independent of the selection source. */
export function effectiveLoras(selection: TemplateLora[] = [], overrides: TemplateLora[] = [], modelType = "minimax-h3", library = loadLoras()): TemplateLora[] {
  const chosen = new Map(selection.map((entry) => [entry.loraId, entry]));
  for (const entry of overrides) chosen.set(entry.loraId, entry);
  if (modelType === "minimax-h3") for (const lora of library) {
    if (lora.globallyEnabled && (lora.modelType ?? "minimax-h3") === modelType)
      chosen.set(lora.id, { loraId: lora.id, enabled: true, strength: lora.globalStrength ?? 1 });
  }
  const order = new Map(library.map((lora, index) => [lora.id, index]));
  return [...chosen.values()].sort((a, b) => (order.get(a.loraId) ?? Infinity) - (order.get(b.loraId) ?? Infinity));
}

export function loraConflict(loras: Lora[]): string | null {
  if (new Set(loras.flatMap((lora) => lora.samplingPreset ? [lora.samplingPreset] : [])).size > 1)
    return "Active LoRAs require different sampling recipes. Choose either DMAD or Pika H3 Flex.";
  if (loras.some((lora) => lora.id === PIKA_FL2VA_LORA.id) && loras.some((lora) => lora.id === PIKA_REF2VA_LORA.id))
    return "Choose one Pika H3 Flex variant: FL2VA and Ref2VA cannot be enabled together.";
  return null;
}

export function selectionConflict(selection: TemplateLora[], library = loadLoras()): string | null {
  return loraConflict(library.filter((lora) => selection.some((entry) => entry.loraId === lora.id && entry.enabled && entry.strength !== 0)));
}

/** Portable render identity, including recipe changes and the actual stack order. */
export function loraSnapshot(selection: TemplateLora[], library = loadLoras()) {
  return selection.filter((entry) => entry.enabled && entry.strength !== 0).map((entry) => {
    const lora = library.find((lora) => lora.id === entry.loraId);
    return { ...entry, stepOverride: lora?.stepOverride, samplingPreset: lora?.samplingPreset,
      videoSigmaShiftOverride: lora?.videoSigmaShiftOverride, audioSigmaShiftOverride: lora?.audioSigmaShiftOverride };
  });
}

export const MAX_LORA_STRENGTH = 3.4028234663852886e38;

export function isLoraStrength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_LORA_STRENGTH;
}

export function isLoraStepOverride(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= MAX_GENERATION_STEPS;
}

export function highestLoraStepOverride(loras: { stepOverride?: number }[]): number | undefined {
  return loras.reduce<number | undefined>((highest, lora) => isLoraStepOverride(lora.stepOverride)
    ? Math.max(highest ?? 0, lora.stepOverride) : highest, undefined);
}

/** Fixed sampling schedules take priority over editable LoRA step overrides. */
export function loraStepOverride(loras: Pick<Lora, "stepOverride" | "samplingPreset">[]): number | undefined {
  return loras.some((lora) => lora.samplingPreset === "dmad-4step") ? 4
    : loras.some((lora) => lora.samplingPreset === "pika-6step") ? 6 : highestLoraStepOverride(loras);
}

/** Match step overrides: highest active value per stream, with fixed recipes first. */
export function loraSigmaShiftOverrides(loras: Pick<Lora, "videoSigmaShiftOverride" | "audioSigmaShiftOverride" | "samplingPreset">[]): SigmaShifts {
  if (loras.some((lora) => lora.samplingPreset === "dmad-4step")) return { videoSigmaShift: 12, audioSigmaShift: 2 };
  if (loras.some((lora) => lora.samplingPreset === "pika-6step")) return { videoSigmaShift: 12, audioSigmaShift: 3 };
  const highest = (values: (number | undefined)[]) => values.filter(isSigmaShift).reduce<number | undefined>((result, value) => Math.max(result ?? 0, value), undefined);
  return { videoSigmaShift: highest(loras.map((lora) => lora.videoSigmaShiftOverride)), audioSigmaShift: highest(loras.map((lora) => lora.audioSigmaShiftOverride)) };
}
