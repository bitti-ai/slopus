// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticLogInfo, revealDiagnosticLog, writeDiagnostic } from "./diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("application diagnostics bridge", () => {
  it("does nothing in the browser preview", async () => {
    writeDiagnostic("error", "generation", "failed", "No encoder", { jobId: "job-1" });
    expect(await getDiagnosticLogInfo()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes structured entries and retrieves the native log location", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const info = { path: "C:\\Logs\\slopus.log", previousPath: null, sessionId: "42-1", maxFileBytes: 5_242_880 };
    vi.mocked(invoke).mockResolvedValue(info);

    writeDiagnostic("error", "generation", "encoding.failed", "Encoder stopped", { jobId: "job-1", frames: 48 });
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith("write_diagnostic_log", { entry: {
      level: "error", target: "generation", event: "encoding.failed", message: "Encoder stopped",
      context: { jobId: "job-1", frames: 48 },
    } });
    expect(await getDiagnosticLogInfo()).toEqual(info);
    expect(await revealDiagnosticLog()).toEqual(info);
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toContain("reveal_diagnostic_log");
  });
});
