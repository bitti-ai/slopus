import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./persistence";
import { downloadableTemplateLoras, loadLoras, saveLoras, type Lora } from "./loras";
import { ENGINE_PATH_FIELDS, generatorPathFields, isDownloadUrl, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, templateNeedsDownload,
  type EnginePathId, type GeneratorTemplate, type WeightSource } from "./settings";

export interface WeightGpu { name: string; memoryBytes: number }
export interface DownloadState {
  templateId: string;
  loraId?: string;
  currentLoraId?: string;
  currentAdditionalId?: string;
  name?: string;
  field: EnginePathId | null;
  downloaded: number;
  total: number | null;
  completed: number;
  files: number;
  error: string | null;
  active: boolean;
  phase?: "preparing";
  preparePath?: string;
  allowDownload?: boolean;
}
let state: DownloadState | null = null;
let requestId: string | null = null;
let cancelled = false;
// The download and native event subscription belong to this module. Settings
// only observes progress; unmounting its UI must not stop the transfer or queue.
const subscribers = new Set<() => void>();
export const getWeightDownloadState = () => state;
export const subscribeWeightDownloads = (listener: () => void) => { subscribers.add(listener); return () => { subscribers.delete(listener); }; };
const publish = (next: DownloadState | null) => { state = next; subscribers.forEach((listener) => listener()); };

export function weightDownloadProgress(download: DownloadState): number {
  if (!download.files) return 0;
  const current = (download.field || download.loraId || download.currentLoraId || download.currentAdditionalId) && download.total && download.total > 0
    ? Math.min(1, Math.max(0, download.downloaded / download.total)) : 0;
  return Math.min(download.active ? 99 : 100, 100 * (download.completed + current) / download.files);
}

export function chooseWeightSource(sources: WeightSource[], devices: WeightGpu[]): WeightSource | null {
  // Prefer an explicit GPU match, then the highest memory tier that fits.
  // Equal-ranked alternatives keep the author's order. Unknown hardware only
  // qualifies for universal variants with no minimum memory requirement.
  const matches = sources.filter((source) => !source.gpuModel.trim() && source.minVramGb === 0
    || devices.some((gpu) => gpu.name.toLowerCase().includes(source.gpuModel.trim().toLowerCase())
      // Drivers reserve part of VRAM (a 32 GB card may report 31.4 GiB).
      && Math.ceil(gpu.memoryBytes / 1024 ** 3) >= source.minVramGb));
  return matches.sort((a, b) => Number(Boolean(b.gpuModel.trim())) - Number(Boolean(a.gpuModel.trim())) || b.minVramGb - a.minVramGb)[0] ?? null;
}

export function updateWeightPath(template: GeneratorTemplate, field: EnginePathId, value: string): GeneratorTemplate {
  const sources = { ...template.sources };
  if (isDownloadUrl(value)) {
    const existing = sources[field] ?? [];
    const previous = template.paths[field].trim();
    if (isDownloadUrl(previous) && existing.some((source) => source.url === previous)) {
      sources[field] = existing.map((source) => source.url === previous ? { ...source, url: value.trim(), downloadedPath: undefined } : source);
    } else if (!existing.some((source) => source.url === value.trim())) sources[field] = [{ url: value.trim(), gpuModel: "", minVramGb: 0 }, ...existing];
  }
  return { ...template, paths: { ...template.paths, [field]: value }, sources };
}

let refreshPending: Promise<void> | null = null;
export function refreshDownloadedWeights(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (refreshPending) return refreshPending;
  refreshPending = (async () => {
    await refreshDownloadedLoras();
    const before = loadGeneratorTemplateSettings();
    const paths = [...new Set(before.templates.flatMap((template) => [
      ...generatorPathFields(template).flatMap(({ id }) => (template.sources?.[id] ?? []).flatMap((source) => source.downloadedPath ? [source.downloadedPath] : [])),
      ...(template.additionalSafetensors ?? []).flatMap((file) => file.downloadedPath ? [file.downloadedPath] : []),
    ]))];
    const urls = [...new Set(before.templates.flatMap((template) => [
      ...Object.values(template.sources ?? {}).flatMap((sources) => sources.map((source) => source.url)),
      ...(template.additionalSafetensors ?? []).map((file) => file.url),
    ]))];
    if (!paths.length && !urls.length) return;
    const [exists, found, devices] = await Promise.all([
      paths.length ? invoke<Record<string, boolean>>("check_weight_files", { paths }) : Promise.resolve({} as Record<string, boolean>),
      invoke<Record<string, string>>("find_downloaded_weights", { urls }),
      invoke<WeightGpu[]>("weight_download_hardware"),
    ]);
    const current = loadGeneratorTemplateSettings();
    let changed = false;
    const templates = current.templates.map((template) => {
      const restored = { ...template, paths: { ...template.paths }, sources: { ...template.sources } };
      for (const { id } of generatorPathFields(template)) {
        const sources = template.sources?.[id];
        if (!sources) continue;
        restored.sources[id] = sources.map((source) => {
          const missing = source.downloadedPath && exists?.[source.downloadedPath] === false;
          const discovered = found?.[source.url];
          const downloadedPath = missing || !source.downloadedPath ? discovered : source.downloadedPath;
          if (downloadedPath === source.downloadedPath) return source;
          changed = true;
          if (restored.paths[id] === source.downloadedPath) restored.paths[id] = downloadedPath || source.url;
          const { downloadedPath: _removed, ...remaining } = source;
          return downloadedPath ? { ...remaining, downloadedPath } : remaining;
        });
        if (!restored.paths[id].trim() || isDownloadUrl(restored.paths[id])) {
          const selected = chooseWeightSource(restored.sources[id]!, devices ?? []);
          if (selected?.downloadedPath) { restored.paths[id] = selected.downloadedPath; changed = true; }
        }
      }
      restored.additionalSafetensors = template.additionalSafetensors?.map((file) => {
        if (!before.templates.find(({ id }) => id === template.id)?.additionalSafetensors?.some((old) => old.id === file.id && old.url === file.url && old.downloadedPath === file.downloadedPath)) return file;
        const downloadedPath = file.downloadedPath && exists?.[file.downloadedPath] !== false ? file.downloadedPath : found?.[file.url];
        if (downloadedPath === file.downloadedPath) return file;
        changed = true;
        return { ...file, downloadedPath };
      });
      return restored;
    });
    if (changed) {
      saveGeneratorTemplateSettings({ ...current, templates });
      if (state && !state.active && templates.some((template) => template.id === state?.templateId && templateNeedsDownload(template))) publish(null);
    }
  })().finally(() => { refreshPending = null; });
  return refreshPending;
}

export async function downloadTemplateWeights(templateId: string): Promise<void> {
  if (!isTauri() || state?.active) return;
  cancelled = false;
  publish({ templateId, field: null, downloaded: 0, total: null, completed: 0, files: 0, error: null, active: true });
  let unlisten: (() => void) | undefined;
  try {
    await refreshDownloadedWeights();
    const template = loadGeneratorTemplateSettings().templates.find((template) => template.id === templateId);
    if (!template) throw new Error("This generator was removed.");
    const devices = await invoke<WeightGpu[]>("weight_download_hardware");
    const downloads = generatorPathFields(template).flatMap(({ id }) => {
      if (template.paths[id].trim() && !isDownloadUrl(template.paths[id])) return [];
      const sources = template.sources?.[id] ?? [];
      if (!sources.length) return [];
      const source = chooseWeightSource(sources, devices ?? []);
      if (!source) throw new Error(`No ${ENGINE_PATH_FIELDS.find((field) => field.id === id)?.label} download matches this GPU and its memory.`);
      return [{ field: id, source, originalPath: template.paths[id] }];
    });
    const loraDownloads = downloadableTemplateLoras(template.loras);
    const additionalDownloads = (template.additionalSafetensors ?? []).filter((file) => !file.downloadedPath);
    publish({ ...state!, files: downloads.length + loraDownloads.length + additionalDownloads.length });
    unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
      if (payload.requestId === requestId && state?.active) publish({ ...state, downloaded: payload.downloaded, total: payload.total });
    });
    for (const { field, source, originalPath } of downloads) {
      if (cancelled) throw new Error("Download cancelled.");
      requestId = crypto.randomUUID();
      publish({ ...state!, field, downloaded: 0, total: null });
      const path = source.downloadedPath ?? await invoke<string>("download_weight", { requestId, url: source.url });
      if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
      const current = loadGeneratorTemplateSettings();
      const templates = current.templates.map((template) => {
        if (template.id !== templateId) return template;
        // A download finishing must not overwrite edits made while it ran.
        const sources = template.sources?.[field];
        if (!sources?.some((entry) => entry.url === source.url)) return template;
        return { ...template,
          paths: template.paths[field] === originalPath ? { ...template.paths, [field]: path } : template.paths,
          sources: { ...template.sources, [field]: sources.map((entry) => entry.url === source.url ? { ...entry, downloadedPath: path } : entry) },
        };
      });
      saveGeneratorTemplateSettings({ ...current, templates });
      publish({ ...state!, completed: state!.completed + 1, field: null, downloaded: 0, total: null });
    }
    for (const file of additionalDownloads) {
      if (cancelled) throw new Error("Download cancelled.");
      requestId = crypto.randomUUID();
      publish({ ...state!, currentAdditionalId: file.id, downloaded: 0, total: null });
      const path = await invoke<string>("download_weight", { requestId, url: file.url });
      if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
      const current = loadGeneratorTemplateSettings();
      saveGeneratorTemplateSettings({ ...current, templates: current.templates.map((template) => template.id !== templateId ? template : {
        ...template, additionalSafetensors: template.additionalSafetensors?.map((entry) =>
          entry.id === file.id && entry.url === file.url && entry.downloadedPath === file.downloadedPath ? { ...entry, downloadedPath: path } : entry),
      }) });
      publish({ ...state!, completed: state!.completed + 1, currentAdditionalId: undefined, downloaded: 0, total: null });
    }
    for (const lora of loraDownloads) {
      if (cancelled) throw new Error("Download cancelled.");
      publish({ ...state!, currentLoraId: lora.id, downloaded: 0, total: null });
      await transferLora(lora);
      publish({ ...state!, completed: state!.completed + 1, currentLoraId: undefined, downloaded: 0, total: null });
    }
    publish({ ...state!, active: false });
  } catch (reason) {
    publish({ ...state!, active: false, error: reason instanceof Error ? reason.message : String(reason) });
  } finally {
    requestId = null;
    unlisten?.();
  }
}

export async function cancelWeightDownload() {
  // The DLL preparation call is synchronous and has no cancellation API.
  if (state?.active && state.phase === "preparing") return;
  cancelled = true;
  if (requestId) await invoke("cancel_weight_download", { requestId });
}

async function transferLora(lora: Lora): Promise<void> {
  requestId = crypto.randomUUID();
  const path = await invoke<string>("download_weight", { requestId, url: lora.url });
  if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
  if (cancelled) throw new Error("Download cancelled.");
  saveLoras(loadLoras().map((entry) => entry.id === lora.id && entry.path === lora.path ? { ...entry, needsPreparation: true } : entry));
  await prepareLoraFile(path, true);
  saveLoras(loadLoras().map((entry) => entry.id === lora.id && entry.url === lora.url && entry.path === lora.path ? { ...entry, path, needsPreparation: undefined } : entry));
  publish({ ...state!, phase: undefined });
}

async function prepareLoraFile(path: string, allowDownload: boolean): Promise<void> {
  requestId = null;
  publish({ ...state!, phase: "preparing", downloaded: 0, total: null });
  await invoke("prepare_lora", { path, allowDownload });
}

/** Explicit setup for a local or previously downloaded adapter. */
export async function prepareLora(lora: Pick<Lora, "id" | "name" | "path">, allowDownload = true): Promise<void> {
  if (!isTauri()) throw new Error("LoRA preparation is available in the desktop app.");
  if (state?.active) throw new Error("Wait for the current download or preparation to finish.");
  publish({ templateId: `lora:${lora.id}`, loraId: lora.id, name: lora.name, field: null,
    downloaded: 0, total: null, completed: 0, files: 1, error: null, active: true,
    preparePath: lora.path, allowDownload, phase: "preparing" });
  try {
    saveLoras(loadLoras().map((entry) => entry.id === lora.id && entry.path === lora.path ? { ...entry, needsPreparation: true } : entry));
    await prepareLoraFile(lora.path, allowDownload);
    saveLoras(loadLoras().map((entry) => entry.id === lora.id && entry.path === lora.path ? { ...entry, needsPreparation: undefined } : entry));
    publish({ ...state!, active: false, completed: 1 });
  } catch (reason) {
    publish({ ...state!, active: false, error: reason instanceof Error ? reason.message : String(reason) });
    throw reason;
  }
}

/** Uses the same native transfer, storage, cancellation and app-wide lock as weights. */
export async function downloadLora(loraId: string): Promise<void> {
  if (!isTauri() || state?.active) return;
  const lora = loadLoras().find(({ id }) => id === loraId);
  if (!lora?.url) return;
  cancelled = false;
  publish({ templateId: `lora:${loraId}`, loraId, name: lora.name, field: null,
    downloaded: 0, total: null, completed: 0, files: 1, error: null, active: true });
  let unlisten: (() => void) | undefined;
  try {
    unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
      if (payload.requestId === requestId && state?.active) publish({ ...state, downloaded: payload.downloaded, total: payload.total });
    });
    if (cancelled) throw new Error("Download cancelled.");
    await transferLora(lora);
    publish({ ...state!, completed: 1, active: false });
  } catch (reason) {
    publish({ ...state!, active: false, error: reason instanceof Error ? reason.message : String(reason) });
  } finally { requestId = null; unlisten?.(); }
}

export function retryWeightDownload(): Promise<void> {
  if (state?.preparePath && state.loraId) return prepareLora({ id: state.loraId, name: state.name ?? "LoRA", path: state.preparePath }, state.allowDownload)
    .catch(() => undefined); // The shared status retains the error for another retry.
  return state?.loraId ? downloadLora(state.loraId) : state ? downloadTemplateWeights(state.templateId) : Promise.resolve();
}

let loraRefreshPending: Promise<void> | null = null;
export function refreshDownloadedLoras(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (state?.active) return Promise.resolve();
  if (loraRefreshPending) return loraRefreshPending;
  loraRefreshPending = (async () => {
    const before = loadLoras().filter((entry) => entry.url);
    const paths = before.filter((entry) => entry.path && !isDownloadUrl(entry.path)).map(({ path }) => path);
    const urls = [...new Set(before.map((entry) => entry.url!))];
    if (!urls.length) return;
    const [exists, found] = await Promise.all([
      paths.length ? invoke<Record<string, boolean>>("check_weight_files", { paths }) : Promise.resolve({} as Record<string, boolean>),
      invoke<Record<string, string>>("find_downloaded_weights", { urls }),
    ]);
    let changed = false;
    const loras = loadLoras().map((entry) => {
      if (entry.needsPreparation) return entry;
      if (!entry.url || !before.some((old) => old.id === entry.id && old.url === entry.url && old.path === entry.path)) return entry;
      if (entry.path.trim() && !isDownloadUrl(entry.path) && exists?.[entry.path] !== false) return entry;
      const path = found?.[entry.url] || "";
      if (entry.path === path) return entry;
      changed = true;
      return { ...entry, path };
    });
    if (changed) saveLoras(loras);
  })().finally(() => { loraRefreshPending = null; });
  return loraRefreshPending;
}

export async function removeLora(loraId: string): Promise<void> {
  if (state?.active) return;
  const lora = loadLoras().find(({ id }) => id === loraId);
  if (!lora) return;
  // Manual imports are links to the user's file; removing them never deletes it.
  if (lora.url && lora.path) {
    if (!isTauri()) return;
    await invoke("remove_downloaded_weights", { paths: [lora.path] });
  }
  saveLoras(loadLoras().flatMap((entry) => entry.id !== loraId ? [entry] : entry.url ? [{ ...entry, path: "" }] : []));
  if (state?.loraId === loraId) publish(null);
  await refreshDownloadedLoras();
}

export async function removeTemplateWeights(templateId: string): Promise<void> {
  if (!isTauri() || state?.active) return;
  const template = loadGeneratorTemplateSettings().templates.find((template) => template.id === templateId);
  if (!template) return;
  const paths = [...new Set([
    ...generatorPathFields(template).flatMap(({ id }) => (template.sources?.[id] ?? []).flatMap((source) => source.downloadedPath ? [source.downloadedPath] : [])),
    ...(template.additionalSafetensors ?? []).flatMap((file) => file.downloadedPath ? [file.downloadedPath] : []),
  ])];
  try {
    await invoke("remove_downloaded_weights", { paths });
    const current = loadGeneratorTemplateSettings();
    const templates = current.templates.map((template) => {
      if (template.id !== templateId) return template;
      const restored = { ...template, paths: { ...template.paths }, sources: { ...template.sources } };
      restored.additionalSafetensors = template.additionalSafetensors?.map((file) => paths.includes(file.downloadedPath ?? "") ? { ...file, downloadedPath: undefined } : file);
      for (const { id } of generatorPathFields(template)) {
        const sources = template.sources?.[id];
        if (!sources?.length) continue;
        restored.paths[id] = (sources.find((source) => source.downloadedPath === template.paths[id]) ?? sources[0]).url;
        restored.sources[id] = sources.map(({ downloadedPath: _removed, ...source }) => source);
      }
      return restored;
    });
    saveGeneratorTemplateSettings({ ...current, templates });
    if (state?.templateId === templateId) publish(null);
  } finally {
    // Shared weights removed from one template become downloadable in every
    // template that referred to that same file, including after a partial failure.
    await refreshDownloadedWeights();
  }
}
