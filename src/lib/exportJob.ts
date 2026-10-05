/* Export jobs live independently of their views. Images and videos share one
   serial queue, and retain their results in Work Queue after completion.

   The Export screen used to own its run, so leaving the tab unmounted the
   view and cancelled the encode. The run is a promise chain that needs no
   component at all (runExport reads the config snapshot it was given, and
   WebCodecs keeps going whatever React renders), so the state lives in this
   module and the view subscribes to it: switch to the timeline, come back, and
   the progress bar is where it was. One export at a time, app-wide.

   The taskbar button mirrors it (setTaskbarProgress): normal while encoding,
   cleared when the file is saved or the run is cancelled, red when it fails
   until the failure is dismissed or another run starts. */

import { useMemo, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpscaleConfig } from "./upscalers";
import type { ExportPlan, ExportSettings } from "./export";
import { ExportCancelled, runExport, writeExportFile, type ExportProgress } from "./exportPipeline";
import { setTaskbarProgress } from "./nativeShell";
import type { ProjectConfig } from "./project";

export type ExportOutcome =
  | { kind: "saved"; path: string; bytes: number; audioProblems: string[]; audioShortfalls: string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface ExportJobState {
  id: string | null;
  kind: "video" | "image";
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  /** The project folder the run (or its outcome) belongs to. */
  folderPath: string | null;
  /** The project's name, for the work queue and the exit guard. */
  projectName: string | null;
  destination: string | null;
  progress: ExportProgress | null;
  /** Milliseconds left, estimated from the frame rate so far. Null until
   *  enough frames have been rendered to say. */
  remainingMs: number | null;
  outcome: ExportOutcome | null;
  /** Cancel was asked for and the run has not stopped yet. */
  cancelling: boolean;
}

const IDLE: ExportJobState = { id: null, kind: "video", status: "completed", folderPath: null, projectName: null, destination: null, progress: null, remainingMs: null, outcome: null, cancelling: false };

let state: ExportJobState = IDLE;
let jobs: readonly ExportJobState[] = [];
interface PendingExport { id: string; run: () => Promise<void>; resolve: () => void }
let pending: PendingExport[] = [];
let running = false;
let cancelRequested = false;
const listeners = new Set<() => void>();

function set(next: Partial<ExportJobState>) {
  state = { ...state, ...next };
  if (state.id) jobs = jobs.map((job) => job.id === state.id ? state : job);
  listeners.forEach((listener) => listener());
}

export function getExportJob(): ExportJobState {
  return state;
}

export function subscribeExportJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useExportJob(folderPath?: string, kind?: "video" | "image"): ExportJobState {
  const snapshot = () => folderPath ? jobs.find((job) => job.folderPath === folderPath && job.kind === kind && isExportActive(job))
    ?? [...jobs].reverse().find((job) => job.folderPath === folderPath && job.kind === kind) ?? IDLE : state;
  return useSyncExternalStore(subscribeExportJob, snapshot, snapshot);
}

export const getExportJobs = () => jobs;
export const useExportJobs = () => useSyncExternalStore(subscribeExportJob, getExportJobs, getExportJobs);
export const isExportActive = (job: Pick<ExportJobState, "status">) => job.status === "queued" || job.status === "running";
type ExportActivity = Pick<ExportJobState, "id" | "folderPath" | "projectName" | "status">;
const activitySnapshot = () => JSON.stringify(jobs.filter(isExportActive).map(({ id, folderPath, projectName, status }) => ({ id, folderPath, projectName, status })));
/** The app shell needs status changes, not a re-render for every encoded frame. */
export function useExportActivity(): ExportActivity[] {
  const snapshot = useSyncExternalStore(subscribeExportJob, activitySnapshot, activitySnapshot);
  return useMemo(() => JSON.parse(snapshot) as ExportActivity[], [snapshot]);
}
export function clearFinishedExports() { jobs = jobs.filter(isExportActive); listeners.forEach((listener) => listener()); }

function enqueueExport(initial: Pick<ExportJobState, "folderPath" | "projectName" | "destination" | "kind">, run: () => Promise<void>) {
  const id = crypto.randomUUID();
  jobs = [...jobs, { ...IDLE, ...initial, id, status: "queued" }];
  const done = new Promise<void>((resolve) => pending.push({ id, run, resolve }));
  listeners.forEach((listener) => listener());
  pumpExports();
  return done;
}

function pumpExports() {
  if (running || !pending.length) return;
  const next = pending.shift()!;
  running = true;
  state = jobs.find((job) => job.id === next.id)!;
  cancelRequested = false;
  set({ status: "running", progress: { phase: "preparing", framesDone: 0, frameCount: 1, detail: "Starting…" } });
  void next.run().catch((reason) => set({ progress: null, outcome: { kind: "failed", message: String(reason) } })).finally(() => {
    set({ status: state.outcome?.kind === "saved" ? "completed" : state.outcome?.kind === "cancelled" ? "cancelled" : "failed", progress: null, cancelling: false });
    running = false;
    next.resolve();
    pumpExports();
  });
}

export const isExportRunning = () => state.progress !== null;

const runningName = () => state.progress ? state.projectName ?? "" : null;

/** The running export's project name ("" when it has none), or null when
 *  nothing is exporting. Unlike useExportJob it does not re-render on every
 *  progress tick, so App can hold it for the exit guard and the badge. */
export function useRunningExportName(): string | null {
  return useSyncExternalStore(subscribeExportJob, runningName, runningName);
}

/** Fraction done, 0…1, for the bar and the taskbar. */
export const exportFraction = (progress: ExportProgress | null) =>
  !progress || progress.frameCount === 0 ? 0 : Math.min(1, progress.framesDone / progress.frameCount);

/** Stops the running export before the next frame. Nothing has been written
 *  at any point before the end, so there is nothing to clean up. */
export function cancelExportJob(id = state.id) {
  const queued = pending.find((job) => job.id === id);
  if (queued) {
    pending = pending.filter((job) => job !== queued);
    jobs = jobs.map((job) => job.id === id ? { ...job, status: "cancelled", outcome: { kind: "cancelled" } } : job);
    queued.resolve();
    listeners.forEach((listener) => listener());
    return;
  }
  if (id !== state.id || !state.progress) return;
  cancelRequested = true;
  if (state.progress && !state.cancelling) set({ cancelling: true });
  if (state.kind === "image") void invoke("cancel_image_export", { jobId: id }).catch(() => undefined);
}

/** Forgets a finished run's outcome (and clears a red taskbar button). */
export function dismissExportOutcome(id = state.id) {
  const job = jobs.find((item) => item.id === id);
  if (!job || isExportActive(job)) return;
  if (state.id === id) {
    if (state.outcome?.kind === "failed") void setTaskbarProgress(null).catch(() => undefined);
    set({ outcome: null });
  } else {
    jobs = jobs.map((item) => item.id === id ? { ...item, outcome: null } : item);
    listeners.forEach((listener) => listener());
  }
}

export interface StartExportOptions {
  folderPath: string;
  config: ProjectConfig;
  settings: ExportSettings;
  plan: ExportPlan;
  bitrate: number;
  destination: string;
}

/** Renders, encodes and writes one export. Resolves when it has finished,
 *  failed or been cancelled; the outcome is in the store either way. */
export async function startExportJob(options: StartExportOptions): Promise<void> {
  const snapshot = structuredClone(options);
  return enqueueExport({ folderPath: options.folderPath, projectName: options.config.name, destination: options.destination, kind: "video" }, () => runVideoExport(snapshot));
}

async function runVideoExport(options: StartExportOptions): Promise<void> {
  const { folderPath, config, settings, plan, bitrate, destination } = options;
  /* The estimate starts once frames are coming out: mixing and encoder setup
     take their own time, and folding them in would promise hours at frame 1. */
  let clockStart: { at: number; frames: number } | null = null;
  let lastPercent = -1;
  const onProgress = (progress: ExportProgress) => {
    let remainingMs: number | null = null;
    if (progress.phase === "rendering" && progress.framesDone > 0) {
      const now = performance.now();
      clockStart ??= { at: now, frames: progress.framesDone };
      const frames = progress.framesDone - clockStart.frames;
      if (frames >= 5) remainingMs = ((now - clockStart.at) / frames) * (progress.frameCount - progress.framesDone);
    }
    set({ progress, remainingMs: remainingMs ?? (progress.phase === "rendering" ? state.remainingMs : null) });
    const percent = Math.round(exportFraction(progress) * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      void setTaskbarProgress(percent / 100).catch(() => undefined);
    }
  };
  set({
    folderPath,
    projectName: config.name,
    destination,
    outcome: null,
    remainingMs: null,
    cancelling: false,
    progress: { phase: "preparing", framesDone: 0, frameCount: plan.frameCount, detail: "Starting…" },
  });
  void setTaskbarProgress(0).catch(() => undefined);
  try {
    const outcome = await runExport({ folderPath, config, settings, plan, bitrate, onProgress, cancelled: () => cancelRequested });
    if (cancelRequested) throw new ExportCancelled();
    set({
      progress: { phase: "writing", framesDone: plan.frameCount, frameCount: plan.frameCount, detail: "Writing the file…" },
      remainingMs: null,
    });
    const bytes = await writeExportFile(destination, outcome.bytes);
    set({ progress: null, outcome: { kind: "saved", path: destination, bytes, audioProblems: outcome.audioProblems, audioShortfalls: outcome.audioShortfalls } });
    void setTaskbarProgress(null).catch(() => undefined);
  } catch (reason) {
    if (cancelRequested || reason instanceof ExportCancelled) {
      set({ progress: null, outcome: { kind: "cancelled" } });
      void setTaskbarProgress(null).catch(() => undefined);
    } else {
      set({ progress: null, outcome: { kind: "failed", message: reason instanceof Error ? reason.message : String(reason) } });
      void setTaskbarProgress(1, "error").catch(() => undefined);
    }
  } finally {
    cancelRequested = false;
    if (state.cancelling) set({ cancelling: false });
  }
}

export interface ImageExportOptions { format: "jpg" | "png"; width?: number; height?: number; quality?: number; upscale?: UpscaleConfig }
export interface StartImageExportOptions { folderPath: string; projectName: string; relativePath: string; destination: string; options: ImageExportOptions }
export function startImageExportJob(options: StartImageExportOptions): Promise<void> {
  const snapshot = structuredClone(options);
  return enqueueExport({ folderPath: options.folderPath, projectName: options.projectName, destination: options.destination, kind: "image" }, async () => {
    const jobId = state.id!;
    let unlisten: (() => void) | undefined;
    void setTaskbarProgress(0).catch(() => undefined);
    try {
      unlisten = await listen<ExportProgress & { jobId: string }>("export-progress", ({ payload }) => {
        if (payload.jobId === jobId && state.id === jobId && state.status === "running") {
          set({ progress: payload });
          void setTaskbarProgress(exportFraction(payload)).catch(() => undefined);
        }
      });
      if (cancelRequested) throw new ExportCancelled();
      const { projectName: _name, ...args } = snapshot;
      const bytes = await invoke<number>("export_generated_image", { ...args, jobId });
      set({ progress: null, outcome: { kind: "saved", path: snapshot.destination, bytes, audioProblems: [], audioShortfalls: [] } });
      void setTaskbarProgress(null).catch(() => undefined);
    } catch (reason) {
      set({ progress: null, outcome: cancelRequested ? { kind: "cancelled" } : { kind: "failed", message: String(reason) } });
      void setTaskbarProgress(cancelRequested ? null : 1, cancelRequested ? undefined : "error").catch(() => undefined);
    } finally { unlisten?.(); }
  });
}

/** Test hook: put the store in a given state. */
export function setExportJobForTests(next: Partial<ExportJobState>) {
  if (!state.id) { state = { ...IDLE, id: "test-export" }; jobs = [state]; }
  next.status ??= next.progress ? "running" : next.outcome?.kind === "cancelled" ? "cancelled" : "completed";
  set(next);
}

/** Test hook: back to idle. */
export function resetExportJobForTests() {
  cancelRequested = false;
  state = IDLE;
  jobs = []; pending = []; running = false;
  listeners.forEach((listener) => listener());
}
