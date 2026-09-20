const CODEC_IDLE_TIMEOUT_MS = 30_000;

export interface CodecWaitOptions {
  stage: string;
  check: () => void;
  /** Changes when the codec consumes input, produces output or releases frames. */
  progress: () => string | number;
  /** Consume decoder output while waiting, so its hardware surfaces can recycle. */
  pump?: () => Promise<void> | void;
}

/** Queue size can stay nonzero forever if output frames are retained. Always
 * give the consumer a turn, and observe cancellation/errors inside the wait. */
export async function waitForCodec(ready: () => boolean, options: CodecWaitOptions): Promise<void> {
  let progress = options.progress();
  let changedAt = performance.now();
  while (true) {
    options.check();
    if (ready()) return;
    await options.pump?.();
    options.check();
    if (ready()) return;
    const next = options.progress();
    if (next !== progress) { progress = next; changedAt = performance.now(); }
    if (performance.now() - changedAt >= CODEC_IDLE_TIMEOUT_MS) {
      throw new Error(`${options.stage} stopped making progress for 30 seconds. The export was stopped; try again or use a lower resolution.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 4));
  }
}

/** flush() still delivers output. Awaiting it without consuming those frames
 * can exhaust the decoder's surface pool before the promise can resolve. */
export async function finishCodec(flushing: Promise<void>, options: CodecWaitOptions): Promise<void> {
  let settled = false;
  let failure: unknown;
  let rejected = false;
  void flushing.then(() => { settled = true; }, (reason) => { failure = reason; rejected = true; settled = true; });
  await waitForCodec(() => settled, options);
  if (rejected) throw failure;
}
