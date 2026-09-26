/* The export that is running — held here rather than in ExportView.

   The Export screen used to own its run, so leaving the tab unmounted the
   view and cancelled the encode. The run is a promise chain that needs no
   component at all (runExport reads the config snapshot it was given, and
   WebCodecs keeps going whatever React renders), so the state lives in this
   module and the view subscribes to it: switch to the timeline, come back, and
   the progress bar is where it was. One export at a time, app-wide.

   The taskbar button mirrors it (setTaskbarProgress): normal while encoding,
   cleared when the file is saved or the run is cancelled, red when it fails
   until the failure is dismissed or another run starts. */

import { useSyncExternalStore } from "react";
import type { ExportPlan, ExportSettings } from "./export";
import { ExportCancelled, runExport, writeExportFile, type ExportProgress } from "./exportPipeline";
import { setTaskbarProgress } from "./nativeShell";
import type { ProjectConfig } from "./project";

export type ExportOutcome =
  | { kind: "saved"; path: string; bytes: number; audioProblems: string[]; audioShortfalls: string[] }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface ExportJobState {
  /** The project folder the run (or its outcome) belongs to. */
  folderPath: string | null;
  destination: string | null;
  progress: ExportProgress | null;
  /** Milliseconds left, estimated from the frame rate so far. Null until
   *  enough frames have been rendered to say. */
  remainingMs: number | null;
  outcome: ExportOutcome | null;
}

const IDLE: ExportJobState = { folderPath: null, destination: null, progress: null, remainingMs: null, outcome: null };

let state: ExportJobState = IDLE;
let cancelRequested = false;
const listeners = new Set<() => void>();

function set(next: Partial<ExportJobState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

export function getExportJob(): ExportJobState {
  return state;
}

export function subscribeExportJob(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useExportJob(): ExportJobState {
  return useSyncExternalStore(subscribeExportJob, getExportJob, getExportJob);
}

export const isExportRunning = () => state.progress !== null;

/** Fraction done, 0…1, for the bar and the taskbar. */
export const exportFraction = (progress: ExportProgress | null) =>
  !progress || progress.frameCount === 0 ? 0 : Math.min(1, progress.framesDone / progress.frameCount);

/** Stops the running export before the next frame. Nothing has been written
 *  at any point before the end, so there is nothing to clean up. */
export function cancelExportJob() {
  cancelRequested = true;
}

/** Forgets a finished run's outcome (and clears a red taskbar button). */
export function dismissExportOutcome() {
  if (state.progress) return;
  if (state.outcome?.kind === "failed") void setTaskbarProgress(null).catch(() => undefined);
  set({ outcome: null });
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
  if (isExportRunning()) throw new Error("An export is already running.");
  const { folderPath, config, settings, plan, bitrate, destination } = options;
  cancelRequested = false;
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
    destination,
    outcome: null,
    remainingMs: null,
    progress: { phase: "preparing", framesDone: 0, frameCount: plan.frameCount, detail: "Starting…" },
  });
  void setTaskbarProgress(0).catch(() => undefined);
  try {
    const outcome = await runExport({ folderPath, config, settings, plan, bitrate, onProgress, cancelled: () => cancelRequested });
    set({
      progress: { phase: "writing", framesDone: plan.frameCount, frameCount: plan.frameCount, detail: "Writing the file…" },
      remainingMs: null,
    });
    const bytes = await writeExportFile(destination, outcome.bytes);
    set({ progress: null, outcome: { kind: "saved", path: destination, bytes, audioProblems: outcome.audioProblems, audioShortfalls: outcome.audioShortfalls } });
    void setTaskbarProgress(null).catch(() => undefined);
  } catch (reason) {
    if (reason instanceof ExportCancelled) {
      set({ progress: null, outcome: { kind: "cancelled" } });
      void setTaskbarProgress(null).catch(() => undefined);
    } else {
      set({ progress: null, outcome: { kind: "failed", message: reason instanceof Error ? reason.message : String(reason) } });
      void setTaskbarProgress(1, "error").catch(() => undefined);
    }
  } finally {
    cancelRequested = false;
  }
}

/** Test hook: put the store in a given state. */
export function setExportJobForTests(next: Partial<ExportJobState>) {
  set(next);
}

/** Test hook: back to idle. */
export function resetExportJobForTests() {
  cancelRequested = false;
  state = IDLE;
  listeners.forEach((listener) => listener());
}
