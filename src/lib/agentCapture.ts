import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectRecord } from "./project";
import type { FrameCaptureTarget } from "./frameCapture";

interface CaptureRequest { requestId: string; captureId: string; target: FrameCaptureTarget }
const activeCaptures = new Map<string, () => void>();

export function cancelAgentCaptures(requestId: string) { activeCaptures.get(requestId)?.(); }

/** Installed before starting the native turn. The renderer owns its decoders,
 * GPU device and canvas; it has no reference to transport or editor state. */
export async function listenForAgentCaptures(record: ProjectRecord, requestId: string) {
  const snapshot = structuredClone(record.config);
  const running = new Set<AbortController>();
  const seen = new Set<string>();
  let disposed = false;
  const stop = () => { disposed = true; running.forEach((controller) => controller.abort()); };
  activeCaptures.set(requestId, stop);
  let unlisten: () => void;
  try {
    unlisten = await listen<CaptureRequest>("agent-capture-request", ({ payload }) => {
      if (disposed || payload.requestId !== requestId || seen.has(payload.captureId)) return;
      seen.add(payload.captureId);
      const controller = new AbortController();
      running.add(controller);
      const timer = setTimeout(() => controller.abort(new Error("Frame capture timed out.")), 40_000);
      void (async () => {
        try {
          const { captureFrame } = await import("./frameCapture");
          const frame = await captureFrame(snapshot, record.folderPath, payload.target, controller.signal);
          if (!disposed) await invoke("complete_agent_capture", { requestId, captureId: payload.captureId, frame });
        } catch (reason) {
          if (!disposed) await invoke("complete_agent_capture", { requestId, captureId: payload.captureId,
            error: reason instanceof Error ? reason.message : String(reason) }).catch(() => undefined);
        } finally {
          clearTimeout(timer);
          running.delete(controller);
        }
      })();
    });
  } catch (reason) { stop(); activeCaptures.delete(requestId); throw reason; }
  return () => { stop(); unlisten(); activeCaptures.delete(requestId); };
}
