import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./persistence";
import { askNative } from "./nativeShell";
import { OTHER_WEIGHT_TEMPLATES, refreshOtherWeights, otherWeightPaths, saveOtherWeightPath } from "./upscalers";
import { effectiveLoras, downloadableTemplateLoras, loadLoras, saveLoras, type Lora } from "./loras";
import { chooseWeightSource, ENGINE_PATH_FIELDS, generatorPathFields, isDownloadUrl, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, templateNeedsDownload,
  type EnginePathId, type GeneratorTemplate, type WeightGpu, type WeightSource } from "./settings";

export type { WeightGpu } from "./settings";
import { h3ComponentForField, type H3ComponentTemplate } from "./h3Components";
export { chooseWeightSource };

const gpuSources = (sources: WeightSource[], devices: WeightGpu[]) => sources.filter((source) =>
  !source.gpuModel.trim() || devices.some((gpu) => gpu.name.toLowerCase().includes(source.gpuModel.trim().toLowerCase())));

// Downloads may proceed after a VRAM warning. Unknown hardware also uses the
// smallest variant, but GPU model restrictions still apply.
function chooseDownloadSource(sources: WeightSource[], devices: WeightGpu[]): WeightSource | null {
  return chooseWeightSource(sources, devices)
    ?? gpuSources(sources, devices).sort((a, b) => a.minVramGb - b.minVramGb)[0] ?? null;
}

async function confirmDownloadVram(name: string, weights: { label: string; sources: WeightSource[] }[], devices: WeightGpu[]): Promise<boolean> {
  const known = devices.filter((gpu) => Number.isFinite(gpu.memoryBytes) && gpu.memoryBytes > 0);
  if (!known.length) return true;
  const shortages = weights.flatMap(({ label, sources }) => {
    const candidates = gpuSources(sources, known);
    if (!candidates.length || chooseWeightSource(candidates, known)) return [];
    const minimum = Math.min(...candidates.map((source) => source.minVramGb));
    return [`${label}: at least ${minimum} GB VRAM`];
  });
  if (!shortages.length) return true;
  return askNative({ title: "Not enough GPU memory", kind: "warning",
    message: `${name} has weights whose download variants all require more VRAM than the matching GPU has.\n\nDetected GPU capacity:\n${known.map((gpu) => `${gpu.name}: ${Math.ceil(gpu.memoryBytes / 1024 ** 3)} GB VRAM`).join("\n")}\n\n${shortages.join("\n")}\n\nGeneration may run out of GPU memory. Download anyway?`,
    okLabel: "Download anyway", cancelLabel: "Cancel" });
}

export interface DownloadState {
  templateId: string;
  otherWeightId?: string;
  h3ComponentId?: string;
  currentFile?: string;
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

interface QueuedDownload { state: DownloadState; run: () => Promise<void>; done: Promise<void>; resolve: () => void; reject: (reason: unknown) => void }
let pending: QueuedDownload[] = [];
let running: QueuedDownload | null = null;
let queued: readonly DownloadState[] = [];
export const getQueuedWeightDownloads = () => queued;
const publishQueue = () => { queued = pending.map((job) => job.state); subscribers.forEach((listener) => listener()); };

function enqueueDownload(initial: Pick<DownloadState, "templateId" | "name" | "loraId" | "otherWeightId" | "h3ComponentId">, run: () => Promise<void>): Promise<void> {
  const existing = [running, ...pending].find((job) => job?.state.templateId === initial.templateId);
  if (existing) return existing.done;
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  pending.push({ state: { ...initial, field: null, downloaded: 0, total: null, completed: 0, files: 0, error: null, active: false }, run, done, resolve, reject });
  pumpDownloads();
  publishQueue();
  return done;
}

function pumpDownloads() {
  if (running || !pending.length) return;
  const job = pending.shift()!;
  running = job;
  cancelled = false;
  const finish = () => { running = null; pumpDownloads(); publishQueue(); };
  // Wait for the transfer and event-listener cleanup before starting the next job.
  void job.run().then(() => { finish(); job.resolve(); }, (reason) => { finish(); job.reject(reason); });
}

export function cancelQueuedWeightDownload(templateId: string) {
  const job = pending.find((entry) => entry.state.templateId === templateId);
  pending = pending.filter((entry) => entry !== job);
  job?.resolve();
  publishQueue();
}

export function weightDownloadProgress(download: DownloadState): number {
  if (!download.files) return 0;
  const current = (download.field || download.loraId || download.currentLoraId || download.currentAdditionalId) && download.total && download.total > 0
    ? Math.min(1, Math.max(0, download.downloaded / download.total)) : 0;
  return Math.min(download.active ? 99 : 100, 100 * (download.completed + current) / download.files);
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

function saveH3Download(before: H3ComponentTemplate, tokenizer: boolean, url: string, path: string) {
  const current = loadGeneratorTemplateSettings();
  const library = current.h3Components!;
  saveGeneratorTemplateSettings({ ...current, h3Components: { ...library, templates: library.templates.map((entry) => {
    if (entry.id !== before.id) return entry;
    if (tokenizer) return entry.tokenizer === before.tokenizer ? { ...entry, tokenizer: path, tokenizerUrl: url } : entry;
    if (!entry.sources.some((source) => source.url === url)) return entry;
    return { ...entry, path: entry.path === before.path ? path : entry.path,
      sources: entry.sources.map((source) => source.url === url ? { ...source, downloadedPath: path } : source) };
  }) } });
}

async function refreshH3Components() {
  const before = loadGeneratorTemplateSettings().h3Components!;
  const paths = [...new Set(before.templates.flatMap((entry) => [
    ...(entry.path && !isDownloadUrl(entry.path) ? [entry.path] : []),
    ...entry.sources.flatMap((source) => source.downloadedPath ? [source.downloadedPath] : []),
    ...(entry.tokenizerUrl && entry.tokenizer && !isDownloadUrl(entry.tokenizer) ? [entry.tokenizer] : []),
  ]))];
  const urls = [...new Set(before.templates.flatMap((entry) => [...entry.sources.map((source) => source.url), ...(entry.tokenizerUrl ? [entry.tokenizerUrl] : [])]))];
  const [exists, found, devices] = await Promise.all([
    paths.length ? invoke<Record<string, boolean>>("check_weight_files", { paths }) : Promise.resolve({} as Record<string, boolean>),
    urls.length ? invoke<Record<string, string>>("find_downloaded_weights", { urls }) : Promise.resolve({} as Record<string, string>),
    invoke<WeightGpu[]>("weight_download_hardware"),
  ]);
  const current = loadGeneratorTemplateSettings();
  const library = current.h3Components!;
  let changed = false;
  const templates = library.templates.map((entry) => {
    if (!before.templates.some((old) => old.id === entry.id && JSON.stringify(old) === JSON.stringify(entry))) return entry;
    const sources = entry.sources.map((source) => ({ ...source,
      downloadedPath: source.downloadedPath && exists?.[source.downloadedPath] !== false ? source.downloadedPath : found?.[source.url] }));
    let path = entry.path;
    if (!path || isDownloadUrl(path) || exists?.[path] === false) {
      const source = chooseDownloadSource(sources, devices ?? []);
      path = source?.downloadedPath ?? source?.url ?? (exists?.[path] === false ? "" : path);
    }
    const tokenizer = entry.tokenizerUrl && (!entry.tokenizer || isDownloadUrl(entry.tokenizer) || exists?.[entry.tokenizer] === false)
      ? found?.[entry.tokenizerUrl] ?? entry.tokenizerUrl : entry.tokenizer;
    const next = { ...entry, sources, path, ...(tokenizer !== undefined ? { tokenizer } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(entry)) changed = true;
    return next;
  });
  if (changed) saveGeneratorTemplateSettings({ ...current, h3Components: { ...library, templates } });
}

export function downloadH3Component(id: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const component = loadGeneratorTemplateSettings().h3Components?.templates.find((entry) => entry.id === id);
  return enqueueDownload({ templateId: `h3:${id}`, h3ComponentId: id, name: component?.name }, async () => {
    publish({ templateId: `h3:${id}`, h3ComponentId: id, name: component?.name, field: null,
      downloaded: 0, total: null, completed: 0, files: 0, error: null, active: true });
    let unlisten: (() => void) | undefined;
    try {
      await refreshH3Components();
      const entry = loadGeneratorTemplateSettings().h3Components!.templates.find((item) => item.id === id);
      if (!entry) throw new Error("This template was removed.");
      const devices = await invoke<WeightGpu[]>("weight_download_hardware");
      const source = chooseDownloadSource(entry.sources, devices ?? []);
      const downloads: { source: WeightSource; tokenizer: boolean }[] = [];
      if (!entry.path || isDownloadUrl(entry.path)) {
        if (!source) throw new Error("No download source matches this GPU and its memory.");
        downloads.push({ source, tokenizer: false });
      }
      if (entry.tokenizer && isDownloadUrl(entry.tokenizer)) downloads.push({ source: { url: entry.tokenizer, gpuModel: "", minVramGb: 0 }, tokenizer: true });
      if (downloads.length && !await confirmDownloadVram(entry.name, [{ label: entry.name, sources: entry.sources }], devices ?? [])) {
        publish({ ...state!, active: false });
        return;
      }
      if (cancelled) throw new Error("Download cancelled.");
      publish({ ...state!, files: downloads.length });
      unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
        if (payload.requestId === requestId && state?.active) publish({ ...state, downloaded: payload.downloaded, total: payload.total });
      });
      for (const { source, tokenizer } of downloads) {
        if (cancelled) throw new Error("Download cancelled.");
        requestId = crypto.randomUUID();
        publish({ ...state!, field: tokenizer ? "tokenizer" : entry.type === "video" ? "videoVae" : entry.type === "audio" ? "audioVae" : "textEncoder", downloaded: 0, total: null });
        const path = source.downloadedPath ?? await invoke<string>("download_weight", { requestId, url: source.url });
        if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
        saveH3Download(entry, tokenizer, source.url, path);
        publish({ ...state!, completed: state!.completed + 1 });
      }
      publish({ ...state!, active: false, field: null });
    } catch (reason) {
      publish({ ...state!, active: false, error: reason instanceof Error ? reason.message : String(reason) });
    } finally { requestId = null; unlisten?.(); }
  });
}

let refreshPending: Promise<void> | null = null;
export function refreshDownloadedWeights(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (refreshPending) return refreshPending;
  refreshPending = (async () => {
    await refreshDownloadedLoras();
    await refreshH3Components();
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
          const selected = chooseDownloadSource(restored.sources[id]!, devices ?? []);
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

export function downloadTemplateWeights(templateId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueueDownload({ templateId, name: loadGeneratorTemplateSettings().templates.find((template) => template.id === templateId)?.name }, () => runTemplateDownload(templateId));
}

async function runTemplateDownload(templateId: string): Promise<void> {
  cancelled = false;
  publish({ templateId, field: null, downloaded: 0, total: null, completed: 0, files: 0, error: null, active: true });
  let unlisten: (() => void) | undefined;
  try {
    await refreshDownloadedWeights();
    const template = loadGeneratorTemplateSettings().templates.find((template) => template.id === templateId);
    if (!template) throw new Error("This generator was removed.");
    const devices = await invoke<WeightGpu[]>("weight_download_hardware");
    const downloads = generatorPathFields(template).flatMap(({ id, label, required }) => {
      if (template.paths[id].trim() && !isDownloadUrl(template.paths[id])) return [];
      const sources = template.sources?.[id] ?? [];
      if (!sources.length && required && template.modelType === "minimax-h3" && id !== "transformer") throw new Error(`Choose a ${label} template with a local file or download URL.`);
      if (!sources.length) return [];
      const source = chooseDownloadSource(sources, devices ?? []);
      if (!source) throw new Error(`No ${ENGINE_PATH_FIELDS.find((field) => field.id === id)?.label} download matches this GPU and its memory.`);
      return [{ field: id, source, originalPath: template.paths[id], component: h3ComponentForField(template, id, loadGeneratorTemplateSettings().h3Components!) }];
    });
    const loraDownloads = downloadableTemplateLoras(effectiveLoras(template.loras, [], template.modelType));
    const additionalDownloads = (template.additionalSafetensors ?? []).filter((file) => !file.downloadedPath);
    const weights = generatorPathFields(template).map(({ id, label }) => {
      const path = template.paths[id].trim();
      const sources = template.sources?.[id] ?? [];
      // A known local weight still constrains the generator. Unidentified local
      // files have no trustworthy minimum and must not inherit a URL's limit.
      return { label, sources: path && !isDownloadUrl(path)
        ? sources.filter((source) => source.downloadedPath === path) : sources };
    });
    if (downloads.length + loraDownloads.length + additionalDownloads.length
      && !await confirmDownloadVram(template.name, weights, devices ?? [])) {
      publish({ ...state!, active: false });
      return;
    }
    if (cancelled) throw new Error("Download cancelled.");
    publish({ ...state!, files: downloads.length + loraDownloads.length + additionalDownloads.length });
    unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
      if (payload.requestId === requestId && state?.active) publish({ ...state, downloaded: payload.downloaded, total: payload.total });
    });
    for (const { field, source, originalPath, component } of downloads) {
      if (cancelled) throw new Error("Download cancelled.");
      requestId = crypto.randomUUID();
      publish({ ...state!, field, downloaded: 0, total: null });
      const path = source.downloadedPath ?? await invoke<string>("download_weight", { requestId, url: source.url });
      if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
      if (component) saveH3Download(component, field === "tokenizer", source.url, path);
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
export function prepareLora(lora: Pick<Lora, "id" | "name" | "path">, allowDownload = true): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error("LoRA preparation is available in the desktop app."));
  return enqueueDownload({ templateId: `lora:${lora.id}`, loraId: lora.id, name: lora.name }, () => runLoraPreparation(lora, allowDownload));
}

async function runLoraPreparation(lora: Pick<Lora, "id" | "name" | "path">, allowDownload: boolean): Promise<void> {
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
export function downloadLora(loraId: string): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return enqueueDownload({ templateId: `lora:${loraId}`, loraId, name: loadLoras().find((lora) => lora.id === loraId)?.name }, () => runLoraDownload(loraId));
}

async function runLoraDownload(loraId: string): Promise<void> {
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
  if (state?.h3ComponentId) return downloadH3Component(state.h3ComponentId);
  if (state?.otherWeightId) return downloadOtherWeights(state.otherWeightId);
  if (state?.preparePath && state.loraId) return prepareLora({ id: state.loraId, name: state.name ?? "LoRA", path: state.preparePath }, state.allowDownload)
    .catch(() => undefined); // The shared status retains the error for another retry.
  return state?.loraId ? downloadLora(state.loraId) : state ? downloadTemplateWeights(state.templateId) : Promise.resolve();
}

export function downloadOtherWeights(id: string): Promise<void> {
  const template = OTHER_WEIGHT_TEMPLATES.find((item) => item.id === id);
  if (!isTauri() || !template) return Promise.resolve();
  return enqueueDownload({ templateId: `other:${id}`, otherWeightId: id, name: template.name }, async () => {
    publish({ templateId: `other:${id}`, otherWeightId: id, name: template.name, field: null,
      downloaded: 0, total: null, completed: 0, files: template.files.length, error: null, active: true });
    let unlisten: (() => void) | undefined;
    try {
      await refreshOtherWeights();
      unlisten = await listen<{ requestId: string; downloaded: number; total: number | null }>("weight-download-progress", ({ payload }) => {
        if (payload.requestId === requestId && state?.active) publish({ ...state, downloaded: payload.downloaded, total: payload.total });
      });
      for (const file of template.files) {
        if (cancelled) throw new Error("Download cancelled.");
        requestId = crypto.randomUUID();
        publish({ ...state!, currentAdditionalId: file.id, currentFile: file.name, downloaded: 0, total: null });
        const existing = otherWeightPaths()[file.url];
        const path = existing ?? await invoke<string>("download_weight", { requestId, url: file.url });
        if (!path || isDownloadUrl(path)) throw new Error("The download did not return a local file.");
        if (!existing) saveOtherWeightPath(file.url, path);
        if (cancelled) throw new Error("Download cancelled.");
        publish({ ...state!, completed: state!.completed + 1, currentAdditionalId: undefined, currentFile: undefined, downloaded: 0, total: null });
      }
      publish({ ...state!, active: false });
    } catch (reason) {
      publish({ ...state!, active: false, error: reason instanceof Error ? reason.message : String(reason) });
    } finally { requestId = null; unlisten?.(); }
  });
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
    ...generatorPathFields(template).filter(({ id }) => template.modelType !== "minimax-h3" || id === "transformer").flatMap(({ id }) => (template.sources?.[id] ?? []).flatMap((source) => source.downloadedPath ? [source.downloadedPath] : [])),
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
        if (template.modelType === "minimax-h3" && id !== "transformer") continue;
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
