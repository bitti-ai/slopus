/* ============================================================================
   Keyboard commands — one window-level dispatcher for every shortcut.

   Screens used to each hang their own `keydown` listener on window, check
   `event.target` for text fields in slightly different ways, and fight over
   keys like Delete and Space. This module owns ONE bubble-phase listener on
   window and routes each key press to the best registered handler:

     useShortcut("Ctrl+S", save);
     useShortcut(["Delete", "Backspace"], removeSelection, { scope: timelineRef });
     useShortcut("F2", rename, { enabled: Boolean(selected) });

   Rules, in the order the dispatcher applies them:
   1. A press whose default was already prevented (a menu, a dialog, a field
      that handled it) is left alone.
   2. Presses inside a text entry (text-like input, textarea, select,
      contenteditable) are ignored unless the handler says `allowInInput`.
   3. While a modal dialog is open (`[aria-modal="true"]`) only handlers
      scoped INSIDE that dialog, or that pass `allowInModal`, can fire.
   4. Of the handlers that remain, the one whose `scope` element is the
      innermost ancestor of the focused element wins; unscoped handlers are
      the outermost. Ties go to the most recently registered handler.
   5. A handler may return `false` to decline, and the next candidate runs.

   Combos are written the way Windows displays them: "Ctrl+Shift+Z", "F2",
   "Delete", "Shift+F10", "Alt+ArrowLeft", "J". Letters are case-insensitive.
   `formatShortcut` turns a combo into its display form for tooltips and menus.
   ========================================================================== */

import { useEffect, useRef, type RefObject } from "react";

export interface ParsedCombo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Normalised key: a lowercase letter/digit/symbol, or a KeyboardEvent.key name. */
  key: string;
  /** True when "Shift" was spelled out; symbols ("?") otherwise ignore shift. */
  shiftExplicit: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  del: "Delete",
  delete: "Delete",
  esc: "Escape",
  escape: "Escape",
  space: " ",
  spacebar: " ",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  ins: "Insert",
  contextmenu: "ContextMenu",
  apps: "ContextMenu",
  plus: "+",
};

function normaliseKey(raw: string): string {
  if (raw.length === 1) return raw.toLowerCase();
  const alias = KEY_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  if (/^f\d{1,2}$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

const parsedCache = new Map<string, ParsedCombo>();

/** "Ctrl+Shift+Z" → { ctrl, shift, key: "z" }. A trailing "+" is the plus key. */
export function parseCombo(combo: string): ParsedCombo {
  const cached = parsedCache.get(combo);
  if (cached) return cached;
  const parts = combo.trim().split(/\s*\+\s*/);
  // "Ctrl++" splits into ["Ctrl", "", ""]: the key is "+".
  if (parts.length > 1 && parts.at(-1) === "") { parts.splice(-2, 2, "+"); }
  const parsed: ParsedCombo = { ctrl: false, alt: false, shift: false, meta: false, key: "", shiftExplicit: false };
  parts.forEach((part, index) => {
    const lower = part.toLowerCase();
    const last = index === parts.length - 1;
    if (!last && (lower === "ctrl" || lower === "control" || lower === "mod" || lower === "cmdorctrl")) parsed.ctrl = true;
    else if (!last && (lower === "alt" || lower === "option")) parsed.alt = true;
    else if (!last && lower === "shift") { parsed.shift = true; parsed.shiftExplicit = true; }
    else if (!last && (lower === "meta" || lower === "win" || lower === "cmd")) parsed.meta = true;
    else parsed.key = normaliseKey(part);
  });
  parsedCache.set(combo, parsed);
  return parsed;
}

interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Does this key press spell `combo`? */
export function matchesCombo(event: KeyLike, combo: string): boolean {
  const want = parseCombo(combo);
  if (!want.key) return false;
  if (event.ctrlKey !== want.ctrl || event.altKey !== want.alt || event.metaKey !== want.meta) return false;
  const key = normaliseKey(event.key === "Spacebar" ? " " : event.key);
  const isSymbol = want.key.length === 1 && !/[a-z0-9 ]/.test(want.key);
  if (!isSymbol || want.shiftExplicit) {
    if (event.shiftKey !== want.shift) return false;
  }
  if (key === want.key) return true;
  // Ctrl+Alt / AltGr and non-Latin layouts report a different `key` for a
  // letter; the physical code still says which letter it is.
  if (want.key.length === 1 && /[a-z0-9]/.test(want.key) && event.code) {
    return event.code === `Key${want.key.toUpperCase()}` || event.code === `Digit${want.key}`;
  }
  return false;
}

const DISPLAY_KEYS: Record<string, string> = {
  " ": "Space",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  ContextMenu: "Menu",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** The Windows display form: "ctrl+shift+z" → "Ctrl+Shift+Z", "Alt+ArrowLeft" → "Alt+Left". */
export function formatShortcut(combo: string | readonly string[] | undefined | null): string {
  if (!combo) return "";
  if (typeof combo !== "string") return combo.map((one) => formatShortcut(one)).join(", ");
  const parsed = parseCombo(combo);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Win");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  const key = DISPLAY_KEYS[parsed.key] ?? (parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
  parts.push(key);
  return parts.join("+");
}

/** The `aria-keyshortcuts` spelling ("Control+Shift+Z"). */
export function ariaKeyShortcuts(combo: string | readonly string[] | undefined | null): string | undefined {
  if (!combo) return undefined;
  const list = typeof combo === "string" ? [combo] : combo;
  return list.map((one) => {
    const parsed = parseCombo(one);
    const parts: string[] = [];
    if (parsed.ctrl) parts.push("Control");
    if (parsed.meta) parts.push("Meta");
    if (parsed.alt) parts.push("Alt");
    if (parsed.shift) parts.push("Shift");
    parts.push(parsed.key === " " ? "Space" : parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key);
    return parts.join("+");
  }).join(" ");
}

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** True for elements that take typed text: shortcuts should leave them alone. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type);
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable=""], [contenteditable="true"]'));
}

export interface ShortcutOptions {
  /** Default true. */
  enabled?: boolean;
  /** Fire even while the focus is in a text input, textarea, select or contenteditable. */
  allowInInput?: boolean;
  /** Only fire while focus is inside this element; innermost scope wins. */
  scope?: RefObject<HTMLElement | null> | HTMLElement | null;
  /** Default true: the event's default action is prevented when a handler runs. */
  preventDefault?: boolean;
  /** Fire even while a modal dialog is open (unscoped handlers are otherwise muted). */
  allowInModal?: boolean;
}

/** Return `false` to decline; the next matching handler then runs. */
export type ShortcutHandler = (event: KeyboardEvent) => void | boolean;

interface Registration {
  combos: readonly string[];
  handler: { current: ShortcutHandler };
  options: { current: ShortcutOptions };
  order: number;
}

const registrations = new Set<Registration>();
let orderCounter = 0;
let listening = false;

function scopeElement(options: ShortcutOptions): HTMLElement | null | undefined {
  const scope = options.scope;
  if (scope === undefined) return undefined;
  if (scope === null) return null;
  if (typeof HTMLElement !== "undefined" && scope instanceof HTMLElement) return scope;
  return (scope as RefObject<HTMLElement | null>).current;
}

function depth(element: Element): number {
  let count = 0;
  for (let node: Element | null = element; node; node = node.parentElement) count += 1;
  return count;
}

function dispatch(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.key === "Process") return;
  const target = (event.target instanceof Element ? event.target : document.activeElement) ?? document.body;
  const inInput = isTextEntry(target);
  const modals = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')];
  const modal = modals.at(-1);

  const candidates: { registration: Registration; rank: number }[] = [];
  for (const registration of registrations) {
    const options = registration.options.current;
    if (options.enabled === false) continue;
    if (inInput && !options.allowInInput) continue;
    if (!registration.combos.some((combo) => matchesCombo(event, combo))) continue;
    const scope = scopeElement(options);
    if (scope === null) continue;                       // a scoped handler whose element is gone
    if (scope && !scope.contains(target)) continue;
    if (modal && !options.allowInModal && !(scope && modal.contains(scope))) continue;
    candidates.push({ registration, rank: scope ? depth(scope) : 0 });
  }
  candidates.sort((a, b) => b.rank - a.rank || b.registration.order - a.registration.order);
  for (const { registration } of candidates) {
    const result = registration.handler.current(event);
    if (result === false) continue;
    if (registration.options.current.preventDefault !== false) event.preventDefault();
    return;
  }
}

function sync() {
  if (typeof window === "undefined") return;
  if (registrations.size && !listening) {
    window.addEventListener("keydown", dispatch, false);
    listening = true;
  } else if (!registrations.size && listening) {
    window.removeEventListener("keydown", dispatch, false);
    listening = false;
  }
}

/** Imperative registration, for code outside React. Returns the unregister function. */
export function registerShortcut(
  combo: string | readonly string[],
  handler: ShortcutHandler,
  options: ShortcutOptions = {},
): () => void {
  const registration: Registration = {
    combos: typeof combo === "string" ? [combo] : combo,
    handler: { current: handler },
    options: { current: options },
    order: (orderCounter += 1),
  };
  registrations.add(registration);
  sync();
  return () => {
    registrations.delete(registration);
    sync();
  };
}

/**
 * Bind a shortcut for as long as the component is mounted.
 * The handler and options may change every render without re-registering.
 */
export function useShortcut(
  combo: string | readonly string[],
  handler: ShortcutHandler,
  options: ShortcutOptions = {},
): void {
  const handlerRef = useRef(handler);
  const optionsRef = useRef(options);
  handlerRef.current = handler;
  optionsRef.current = options;
  const key = typeof combo === "string" ? combo : combo.join("\u0000");
  useEffect(() => {
    const registration: Registration = {
      combos: key.split("\u0000"),
      handler: handlerRef,
      options: optionsRef,
      order: (orderCounter += 1),
    };
    registrations.add(registration);
    sync();
    return () => {
      registrations.delete(registration);
      sync();
    };
  }, [key]);
}

/* --- Optional command registry ------------------------------------------------
   For surfaces that want a command's label, shortcut and action in one place
   (a menu item, a command bar button and the key all running the same thing):

     const save = useCommand({ id: "save", label: "Save", shortcut: "Ctrl+S", run: onSave });
     <CommandBarButton {...save.buttonProps} icon={<Save size={16} />} />

   It is a thin layer over useShortcut and needs no provider. */

export interface CommandSpec extends Omit<ShortcutOptions, "enabled"> {
  id: string;
  label: string;
  shortcut?: string | readonly string[];
  disabled?: boolean;
  run: () => void;
}

export function useCommand(spec: CommandSpec) {
  const { shortcut, disabled, run, label, id, ...options } = spec;
  useShortcut(shortcut ?? [], () => { run(); }, { ...options, enabled: Boolean(shortcut) && !disabled });
  const primary = typeof shortcut === "string" ? shortcut : shortcut?.[0];
  return {
    id,
    label,
    shortcut: primary,
    shortcutText: formatShortcut(primary),
    disabled: Boolean(disabled),
    run,
    buttonProps: {
      "aria-label": label,
      "aria-keyshortcuts": ariaKeyShortcuts(shortcut),
      "data-tooltip": label,
      "data-tooltip-shortcut": primary ? formatShortcut(primary) : undefined,
      disabled: Boolean(disabled),
      onClick: () => run(),
    },
  };
}

/** Test hook: drop every registration. */
export function resetShortcutsForTests() {
  registrations.clear();
  sync();
}
