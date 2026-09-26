/* The page's half of the native shell (src-tauri/src/native_shell.rs).
 *
 * Everything that makes the Slopus window behave like a Windows app rather
 * than a web page: the caption buttons' window calls, native message boxes,
 * Explorer and the Open dialog, the taskbar progress bar, the Windows accent
 * colour, and the guards that switch off what a browser tab would do with a
 * key press, a dropped file or a right click.
 *
 * Every helper here is safe to call anywhere. Outside Tauri — the Vite dev
 * server in a browser, and the jsdom test runner — each one is a no-op that
 * resolves to the "nothing happened" answer (false, null, undefined). The
 * Tauri modules are imported lazily, and only once `inTauri()` is true, so a
 * test that mocks `@tauri-apps/api/core` alone never evaluates the window
 * module against half a mock.
 */

import type { ResolvedTheme, ThemeChoice } from "./theme";

/** True inside the desktop app. Same test as `isTauri` in persistence.ts, kept
 *  local so this file (which theme.ts reaches for) pulls in nothing else. */
export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/* Each module is imported once and the promise kept: a burst of callers at
   startup (the title bar asks for the maximized state while it subscribes to
   resizes) then shares one load instead of racing several. */
let coreModule: Promise<typeof import("@tauri-apps/api/core")> | undefined;
let windowModule: Promise<typeof import("@tauri-apps/api/window")> | undefined;
const core = () => (coreModule ??= import("@tauri-apps/api/core"));
const windowApi = () => (windowModule ??= import("@tauri-apps/api/window"));
const currentWindow = async () => (await windowApi()).getCurrentWindow();

/* ── Window controls ─────────────────────────────────────────────────────── */

export async function minimizeWindow(): Promise<void> {
  if (!inTauri()) return;
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!inTauri()) return;
  await (await currentWindow()).toggleMaximize();
}

/** Asks the window to close. It goes through the same CloseRequested path as
 *  Alt+F4, so the exit guard still asks while something is generating. */
export async function closeWindow(): Promise<void> {
  if (!inTauri()) return;
  await (await currentWindow()).close();
}

export async function isWindowMaximized(): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await (await currentWindow()).isMaximized();
  } catch {
    return false;
  }
}

/** Calls back with the maximized state now and whenever it changes (any
 *  resize — caption button, double-click, Win+Up, Aero Snap — is checked).
 *  Returns an unsubscribe that is safe to call before the listener exists. */
export function onMaximizedChange(callback: (maximized: boolean) => void): () => void {
  if (!inTauri()) return () => {};
  let disposed = false;
  let last: boolean | undefined;
  let checking = false;
  let again = false;
  /* A drag-resize fires dozens of events a second; one isMaximized() round
     trip at a time is plenty, with one more queued behind it. */
  const check = async () => {
    if (checking) { again = true; return; }
    checking = true;
    try {
      do {
        again = false;
        const maximized = await isWindowMaximized();
        if (!disposed && maximized !== last) {
          last = maximized;
          callback(maximized);
        }
      } while (again && !disposed);
    } finally {
      checking = false;
    }
  };
  void check();
  const stop = currentWindow()
    .then((appWindow) => appWindow.onResized(() => { void check(); }))
    .catch(() => undefined);
  return () => {
    disposed = true;
    void stop.then((unlisten) => unlisten?.());
  };
}

/** Calls back when the window gains or loses focus, so a title bar can dim
 *  its caption the way every Windows app does when it is not the active one.
 *  Returns an unsubscribe. */
export function onWindowFocusChange(callback: (focused: boolean) => void): () => void {
  if (!inTauri()) return () => {};
  let disposed = false;
  const stop = currentWindow()
    .then((appWindow) => appWindow.onFocusChanged(({ payload }) => { if (!disposed) callback(payload); }))
    .catch(() => undefined);
  return () => {
    disposed = true;
    void stop.then((unlisten) => unlisten?.());
  };
}

/** Keeps the native window's theme — the Mica tint, the context menus, the
 *  message boxes — on the page's choice. "system" hands it back to the OS. */
export async function setWindowTheme(choice: ThemeChoice): Promise<void> {
  if (!inTauri()) return;
  try {
    await (await currentWindow()).setTheme(choice === "system" ? null : choice);
  } catch {
    /* An old capability file without set-theme costs the tint, not the app. */
  }
}

/* ── Message boxes ───────────────────────────────────────────────────────── */

export type NativeDialogKind = "info" | "warning" | "error";

export interface AskNativeOptions {
  title?: string;
  message: string;
  kind?: NativeDialogKind;
  /** The confirming button, e.g. "Delete". Windows default: "OK". */
  okLabel?: string;
  /** The declining button, e.g. "Keep". Windows default: "Cancel". */
  cancelLabel?: string;
}

/** A native yes/no question. Resolves true for the OK button; Esc, the
 *  cancel button and the box's own close button all resolve false — and so
 *  does every call outside Tauri, because the safe answer to "delete this?"
 *  when nobody can be asked is no. */
export async function askNative(options: AskNativeOptions): Promise<boolean> {
  if (!inTauri()) return false;
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return ask(options.message, {
    title: options.title,
    kind: options.kind ?? "warning",
    okLabel: options.okLabel,
    cancelLabel: options.cancelLabel,
  });
}

export interface MessageNativeOptions {
  title?: string;
  message: string;
  kind?: NativeDialogKind;
  okLabel?: string;
}

/** A native message box with one button. */
export async function messageNative(options: MessageNativeOptions): Promise<void> {
  if (!inTauri()) return;
  const { message } = await import("@tauri-apps/plugin-dialog");
  await message(options.message, {
    title: options.title,
    kind: options.kind ?? "info",
    buttons: options.okLabel ? { ok: options.okLabel } : "Ok",
  });
}

/* ── Files ────────────────────────────────────────────────────────────────── */

/** Opens File Explorer with the file selected. Rejects with Rust's message
 *  when the path does not exist. */
export async function revealInExplorer(path: string): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("reveal_in_explorer", { path });
}

export interface FileFilter {
  name: string;
  /** Without the dot: ["png", "jpg"]. */
  extensions: string[];
}

/** The system Open dialog for one file. Null when cancelled. */
export async function pickFile(options: { title?: string; filters?: FileFilter[] } = {}): Promise<string | null> {
  if (!inTauri()) return null;
  const { invoke } = await core();
  return (await invoke<string | null>("pick_file", { title: options.title, filters: options.filters })) ?? null;
}

/* ── Taskbar ──────────────────────────────────────────────────────────────── */

export type TaskbarProgressState = "normal" | "indeterminate" | "paused" | "error";

/** The progress bar on the taskbar button. `fraction` is 0…1; null clears the
 *  bar (and so does any call with nothing to show). */
export async function setTaskbarProgress(
  fraction: number | null,
  state: TaskbarProgressState = "normal",
): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow, ProgressBarStatus } = await windowApi();
  const status = {
    normal: ProgressBarStatus.Normal,
    indeterminate: ProgressBarStatus.Indeterminate,
    paused: ProgressBarStatus.Paused,
    error: ProgressBarStatus.Error,
  }[state];
  if (fraction === null && state !== "indeterminate") {
    await getCurrentWindow().setProgressBar({ status: ProgressBarStatus.None });
    return;
  }
  const progress = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? (fraction as number) : 0)) * 100);
  await getCurrentWindow().setProgressBar({ status, progress });
}

/* ── Exit guard ───────────────────────────────────────────────────────────── */

export interface GuardJob {
  title: string;
  /** Rendering right now, rather than waiting in the queue. */
  running: boolean;
}

/** Tells Rust what would be lost if the window closed now. The native exit
 *  question (window.rs) names these jobs; an empty list lets the window close
 *  without asking. */
export async function reportGenerationJobs(jobs: GuardJob[]): Promise<void> {
  if (!inTauri()) return;
  const { invoke } = await core();
  await invoke("set_generation_active", {
    active: jobs.length > 0,
    jobs: jobs.map(({ title, running }) => ({ title, running })),
  });
}

/* ── Accent colour ────────────────────────────────────────────────────────── */

/** The Windows accent palette, `#rrggbb` each (native_shell.rs AccentColors). */
export interface SystemAccent {
  accent: string;
  light1: string;
  light2: string;
  light3: string;
  dark1: string;
  dark2: string;
  dark3: string;
}

const ACCENT_EVENT = "system-accent-changed";
export const ACCENT_STYLE_ID = "system-accent";

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [parseHex(a), parseHex(b)];
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `fill`. Windows does the same:
 *  black on the pale dark-theme fill, white on the deep light-theme one. */
export function inkOn(fill: string): "#000000" | "#ffffff" {
  return contrast(fill, "#000000") >= contrast(fill, "#ffffff") ? "#000000" : "#ffffff";
}

const alpha = (hex: string, opacity: number) => {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${opacity})`;
};

/** The accent tokens tokens.css defines, derived the way WinUI derives its
 *  accent brushes: AccentLight2 fills in the dark theme and AccentDark1 in
 *  the light one; accent TEXT is one step further from the ground (Light3 /
 *  Dark2); hover and pressed are the fill at 90 % and 80 %. */
export function accentTokens(accent: SystemAccent, theme: ResolvedTheme): Record<string, string> {
  const dark = theme === "dark";
  const fill = dark ? accent.light2 : accent.dark1;
  const text = dark ? accent.light3 : accent.dark2;
  const ink = inkOn(fill);
  return {
    "--accent": fill,
    "--accent-bright": text,
    "--accent-fill": fill,
    "--accent-dark": fill,
    "--accent-soft": alpha(fill, dark ? 0.15 : 0.1),
    "--accent-soft-strong": alpha(fill, dark ? 0.22 : 0.16),
    "--accent-on-soft": text,
    "--accent-line": alpha(text, dark ? 0.28 : 0.3),
    "--accent-line-strong": alpha(text, dark ? 0.55 : 0.6),
    "--accent-ring": alpha(fill, dark ? 0.1 : 0.14),
    "--button-primary-bg": fill,
    "--button-primary-hover": `color-mix(in srgb, ${fill} 90%, transparent)`,
    "--button-primary-active": `color-mix(in srgb, ${fill} 80%, transparent)`,
    "--on-accent": ink,
    "--on-accent-dim": alpha(ink, 0.35),
  };
}

const block = (selector: string, tokens: Record<string, string>) =>
  `${selector} {\n${Object.entries(tokens).map(([name, value]) => `  ${name}: ${value};`).join("\n")}\n}`;

/** The stylesheet text for one accent. It mirrors the three blocks of
 *  tokens.css — dark on :root, light twice (the OS media query guarded by
 *  :not([data-theme="dark"]), and the explicit attribute) — so a theme switch
 *  repaints through CSS alone. `:root:root` outranks tokens.css's own
 *  selectors by one class, whatever order the two sheets end up in. */
export function accentStylesheet(accent: SystemAccent): string {
  const dark = accentTokens(accent, "dark");
  const light = accentTokens(accent, "light");
  return [
    block(":root:root", dark),
    `@media (prefers-color-scheme: light) {\n${block(':root:root:not([data-theme="dark"])', light)}\n}`,
    block(':root:root[data-theme="light"]', light),
  ].join("\n");
}

const isAccent = (value: unknown): value is SystemAccent =>
  !!value && typeof value === "object"
  && (["accent", "light1", "light2", "light3", "dark1", "dark2", "dark3"] as const)
    .every((key) => typeof (value as Record<string, unknown>)[key] === "string"
      && parseHex((value as Record<string, string>)[key]) !== null);

/** Paints the accent, or with null (or anything malformed) removes it, which
 *  puts the palette's own blue from tokens.css back. */
export function applySystemAccent(accent: SystemAccent | null): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(ACCENT_STYLE_ID);
  if (!isAccent(accent)) {
    existing?.remove();
    document.documentElement.removeAttribute("data-system-accent");
    return;
  }
  const style = existing ?? Object.assign(document.createElement("style"), { id: ACCENT_STYLE_ID });
  style.textContent = accentStylesheet(accent);
  /* Last in <head>, so it also follows every stylesheet Vite injects. */
  document.head.appendChild(style);
  document.documentElement.setAttribute("data-system-accent", "");
}

/** Reads the Windows accent once, then follows it. `onChange` is optional:
 *  the tokens are applied either way. Returns an unsubscribe. */
export function followSystemAccent(onChange?: (accent: SystemAccent | null) => void): () => void {
  if (!inTauri()) return () => {};
  let disposed = false;
  const apply = (accent: SystemAccent | null) => {
    if (disposed) return;
    applySystemAccent(accent);
    onChange?.(accent);
  };
  /* Listen first, then ask: a change landing between the two is then seen
     by the listener rather than lost. */
  const stop = import("@tauri-apps/api/event")
    .then(({ listen }) => listen<SystemAccent>(ACCENT_EVENT, (event) => apply(event.payload)))
    .catch(() => undefined);
  void stop
    .then(async () => (await core()).invoke<SystemAccent | null>("system_accent_colors"))
    .then((accent) => apply(accent ?? null))
    .catch(() => undefined);
  return () => {
    disposed = true;
    void stop.then((unlisten) => unlisten?.());
  };
}

/* ── Browser guards ───────────────────────────────────────────────────────── */

/** Keys that do something to a BROWSER TAB — reload, print, view source,
 *  downloads, find-next, history — and nothing in Slopus. WebView2's own
 *  accelerators are switched off in release builds (native_shell.rs); this is
 *  the fallback for debug builds and older runtimes. */
export function isBrowserShortcut(event: KeyboardEvent): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const ctrl = event.ctrlKey || event.metaKey;
  if (key === "F5" || key === "BrowserRefresh" || key === "BrowserBack" || key === "BrowserForward") return true;
  if (event.altKey && !ctrl && (key === "ArrowLeft" || key === "ArrowRight")) return true;
  if (ctrl && !event.altKey && ["r", "p", "u", "j", "g"].includes(key)) return true;
  return false;
}

const EDITABLE_INPUT = /^(text|search|url|email|password|number|tel)$/i;
const SELECTABLE_TEXT = ".compiled-prompt__text";

/** What the text context menu needs to know about a right-clicked element, or
 *  null when it is not text. */
export function textTarget(target: EventTarget | null): { editable: boolean; hasSelection: boolean } | null {
  if (!(target instanceof Element)) return null;
  const field = target.closest("input, textarea");
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    if (field instanceof HTMLInputElement && !EDITABLE_INPUT.test(field.type || "text")) return null;
    let hasSelection = false;
    try {
      hasSelection = field.selectionStart !== null && field.selectionStart !== field.selectionEnd;
    } catch {
      /* type=number/email throw on selectionStart in some engines. */
    }
    return { editable: !field.readOnly && !field.disabled, hasSelection };
  }
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  const hasSelection = !!selection && !selection.isCollapsed && selection.toString().length > 0;
  const editableHost = target.closest("[contenteditable]:not([contenteditable='false'])");
  if (editableHost) return { editable: true, hasSelection };
  if (target.closest(SELECTABLE_TEXT) || hasSelection) return { editable: false, hasSelection };
  return null;
}

/** Installs the page-wide guards once, for the lifetime of the window:
 *
 *   • browser shortcuts (F5, Ctrl+R, Ctrl+P, …) do nothing;
 *   • Ctrl+F only reaches the Edge find bar when no app handler took it —
 *     checked after every other listener has run, never before;
 *   • a file dropped where nothing accepts it is refused instead of the
 *     webview navigating to it (drop targets that call preventDefault on
 *     dragover, or sit inside [data-dropzone], are untouched);
 *   • right-click: a menu the app shows itself wins; over text a native
 *     Cut/Copy/Paste/Select all menu replaces Edge's; elsewhere nothing.
 *
 *  Returns an uninstall, for tests. */
export function installBrowserGuards(target: Window = window): () => void {
  const doc = target.document;
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (isBrowserShortcut(event)) event.preventDefault();
  };
  /* Bubble phase on the window: every React and document handler has had its
     turn, so one that claimed Ctrl+F has already called preventDefault. */
  const onKeyDownLate = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const find = (ctrl && !event.altKey && event.key.toLowerCase() === "f") || event.key === "F3";
    if (find) event.preventDefault();
  };
  const inDropzone = (event: Event) => event.target instanceof Element && !!event.target.closest("[data-dropzone]");
  const onDragOver = (event: DragEvent) => {
    if (event.defaultPrevented || inDropzone(event)) return;
    /* Cancelling dragover is what stops the webview treating the page as a
       place to open files; dropEffect "none" keeps the no-entry cursor. */
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const onDrop = (event: DragEvent) => {
    if (event.defaultPrevented || inDropzone(event)) return;
    event.preventDefault();
  };
  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const text = textTarget(event.target);
    if (!text || !inTauri()) return;
    void core()
      .then(({ invoke }) => invoke("show_text_context_menu", { request: text }))
      .catch(() => undefined);
  };
  target.addEventListener("keydown", onKeyDownCapture, true);
  target.addEventListener("keydown", onKeyDownLate);
  doc.addEventListener("dragover", onDragOver);
  doc.addEventListener("drop", onDrop);
  doc.addEventListener("contextmenu", onContextMenu);
  return () => {
    target.removeEventListener("keydown", onKeyDownCapture, true);
    target.removeEventListener("keydown", onKeyDownLate);
    doc.removeEventListener("dragover", onDragOver);
    doc.removeEventListener("drop", onDrop);
    doc.removeEventListener("contextmenu", onContextMenu);
  };
}
