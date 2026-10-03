import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";
export type DiagnosticContext = Record<string, unknown>;

export interface DiagnosticLogInfo {
  path: string;
  previousPath: string | null;
  sessionId: string;
  maxFileBytes: number;
}

let globalHandlersInstalled = false;

/** Sends one structured record to Rust. Callers pass identifiers and numeric
 * metadata, never prompt bodies. Rust applies length limits and credential
 * redaction again before the line reaches disk. Logging cannot break or add
 * noise to the task being diagnosed, so bridge failures are ignored. */
export function writeDiagnostic(
  level: DiagnosticLevel,
  target: string,
  event: string,
  message: string,
  context: DiagnosticContext = {},
): void {
  if (!isTauri()) return;
  try {
    void Promise.resolve(invoke("write_diagnostic_log", { entry: { level, target, event, message, context } }))
      .catch(() => undefined);
  } catch {
    // Diagnostics are best-effort and must never affect application behavior.
  }
}

export function errorContext(reason: unknown): DiagnosticContext {
  if (reason instanceof Error) {
    return { errorName: reason.name, stack: reason.stack ?? null };
  }
  return { errorType: typeof reason };
}

export function describeDiagnosticError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Installs the two browser-level failure boundaries once for the lifetime of
 * the webview. React and async event handlers ultimately surface through one
 * of these when no narrower boundary handled them. */
export function installGlobalDiagnostics(): void {
  if (globalHandlersInstalled || typeof window === "undefined") return;
  globalHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    const reason = event.error ?? event.message;
    writeDiagnostic("error", "webview", "uncaught_error", describeDiagnosticError(reason), {
      ...errorContext(reason),
      filename: event.filename || null,
      line: event.lineno || null,
      column: event.colno || null,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    writeDiagnostic("error", "webview", "unhandled_rejection", describeDiagnosticError(event.reason), errorContext(event.reason));
  });
  /* The media pipeline's engine features, which WebKitGTK only has when
     src-tauri/src/linux_webview.rs managed to switch them on. */
  writeDiagnostic("info", "webview", "ready", "Frontend diagnostics installed.", {
    userAgent: navigator.userAgent,
    videoDecoder: typeof globalThis.VideoDecoder === "function",
    videoEncoder: typeof globalThis.VideoEncoder === "function",
    audioDecoder: typeof globalThis.AudioDecoder === "function",
    webGpu: "gpu" in navigator,
  });
}

export async function getDiagnosticLogInfo(): Promise<DiagnosticLogInfo | null> {
  return isTauri() ? invoke<DiagnosticLogInfo>("diagnostic_log_info") : null;
}

export async function revealDiagnosticLog(): Promise<DiagnosticLogInfo | null> {
  return isTauri() ? invoke<DiagnosticLogInfo>("reveal_diagnostic_log") : null;
}
