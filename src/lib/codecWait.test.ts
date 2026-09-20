import { afterEach, expect, it, vi } from "vitest";
import { finishCodec, waitForCodec } from "./codecWait";

afterEach(() => { vi.useRealTimers(); });

it("consumes output while waiting for decoder flush to release its surfaces", async () => {
  let finish!: () => void;
  const flushing = new Promise<void>((resolve) => { finish = resolve; });
  const pump = vi.fn(() => finish());
  await finishCodec(flushing, { stage: "Decoding", check: () => {}, progress: () => 0, pump });
  expect(pump).toHaveBeenCalled();
});

it("cancels a flush that never settles", async () => {
  vi.useFakeTimers();
  let cancelled = false;
  const run = finishCodec(new Promise(() => {}), { stage: "Encoding", check: () => { if (cancelled) throw new Error("Cancelled"); }, progress: () => 0 });
  const result = expect(run).rejects.toThrow("Cancelled");
  cancelled = true;
  await vi.advanceTimersByTimeAsync(4);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a codec error even when its queue size never changes", async () => {
  vi.useFakeTimers();
  let failure: Error | null = null;
  const run = waitForCodec(() => false, { stage: "Encoding", check: () => { if (failure) throw failure; }, progress: () => 9 });
  const result = expect(run).rejects.toThrow("Hardware encoder failed");
  failure = new Error("Hardware encoder failed");
  await vi.advanceTimersByTimeAsync(4);
  await result;
});

it("stops a codec after thirty seconds without progress", async () => {
  vi.useFakeTimers();
  const run = waitForCodec(() => false, { stage: "Decoding scene.mp4", check: () => {}, progress: () => 9 });
  const result = expect(run).rejects.toThrow("Decoding scene.mp4 stopped making progress for 30 seconds");
  await vi.advanceTimersByTimeAsync(30_004);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

it("allows long operations that continue producing output", async () => {
  vi.useFakeTimers();
  let packets = 0, ready = false;
  const run = waitForCodec(() => ready, { stage: "Encoding", check: () => {}, progress: () => packets });
  const result = expect(run).resolves.toBeUndefined();
  for (let interval = 0; interval < 3; interval++) {
    await vi.advanceTimersByTimeAsync(20_000);
    packets++;
  }
  ready = true;
  await vi.advanceTimersByTimeAsync(4);
  await result;
});
