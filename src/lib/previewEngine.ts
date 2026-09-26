/* What the program monitor's engine is actually doing, for the status bar.

   Only facts the preview already has in hand are kept here — nothing is probed
   for the bar's sake:
   • the GPU: the adapter the preview compositor was created on (its
     `adapter.info`), or the reason there is none;
   • playback: while playing, how many playhead ticks per second reached the
     screen as a new picture, and how many kept the previous picture because a
     decoder was still loading or seeking (a dropped frame, as the viewer sees
     it).

   The monitor counts ticks into plain fields; the snapshot readers subscribe to
   is replaced at most once a second, so the bar re-renders on that cadence and
   never per frame. */

export type PreviewGpu = { kind: "webgpu"; name: string } | { kind: "none"; reason: string };
export interface PreviewPlayback { fps: number; dropped: number }
export interface PreviewEngineSnapshot { gpu: PreviewGpu | null; playback: PreviewPlayback | null }

/** How often a playing monitor publishes its rate. */
export const PLAYBACK_SAMPLE_MS = 1000;

export class PreviewEngine {
  private snapshot: PreviewEngineSnapshot = { gpu: null, playback: null };
  private listeners = new Set<() => void>();
  private shown = 0;
  private held = 0;
  private dropped = 0;
  private sampling = false;

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<PreviewEngineSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  setGpu(gpu: PreviewGpu) {
    if (JSON.stringify(this.snapshot.gpu) === JSON.stringify(gpu)) return;
    this.publish({ gpu });
  }

  /** One playhead tick at the monitor: a new picture, or the previous one kept. */
  tick(presented: boolean) {
    if (!this.sampling) return;
    if (presented) this.shown += 1;
    else this.held += 1;
  }

  /** Playback started: count from zero. Nothing is published until a full
   *  sample has been measured. */
  start() {
    this.sampling = true;
    this.shown = 0; this.held = 0; this.dropped = 0;
  }

  /** Publishes the rate over the last `elapsedMs`. A window with no ticks at
   *  all (a monitor without the GPU picture) says nothing rather than "0 fps". */
  sample(elapsedMs: number) {
    if (!this.sampling || elapsedMs <= 0) return;
    const ticks = this.shown + this.held;
    this.dropped += this.held;
    const fps = (this.shown * 1000) / elapsedMs;
    this.shown = 0; this.held = 0;
    if (ticks === 0) return;
    this.publish({ playback: { fps, dropped: this.dropped } });
  }

  /** Playback stopped: a rate for a paused monitor would be stale. */
  stop() {
    this.sampling = false;
    if (this.snapshot.playback) this.publish({ playback: null });
  }
}

/** The one program monitor's engine. */
export const previewEngine = new PreviewEngine();
