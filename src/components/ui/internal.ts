/* Shared plumbing for the Fluent components: class joining, placement maths,
   input-modality tracking, focus helpers and light dismiss. Not part of the
   public API (index.ts re-exports only what screens need). */

import { useEffect, useRef, type RefObject } from "react";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

/* --- Layers ------------------------------------------------------------------
   Everything that overlays renders into document.body through a portal. The
   attribute marks a layer so focus traps and light dismiss can tell "inside a
   popup that belongs to me" from "outside". */
export const LAYER_ATTR = "data-ui-layer";

/* --- Placement --------------------------------------------------------------- */

export interface Size { width: number; height: number }
export interface Point { left: number; top: number }
export interface RectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }

export const VIEWPORT_MARGIN = 8;

export function viewport(): Size {
  return { width: window.innerWidth || document.documentElement.clientWidth || 0, height: window.innerHeight || document.documentElement.clientHeight || 0 };
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/** A menu opened at a point: down-right of it, flipped left/up when it would overflow. */
export function placeAtPoint(x: number, y: number, size: Size, view: Size = viewport(), margin = VIEWPORT_MARGIN): Point {
  let left = x;
  let top = y;
  if (left + size.width > view.width - margin && x - size.width >= margin) left = x - size.width;
  if (top + size.height > view.height - margin && y - size.height >= margin) top = y - size.height;
  return { left: clamp(left, margin, view.width - size.width - margin), top: clamp(top, margin, view.height - size.height - margin) };
}

export type Placement = "bottom" | "top" | "right" | "left" | "bottom-end" | "top-end";

/** A popup anchored to an element: preferred side first, flipped when it does not fit. */
export function placeAnchored(anchor: RectLike, size: Size, placement: Placement = "bottom", gap = 4, view: Size = viewport(), margin = VIEWPORT_MARGIN): Point & { placement: Placement } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= view.height - margin;
  const fitsAbove = above >= margin;
  if (placement === "right" || placement === "left") {
    const right = anchor.right + gap;
    const left = anchor.left - gap - size.width;
    const fitsRight = right + size.width <= view.width - margin;
    const fitsLeft = left >= margin;
    const useRight = placement === "right" ? fitsRight || !fitsLeft : !(fitsLeft || !fitsRight);
    return {
      left: clamp(useRight ? right : left, margin, view.width - size.width - margin),
      top: clamp(anchor.top, margin, view.height - size.height - margin),
      placement: useRight ? "right" : "left",
    };
  }
  const end = placement.endsWith("-end");
  const wantsBelow = !placement.startsWith("top");
  const useBelow = wantsBelow ? fitsBelow || !fitsAbove : !(fitsAbove || !fitsBelow);
  const rawLeft = end ? anchor.right - size.width : anchor.left;
  return {
    left: clamp(rawLeft, margin, view.width - size.width - margin),
    top: clamp(useBelow ? below : above, margin, view.height - size.height - margin),
    placement: (useBelow ? "bottom" : "top") + (end ? "-end" : "") as Placement,
  };
}

/* --- Input modality -----------------------------------------------------------
   Windows menus take keyboard focus onto their first item only when they were
   opened with the keyboard. We remember what the user last did. */

let lastKeyboard = false;
let tracking = false;

export function trackModality() {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  document.addEventListener("keydown", (event) => {
    if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) lastKeyboard = true;
  }, true);
  const pointer = () => { lastKeyboard = false; };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("mousedown", pointer, true);
  // No contextmenu listener: a right-click always presses the mouse first,
  // while Shift+F10 / the Menu key leave the keyboard flag set, so a menu
  // opened from a contextmenu event already knows which one it was.
}
trackModality();

export const lastInputWasKeyboard = () => lastKeyboard;

/* --- Focus ------------------------------------------------------------------- */

const FOCUSABLE = [
  "a[href]", "area[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])", "textarea:not([disabled])", "iframe", "[contenteditable=''],[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
    !element.hasAttribute("inert") && !element.closest("[inert]") && element.getAttribute("aria-hidden") !== "true" && !(element as HTMLElement & { hidden?: boolean }).hidden);
}

/** Focus without scrolling the page, when the element can still be focused. */
export function focusSafely(element: HTMLElement | null | undefined) {
  if (element && element.isConnected) element.focus({ preventScroll: true });
}

/* --- Light dismiss ------------------------------------------------------------
   A flyout closes on a pointer press outside it (and outside the element that
   opened it), on Esc, and when the window loses focus or resizes. Esc is
   caught in the capture phase and stopped, so a dialog underneath does not
   also close. */

export interface DismissOptions {
  /** Elements whose presses do NOT count as outside (the anchor, typically). */
  ignore?: (RefObject<Element | null> | Element | null | undefined)[];
  /** Default true. */
  escape?: boolean;
  /** Close on window resize / blur (default true). */
  windowChanges?: boolean;
}

export function useLightDismiss(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: (reason: "outside" | "escape" | "window") => void,
  options: DismissOptions = {},
) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const opts = useRef(options);
  opts.current = options;

  useEffect(() => {
    if (!active) return;
    const inside = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return false;
      if (ref.current?.contains(target)) return true;
      for (const entry of opts.current.ignore ?? []) {
        const element = entry && "current" in (entry as object) ? (entry as RefObject<Element>).current : (entry as Element | null | undefined);
        if (element?.contains(target)) return true;
      }
      // A nested popup (a ComboBox list inside a Flyout) is part of us.
      const layer = target instanceof Element ? target.closest(`[${LAYER_ATTR}]`) : target.parentElement?.closest(`[${LAYER_ATTR}]`);
      if (layer && ref.current && layer !== ref.current && layer.compareDocumentPosition(ref.current) & Node.DOCUMENT_POSITION_PRECEDING) return true;
      return false;
    };
    const pointer = (event: Event) => { if (!inside(event.target)) dismiss.current("outside"); };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || opts.current.escape === false) return;
      // Only the top-most layer answers Esc.
      const layers = document.querySelectorAll(`[${LAYER_ATTR}]`);
      if (layers.length && layers[layers.length - 1] !== ref.current && ref.current) {
        const last = layers[layers.length - 1];
        if (!ref.current.contains(last)) return;
      }
      event.preventDefault();
      event.stopPropagation();
      dismiss.current("escape");
    };
    const windowChange = () => { if (opts.current.windowChanges !== false) dismiss.current("window"); };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("mousedown", pointer, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", windowChange);
    window.addEventListener("blur", windowChange);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("mousedown", pointer, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", windowChange);
      window.removeEventListener("blur", windowChange);
    };
  }, [active, ref]);
}

/* --- Typeahead ---------------------------------------------------------------- */

/** Accumulates printable keys for 700ms and finds the next label starting with them. */
export function createTypeahead(timeout = 700) {
  let buffer = "";
  let last = 0;
  return (key: string, labels: string[], from: number): number => {
    const now = Date.now();
    buffer = now - last > timeout ? key : buffer + key;
    last = now;
    const needle = buffer.toLowerCase();
    const count = labels.length;
    // A repeated single letter cycles through matches.
    const repeat = needle.length > 1 && [...needle].every((ch) => ch === needle[0]);
    const search = repeat ? needle[0] : needle;
    const start = buffer.length === 1 || repeat ? from + 1 : from;
    for (let i = 0; i < count; i += 1) {
      const index = (start + i + count) % count;
      if (labels[index]?.toLowerCase().startsWith(search)) return index;
    }
    return -1;
  };
}

export const isPrintableKey = (event: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
  event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.altKey && !event.metaKey;

/** Plain text of a React node (for typeahead and aria). */
export function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && node && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
  return "";
}
