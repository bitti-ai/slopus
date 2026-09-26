/* Tooltip — one delegated layer for every [data-tooltip] in the app.

   Mount <TooltipLayer /> once at the root (or <FluentRuntime />, which also
   installs the slider fill). Then any element can ask for a tooltip:

     <button className="icon-button" aria-label="Split clip" {...tooltipProps("Split clip", "S")}>

   which is just data-tooltip="Split clip" data-tooltip-shortcut="S". The
   shortcut is shown after the text in secondary ink.

   Timing is WinUI's: shown after 500ms of hover or on keyboard focus, 100ms
   when moving straight from one tooltip to another; hidden on pointer press,
   scroll, Esc, blur and when the pointer leaves. Placed below the pointer
   (below the element for keyboard focus), flipped above near the bottom of
   the window and kept inside it horizontally.

   Migrating from title="…": replace `title={x}` with `{...tooltipProps(x)}`.
   An icon-only button still needs its aria-label; the tooltip is visual. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatShortcut } from "../../lib/commands";
import { installRangeFill } from "../../lib/rangeFill";
import { VIEWPORT_MARGIN, lastInputWasKeyboard, viewport } from "./internal";

export const TOOLTIP_DELAY = 500;
export const TOOLTIP_BETWEEN_DELAY = 100;
/** How long after a tooltip hides the next one still counts as "moving between". */
const BETWEEN_WINDOW = 400;

/** Props that give an element a tooltip. Spread onto any element. */
export function tooltipProps(text: string | undefined | null, shortcut?: string | null): { "data-tooltip"?: string; "data-tooltip-shortcut"?: string } {
  if (!text) return {};
  return shortcut ? { "data-tooltip": text, "data-tooltip-shortcut": formatShortcut(shortcut) } : { "data-tooltip": text };
}

interface Shown {
  target: HTMLElement;
  text: string;
  shortcut?: string;
  /** Pointer position for hover, undefined for focus (place under the element). */
  point?: { x: number; y: number };
}

const findTarget = (node: EventTarget | null): HTMLElement | null =>
  node instanceof Element ? (node.closest<HTMLElement>("[data-tooltip]")) : null;

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const lastHidden = useRef(-Infinity);
  const current = useRef<Shown | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const clear = () => { window.clearTimeout(timer.current); pending.current = null; };
    const hide = () => {
      clear();
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setShown(null);
    };
    const show = (target: HTMLElement, viaFocus: boolean) => {
      const text = target.dataset.tooltip;
      if (!text) return;
      const next: Shown = { target, text, shortcut: target.dataset.tooltipShortcut || undefined, point: viaFocus ? undefined : { ...pointer.current } };
      current.current = next;
      setShown(next);
    };
    const schedule = (target: HTMLElement, viaFocus: boolean) => {
      if (current.current?.target === target || pending.current === target) return;
      const between = current.current !== null || Date.now() - lastHidden.current < BETWEEN_WINDOW;
      clear();
      if (current.current) { current.current = null; setShown(null); lastHidden.current = Date.now(); }
      pending.current = target;
      timer.current = window.setTimeout(() => { pending.current = null; if (target.isConnected) show(target, viaFocus); }, between ? TOOLTIP_BETWEEN_DELAY : TOOLTIP_DELAY);
    };

    const onOver = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      const target = findTarget(event.target);
      if (target) schedule(target, false);
      else if (current.current || pending.current) hide();
    };
    const onMove = (event: MouseEvent) => { pointer.current = { x: event.clientX, y: event.clientY }; };
    const onOut = (event: MouseEvent) => {
      const from = findTarget(event.target);
      const to = findTarget(event.relatedTarget);
      if (from && from !== to && !to) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = findTarget(event.target);
      if (target && lastInputWasKeyboard()) schedule(target, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (findTarget(event.target) && (current.current?.target === event.target || pending.current === event.target)) hide();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && (current.current || pending.current)) hide(); };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseout", onOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", hide);
    return () => {
      clear();
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("wheel", hide, { capture: true });
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  /* A shown tooltip whose element disappears (a re-render) or whose text changes follows it. */
  useEffect(() => {
    if (!shown) return;
    const observer = new MutationObserver(() => {
      if (!shown.target.isConnected || !shown.target.dataset.tooltip) { current.current = null; setShown(null); return; }
      if (shown.target.dataset.tooltip !== shown.text || (shown.target.dataset.tooltipShortcut || undefined) !== shown.shortcut) {
        const next = { ...shown, text: shown.target.dataset.tooltip, shortcut: shown.target.dataset.tooltipShortcut || undefined };
        current.current = next;
        setShown(next);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-tooltip", "data-tooltip-shortcut"] });
    return () => observer.disconnect();
  }, [shown]);

  /* Describe the element while the tooltip is up, unless its name already says the same. */
  useEffect(() => {
    if (!shown || !tip.current) return;
    const target = shown.target;
    if (target.getAttribute("aria-label") === shown.text) return;
    const before = target.getAttribute("aria-describedby");
    const id = tip.current.id;
    target.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    return () => {
      if (before === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", before);
    };
  }, [shown]);

  useLayoutEffect(() => {
    if (!shown || !tip.current) return;
    const view = viewport();
    // Measure at the origin, so a tooltip last shown near the right edge is
    // not measured wrapped against it.
    const element = tip.current;
    element.style.visibility = "hidden";
    element.style.left = "0px";
    element.style.top = "0px";
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left: number;
    let top: number;
    if (shown.point) {
      left = shown.point.x - width / 2;
      top = shown.point.y + 20;
      if (top + height > view.height - VIEWPORT_MARGIN) top = shown.point.y - height - 12;
    } else {
      const rect = shown.target.getBoundingClientRect();
      left = rect.left + rect.width / 2 - width / 2;
      top = rect.bottom + 8;
      if (top + height > view.height - VIEWPORT_MARGIN) top = rect.top - height - 8;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, view.width - width - VIEWPORT_MARGIN));
    top = Math.max(VIEWPORT_MARGIN, top);
    // Written straight to the element: React never owns these, so a tooltip
    // that lands on the same spot as the last one is still repositioned.
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "";
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div ref={tip} id="ui-tooltip" role="tooltip" className="ui-tooltip">
      <span className="ui-tooltip__text">{shown.text}</span>
      {shown.shortcut && <span className="ui-tooltip__shortcut">{shown.shortcut}</span>}
    </div>,
    document.body,
  );
}

/** Mount once at the app root: the tooltip layer plus the slider fill for every range input. */
export function FluentRuntime() {
  useEffect(() => installRangeFill(document), []);
  return <TooltipLayer />;
}
