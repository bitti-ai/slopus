import { invoke } from "@tauri-apps/api/core";
import type { UpscaleConfig } from "./upscalers";

/** Bounded native stream: input and output must be pumped concurrently because
 * SeedVR2 buffers temporal segments before producing its first restored frame. */
export async function startUpscaleExport(options: {
  config: UpscaleConfig; inputWidth: number; inputHeight: number; width: number; height: number;
  frameRate: number; frameCount: number; cancelled: () => boolean;
  output: (frame: VideoFrame, index: number) => Promise<void>;
}) {
  const id = crypto.randomUUID();
  const { config, inputWidth, inputHeight, width, height } = options;
  await invoke("start_export_upscale", { id, config, inputWidth, inputHeight, width, height });
  let failure: unknown;
  let frames = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await invoke("cancel_export_upscale", { id });
  };
  const check = () => {
    if (failure) throw failure;
    if (options.cancelled()) throw new Error("Export cancelled.");
  };
  const timer = setInterval(() => { if (options.cancelled()) void close().catch(() => {}); }, 100);
  const done = (async () => {
    for (;;) {
      check();
      const bytes = new Uint8Array(await invoke<ArrayBuffer>("read_export_upscale", { id }));
      if (!bytes.length) break;
      if (bytes.length !== width * height * 4 || frames >= options.frameCount) throw new Error("Upscaler returned invalid frames.");
      const timestamp = Math.round(frames * 1_000_000 / options.frameRate);
      const frame = new VideoFrame(bytes, { format: "RGBA", codedWidth: width, codedHeight: height,
        timestamp, duration: Math.round((frames + 1) * 1_000_000 / options.frameRate) - timestamp });
      try { await options.output(frame, frames++); } finally { frame.close(); }
    }
    if (frames !== options.frameCount) throw new Error(`Upscaler returned ${frames} of ${options.frameCount} frames.`);
  })().catch(async (reason) => { failure = reason; await close().catch(() => {}); });
  return {
    async push(frame: VideoFrame) {
      check();
      const bytes = new Uint8Array(inputWidth * inputHeight * 4);
      await frame.copyTo(bytes, { format: "RGBA" });
      check();
      await invoke("push_export_upscale", bytes, { headers: { "x-upscale-id": id } });
      check();
    },
    async finish() {
      check();
      await invoke("finish_export_upscale", { id });
      await done;
      check();
    },
    async dispose() { await close(); await done; },
  };
}
