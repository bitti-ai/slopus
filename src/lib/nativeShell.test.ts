// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appWindow = vi.hoisted(() => ({
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  isMaximized: vi.fn(async () => false),
  setTheme: vi.fn(async () => undefined),
  setProgressBar: vi.fn(async () => undefined),
  resized: [] as Array<() => void>,
  onResized: vi.fn(async (handler: () => void) => {
    appWindow.resized.push(handler);
    return () => { appWindow.resized = appWindow.resized.filter((entry) => entry !== handler); };
  }),
  onFocusChanged: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => appWindow,
  ProgressBarStatus: { None: "none", Normal: "normal", Indeterminate: "indeterminate", Paused: "paused", Error: "error" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(async () => true),
  message: vi.fn(async () => "Ok"),
}));

import { invoke } from "@tauri-apps/api/core";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  accentStylesheet, accentTokens, ACCENT_STYLE_ID, applySystemAccent, askNative, closeWindow, contrast,
  followSystemAccent, inkOn, installBrowserGuards, isBrowserShortcut, isWindowMaximized, messageNative,
  minimizeWindow, onMaximizedChange, pickFile, reportGenerationJobs, revealInExplorer, setTaskbarProgress,
  setWindowTheme, textTarget, toggleMaximizeWindow, type SystemAccent,
} from "./nativeShell";

/* Windows' default blue (#0078d4) and the ramp UISettings reports for it. */
const BLUE: SystemAccent = {
  accent: "#0078d4",
  light1: "#429ce3", light2: "#76b9ed", light3: "#99ebff",
  dark1: "#005a9e", dark2: "#004275", dark3: "#002642",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const setTauri = (on: boolean) => {
  if (on) Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  appWindow.resized = [];
  document.getElementById(ACCENT_STYLE_ID)?.remove();
});
afterEach(() => setTauri(false));

describe("outside Tauri", () => {
  it("every helper is a no-op with the safe answer", async () => {
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    await setWindowTheme("light");
    await setTaskbarProgress(0.5);
    await revealInExplorer("C:\\file.mp4");
    await reportGenerationJobs([{ title: "Shot", running: true }]);
    await messageNative({ message: "Hi" });
    expect(await isWindowMaximized()).toBe(false);
    expect(await askNative({ message: "Delete?" })).toBe(false);
    expect(await pickFile()).toBeNull();
    const stop = onMaximizedChange(() => undefined);
    stop();
    followSystemAccent()();
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(appWindow.minimize).not.toHaveBeenCalled();
  });
});

describe("inside Tauri", () => {
  beforeEach(() => setTauri(true));

  it("drives the window", async () => {
    await minimizeWindow();
    await toggleMaximizeWindow();
    await closeWindow();
    expect(appWindow.minimize).toHaveBeenCalledOnce();
    expect(appWindow.toggleMaximize).toHaveBeenCalledOnce();
    expect(appWindow.close).toHaveBeenCalledOnce();
  });

  it("hands the theme to the native window, and system back to the OS", async () => {
    await setWindowTheme("light");
    await setWindowTheme("system");
    expect(appWindow.setTheme).toHaveBeenNthCalledWith(1, "light");
    expect(appWindow.setTheme).toHaveBeenNthCalledWith(2, null);
  });

  it("reports the maximized state now and on every change, once per change", async () => {
    const seen: boolean[] = [];
    const stop = onMaximizedChange((maximized) => seen.push(maximized));

    await vi.waitFor(() => expect(appWindow.resized).toHaveLength(1));
    expect(seen).toEqual([false]);
    appWindow.isMaximized.mockResolvedValue(true);
    appWindow.resized.forEach((handler) => handler());
    await flush();
    appWindow.resized.forEach((handler) => handler());
    await flush();
    expect(seen).toEqual([false, true]);
    stop();
    await flush();
    expect(appWindow.resized).toHaveLength(0);
    appWindow.isMaximized.mockResolvedValue(false);
  });

  it("asks and tells through the dialog plugin", async () => {
    expect(await askNative({ title: "Delete project", message: "Delete it?", okLabel: "Delete", cancelLabel: "Keep" })).toBe(true);
    expect(ask).toHaveBeenCalledWith("Delete it?", { title: "Delete project", kind: "warning", okLabel: "Delete", cancelLabel: "Keep" });
    await messageNative({ message: "Done", okLabel: "Got it" });
    expect(message).toHaveBeenCalledWith("Done", { title: undefined, kind: "info", buttons: { ok: "Got it" } });
  });

  it("calls the Rust commands with the names and arguments they declare", async () => {
    await revealInExplorer("C:\\out\\film.mp4");
    expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", { path: "C:\\out\\film.mp4" });
    vi.mocked(invoke).mockResolvedValueOnce("C:\\in\\a.png");
    const filters = [{ name: "Images", extensions: ["png"] }];
    expect(await pickFile({ title: "Pick", filters })).toBe("C:\\in\\a.png");
    expect(invoke).toHaveBeenCalledWith("pick_file", { title: "Pick", filters });
    await reportGenerationJobs([{ title: "Opening", running: true }]);
    expect(invoke).toHaveBeenCalledWith("set_generation_active", { active: true, jobs: [{ title: "Opening", running: true }] });
    await reportGenerationJobs([]);
    expect(invoke).toHaveBeenLastCalledWith("set_generation_active", { active: false, jobs: [] });
  });

  it("puts progress on the taskbar button as a percentage, and clears it", async () => {
    await setTaskbarProgress(0.426);
    expect(appWindow.setProgressBar).toHaveBeenLastCalledWith({ status: "normal", progress: 43 });
    await setTaskbarProgress(2, "error");
    expect(appWindow.setProgressBar).toHaveBeenLastCalledWith({ status: "error", progress: 100 });
    await setTaskbarProgress(null);
    expect(appWindow.setProgressBar).toHaveBeenLastCalledWith({ status: "none" });
  });

  it("follows the accent: reads it once, then applies every change", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BLUE);
    const seen: Array<SystemAccent | null> = [];
    const stop = followSystemAccent((accent) => seen.push(accent));
    await flush();
    expect(invoke).toHaveBeenCalledWith("system_accent_colors");
    expect(document.getElementById(ACCENT_STYLE_ID)?.textContent).toContain("--accent: #76b9ed");
    const green = { ...BLUE, light2: "#8ee39a", dark1: "#107c10" };
    listeners.get("system-accent-changed")!({ payload: green });
    expect(document.getElementById(ACCENT_STYLE_ID)?.textContent).toContain("--accent: #8ee39a");
    expect(seen).toHaveLength(2);
    stop();
    await flush();
    expect(listeners.size).toBe(0);
  });
});

describe("accent tokens", () => {
  it("fills with AccentLight2 in dark and AccentDark1 in light, as WinUI does", () => {
    expect(accentTokens(BLUE, "dark")["--button-primary-bg"]).toBe("#76b9ed");
    expect(accentTokens(BLUE, "light")["--button-primary-bg"]).toBe("#005a9e");
    expect(accentTokens(BLUE, "dark")["--accent-bright"]).toBe("#99ebff");
    expect(accentTokens(BLUE, "light")["--accent-bright"]).toBe("#004275");
  });

  it("puts black ink on a pale fill and white ink on a deep one, whichever reads better", () => {
    expect(inkOn("#76b9ed")).toBe("#000000");
    expect(inkOn("#005a9e")).toBe("#ffffff");
    expect(accentTokens(BLUE, "dark")["--on-accent"]).toBe("#000000");
    expect(accentTokens(BLUE, "light")["--on-accent"]).toBe("#ffffff");
    /* And it is legible, not merely the better of two bad options, for the
       default accent in both themes. */
    expect(contrast("#76b9ed", "#000000")).toBeGreaterThan(4.5);
    expect(contrast("#005a9e", "#ffffff")).toBeGreaterThan(4.5);
    /* A mid-yellow accent must still get black. */
    expect(inkOn("#ffb900")).toBe("#000000");
  });

  it("mirrors the three theme blocks of tokens.css so a theme switch needs no JavaScript", () => {
    const css = accentStylesheet(BLUE);
    expect(css).toContain(":root:root {");
    expect(css).toContain('@media (prefers-color-scheme: light) {\n:root:root:not([data-theme="dark"]) {');
    expect(css).toContain(':root:root[data-theme="light"] {');
  });

  it("removes itself for null or a malformed payload, putting the palette's blue back", () => {
    applySystemAccent(BLUE);
    expect(document.getElementById(ACCENT_STYLE_ID)).not.toBeNull();
    expect(document.documentElement.hasAttribute("data-system-accent")).toBe(true);
    applySystemAccent({ ...BLUE, light2: "blue" });
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
    applySystemAccent(BLUE);
    applySystemAccent(null);
    expect(document.getElementById(ACCENT_STYLE_ID)).toBeNull();
    expect(document.documentElement.hasAttribute("data-system-accent")).toBe(false);
  });
});

describe("browser guards", () => {
  let uninstall: () => void;
  beforeEach(() => { uninstall = installBrowserGuards(); });
  afterEach(() => { uninstall(); document.body.innerHTML = ""; });

  const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it("knows which keys belong to a browser tab", () => {
    for (const init of [{ key: "F5" }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true, shiftKey: true },
      { key: "p", ctrlKey: true }, { key: "u", ctrlKey: true }, { key: "j", ctrlKey: true }, { key: "g", ctrlKey: true },
      { key: "ArrowLeft", altKey: true }, { key: "ArrowRight", altKey: true }]) {
      expect(isBrowserShortcut(new KeyboardEvent("keydown", init)), JSON.stringify(init)).toBe(true);
    }
    for (const init of [{ key: "k", ctrlKey: true }, { key: "c", ctrlKey: true }, { key: "a", ctrlKey: true },
      { key: "ArrowLeft" }, { key: "r" }]) {
      expect(isBrowserShortcut(new KeyboardEvent("keydown", init)), JSON.stringify(init)).toBe(false);
    }
  });

  it("swallows reload and print but leaves ordinary shortcuts alone", () => {
    expect(key({ key: "F5" }).defaultPrevented).toBe(true);
    expect(key({ key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(key({ key: "k", ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it("lets an app handler see Ctrl+F untouched, and only then stops the find bar", () => {
    let seenPrevented: boolean | null = null;
    const handler = (event: KeyboardEvent) => { seenPrevented = event.defaultPrevented; };
    document.addEventListener("keydown", handler);
    expect(key({ key: "f", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(seenPrevented).toBe(false);
    document.removeEventListener("keydown", handler);
  });

  it("refuses a drop nothing accepted, and leaves drop targets and dropzones alone", () => {
    const drag = (target: Element, accept = false) => {
      const event = new Event("dragover", { bubbles: true, cancelable: true });
      if (accept) target.addEventListener("dragover", (e) => e.preventDefault(), { once: true });
      target.dispatchEvent(event);
      return event;
    };
    document.body.innerHTML = `<div id="plain"></div><div data-dropzone><span id="zone"></span></div>`;
    expect(drag(document.getElementById("plain")!).defaultPrevented).toBe(true);
    expect(drag(document.getElementById("zone")!).defaultPrevented).toBe(false);
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    document.getElementById("plain")!.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("replaces the browser's right-click menu, asking Rust for a text menu only over text", async () => {
    setTauri(true);
    document.body.innerHTML = `<input id="field" value="hello" /><input id="locked" readonly value="x" /><div id="plain">x</div><input id="box" type="checkbox" />`;
    const right = (id: string) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(event);
      return event;
    };
    expect(right("plain").defaultPrevented).toBe(true);
    expect(right("box").defaultPrevented).toBe(true);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(right("field").defaultPrevented).toBe(true);
    await flush();
    expect(invoke).toHaveBeenCalledWith("show_text_context_menu", { request: { editable: true, hasSelection: false } });
    right("locked");
    await flush();
    expect(invoke).toHaveBeenLastCalledWith("show_text_context_menu", { request: { editable: false, hasSelection: false } });
  });

  it("stays out of the way of a menu the app shows itself", async () => {
    setTauri(true);
    document.body.innerHTML = `<input id="field" />`;
    const field = document.getElementById("field")!;
    field.addEventListener("contextmenu", (event) => event.preventDefault(), { once: true });
    field.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads a selection in a field", () => {
    document.body.innerHTML = `<textarea id="text">hello world</textarea>`;
    const text = document.getElementById("text") as HTMLTextAreaElement;
    text.setSelectionRange(0, 5);
    expect(textTarget(text)).toEqual({ editable: true, hasSelection: true });
  });
});
