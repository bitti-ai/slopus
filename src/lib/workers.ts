/* LAN generation workers (Settings → Workers).
 *
 * Rust owns the selection and routes every generation command to the chosen
 * worker, so nothing else in the webview changes. This module mirrors the
 * selection in localStorage only so synchronous code (which generator
 * templates are usable, which weight variant to send) can read it. */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./persistence";

export interface WorkerGpu { name: string; memoryBytes: number }

export interface WorkerRuntime {
  state: string;
  version: string | null;
  platform: string | null;
  cudaAvailable: boolean;
  cudaDeviceNames: string[];
  detail: string;
}

export interface GenerationWorker {
  /** The worker id, or the address of a manual worker never reached. */
  key: string;
  id: string | null;
  name: string;
  address: string | null;
  online: boolean;
  compatible: boolean;
  discovered: boolean;
  manual: boolean;
  selected: boolean;
  version: string | null;
  requiresToken: boolean;
  hasToken: boolean;
  gpus: WorkerGpu[];
  runtime: WorkerRuntime | null;
  error: string | null;
}

export interface WorkerList { selectedId: string | null; workers: GenerationWorker[] }

export interface SelectedWorker { id: string; name: string; gpus: WorkerGpu[] }

const KEY = "slopus.generation-worker.v1";
export const WORKERS_EVENT = "slopus:workers-changed";

export function selectedWorker(): SelectedWorker | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { id, name, gpus } = value as Partial<SelectedWorker>;
    if (typeof id !== "string" || !id) return null;
    return { id, name: typeof name === "string" ? name : "Worker",
      gpus: Array.isArray(gpus) ? gpus.filter((gpu) => typeof gpu?.name === "string" && typeof gpu.memoryBytes === "number") : [] };
  } catch {
    return null;
  }
}

/** True when generation runs on a LAN worker instead of this computer. */
export const remoteWorkerSelected = (): boolean => selectedWorker() !== null;

function mirror(list: WorkerList) {
  const previous = selectedWorker();
  const worker = list.workers.find((item) => item.id === list.selectedId);
  const next: SelectedWorker | null = list.selectedId
    ? { id: list.selectedId, name: worker?.name ?? previous?.name ?? "Worker", gpus: worker?.online ? worker.gpus : previous?.gpus ?? [] }
    : null;
  if (JSON.stringify(next) === JSON.stringify(previous)) return;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    /* Rust still routes correctly; only template filtering may lag. */
  }
  window.dispatchEvent(new Event(WORKERS_EVENT));
}

let list: WorkerList | null = null;
const subscribers = new Set<() => void>();
export const getWorkerList = () => list;
export function subscribeWorkers(listener: () => void) {
  subscribers.add(listener);
  window.addEventListener(WORKERS_EVENT, listener);
  return () => { subscribers.delete(listener); window.removeEventListener(WORKERS_EVENT, listener); };
}

function publish(next: WorkerList): WorkerList {
  list = next;
  mirror(next);
  subscribers.forEach((listener) => listener());
  return next;
}

let pending: Promise<WorkerList> | null = null;
/** Asks every known and announced worker for its status. */
export function refreshWorkers(): Promise<WorkerList> {
  if (!isTauri()) return Promise.resolve(publish({ selectedId: null, workers: [] }));
  pending ??= invoke<WorkerList>("list_workers").then(publish).finally(() => { pending = null; });
  return pending;
}

export const selectWorker = async (id: string | null) => publish(await invoke<WorkerList>("select_worker", { id }));
export const addWorker = async (address: string) => publish(await invoke<WorkerList>("add_worker", { address }));
export const removeWorker = async (key: string) => publish(await invoke<WorkerList>("remove_worker", { key }));
export const setWorkerToken = async (id: string, token: string) => publish(await invoke<WorkerList>("set_worker_token", { id, token }));

/** Follows mDNS announcements for the life of the app. */
export function startWorkerDiscovery(): () => void {
  if (!isTauri()) return () => undefined;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const refresh = () => { void refreshWorkers().catch(() => undefined); };
  void listen("workers-changed", () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; });
  refresh();
  return () => { disposed = true; clearTimeout(timer); stop?.(); };
}
