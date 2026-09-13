// @vitest-environment jsdom
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { builtinIconUrl, hasBuiltinIcon, loadBuiltinIcon, refreshBuiltinIcons, saveBuiltinIcon } from "./builtinReferenceIcons";
import { builtinIconVisitAction, saveBuiltinIconChoice } from "./referenceIconSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); Object.assign(window, { __TAURI_INTERNALS__: {} }); });
afterEach(() => { delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; vi.unstubAllGlobals(); });

it("asks once per session and remembers both affirmative and negative choices", () => {
  expect(builtinIconVisitAction()).toBe("ask");
  expect(builtinIconVisitAction()).toBe("skip");
  sessionStorage.clear();
  expect(builtinIconVisitAction()).toBe("ask");
  saveBuiltinIconChoice(false);
  sessionStorage.clear();
  expect(builtinIconVisitAction()).toBe("skip");
  saveBuiltinIconChoice(true);
  sessionStorage.clear();
  expect(builtinIconVisitAction()).toBe("generate");
});

it("discovers saved icons and lazily reads each shared JPEG only once", async () => {
  const create = vi.fn(() => "blob:builtin");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.mocked(invoke).mockImplementation(async (command) => command === "list_builtin_reference_icons" ? ["test-preset"] : new Uint8Array([255, 216]).buffer);
  await refreshBuiltinIcons();
  expect(hasBuiltinIcon("test-preset")).toBe(true);
  expect(builtinIconUrl("test-preset")).toBeUndefined();
  expect(await Promise.all([loadBuiltinIcon("test-preset"), loadBuiltinIcon("test-preset")])).toEqual(["blob:builtin", "blob:builtin"]);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "read_builtin_reference_icon")).toHaveLength(1);
  expect(builtinIconUrl("test-preset")).toBe("blob:builtin");
  await saveBuiltinIcon("test-preset", "icon-job");
  expect(invoke).toHaveBeenCalledWith("save_builtin_reference_icon", { presetId: "test-preset", jobId: "icon-job" });
  expect(revoke).toHaveBeenCalledWith("blob:builtin");
  expect(hasBuiltinIcon("test-preset")).toBe(true);
});

it("keeps previous artwork when saving fails and publishes new icons only after saving completes", async () => {
  vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:previous"), revokeObjectURL: vi.fn() });
  vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(2));
  await loadBuiltinIcon("keep-previous");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Write interrupted"));
  await expect(saveBuiltinIcon("keep-previous", "failed-job")).rejects.toThrow("Write interrupted");
  expect(builtinIconUrl("keep-previous")).toBe("blob:previous");
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const saving = saveBuiltinIcon("new-complete", "job");
  expect(hasBuiltinIcon("new-complete")).toBe(false);
  finish(); await saving;
  expect(hasBuiltinIcon("new-complete")).toBe(true);
});

it("does not cache an old read that finishes after regeneration", async () => {
  const create = vi.fn(() => "blob:newest");
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
  let finishOld!: (bytes: ArrayBuffer) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finishOld = resolve; }));
  const old = loadBuiltinIcon("race");
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await saveBuiltinIcon("race", "regenerated");
  vi.mocked(invoke).mockResolvedValueOnce(new ArrayBuffer(20));
  finishOld(new ArrayBuffer(10));
  expect(await old).toBe("blob:newest");
  expect(create).toHaveBeenCalledOnce();
  expect((create.mock.calls[0] as unknown as [Blob])[0].size).toBe(20);
});
