// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { startUpscaleExport } from "./upscaleExport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("pumps segmented native output concurrently, preserving every frame timestamp", async () => {
  const pending: ((value: ArrayBuffer) => void)[] = [];
  const queued: ArrayBuffer[] = [];
  const deliver = (bytes: ArrayBuffer) => { const resolve = pending.shift(); if (resolve) resolve(bytes); else queued.push(bytes); };
  let inputs = 0;
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name === "read_export_upscale") return (queued.length ? queued.shift() : new Promise((resolve) => pending.push(resolve))) as never;
    if (name === "push_export_upscale") {
      expect(args).toBeInstanceOf(Uint8Array);
      if (++inputs === 5) for (let i = 0; i < 5; i++) deliver(new Uint8Array(4 * 2 * 4).buffer);
    }
    if (name === "finish_export_upscale") { deliver(new Uint8Array(4 * 2 * 4).buffer); deliver(new ArrayBuffer(0)); }
    return undefined as never;
  });
  const frames: { timestamp: number; duration: number; close: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal("VideoFrame", class {
    timestamp: number; duration: number; close = vi.fn();
    constructor(_bytes: unknown, options: { timestamp: number; duration: number }) {
      this.timestamp = options.timestamp; this.duration = options.duration; frames.push(this);
    }
  });
  const output = vi.fn().mockResolvedValue(undefined);
  const stream = await startUpscaleExport({ config: { method: "seedvr2", modelPath: "model", vaePath: "vae" },
    inputWidth: 2, inputHeight: 1, width: 4, height: 2, frameRate: 24, frameCount: 6, cancelled: () => false, output });
  const frame = { copyTo: vi.fn().mockResolvedValue([]) } as unknown as VideoFrame;
  for (let i = 0; i < 6; i++) await stream.push(frame);
  await stream.finish();
  await stream.dispose();
  expect(output).toHaveBeenCalledTimes(6);
  expect(frames.map((frame) => frame.timestamp)).toEqual([0, 41667, 83333, 125000, 166667, 208333]);
  expect(frames.every((frame) => frame.close.mock.calls.length === 1)).toBe(true);
  expect(invoke).toHaveBeenCalledWith("cancel_export_upscale", expect.anything());
});

it("surfaces native errors and closes the session", async () => {
  vi.mocked(invoke).mockImplementation(async (name) => {
    if (name === "read_export_upscale") throw new Error("Model could not be loaded");
    return undefined as never;
  });
  const stream = await startUpscaleExport({ config: { method: "realesrgan", modelPath: "model" },
    inputWidth: 2, inputHeight: 2, width: 8, height: 8, frameRate: 24, frameCount: 1, cancelled: () => false, output: vi.fn() });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cancel_export_upscale", expect.anything()));
  await expect(stream.finish()).rejects.toThrow("Model could not be loaded");
  await stream.dispose();
});

it("cancels a native stream even while waiting for its first output", async () => {
  let rejectRead: (reason: Error) => void = () => {};
  let cancelled = false;
  vi.mocked(invoke).mockImplementation(async (name) => {
    if (name === "read_export_upscale") return new Promise((_resolve, reject) => { rejectRead = reject; }) as never;
    if (name === "cancel_export_upscale") rejectRead(new Error("Upscaling cancelled."));
    return undefined as never;
  });
  const stream = await startUpscaleExport({ config: { method: "seedvr2", modelPath: "model", vaePath: "vae" },
    inputWidth: 2, inputHeight: 2, width: 8, height: 8, frameRate: 24, frameCount: 1, cancelled: () => cancelled, output: vi.fn() });
  cancelled = true;
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cancel_export_upscale", expect.anything()));
  await stream.dispose();
  await expect(stream.finish()).rejects.toThrow(/cancelled/);
});
