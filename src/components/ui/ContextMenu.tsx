/* ContextMenu — the WinUI MenuFlyout.

   Acrylic, 8px corners, 4px vertical padding; 32px items with 4px corners
   inset 4px from the edge and 11px of text inset; 16px icons; accelerator
   text right-aligned in secondary ink; disabled items dimmed by colour, not
   opacity. Opens at a point (a contextmenu event) or anchored to an element,
   flipping to stay inside the window.

   Focus: opened by the keyboard (Shift+F10, the Menu key, a button's Enter)
   the first item takes focus; opened by the mouse the menu itself takes it,
   so arrows, Enter and Esc still work without painting a focus visual.
   Arrows / Home / End move, Enter / Space run, Esc / Tab close, typing jumps
   to the next item starting with that letter, and pressing an item's own
   shortcut runs it.

   Hook form, for most screens:

     const menu = useContextMenu();
     <div onContextMenu={(e) => menu.open(e, [
       { id: "rename", label: "Rename", icon: <Pencil size={16} />, shortcut: "F2", onSelect: rename },
       { separator: true },
       { id: "delete", label: "Delete", icon: <Trash2 size={16} />, shortcut: "Delete", onSelect: remove },
     ])} />
     {menu.element}

   `open` also takes a KeyboardEvent (anchors to its target and focuses the
   first item) or an element / DOMRect (anchors below it). */

import { Check } from "lucide-react";
import {
  useCallback, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode, type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { ariaKeyShortcuts, formatShortcut, matchesCombo } from "../../lib/commands";
import {
  LAYER_ATTR, createTypeahead, cx, focusSafely, isPrintableKey, lastInputWasKeyboard, placeAnchored, placeAtPoint,
  useLightDismiss, type RectLike,
} from "./internal";

export interface MenuItem {
  id?: string;
  label: string;
  icon?: ReactNode;
  /** A combo ("Ctrl+C", "Delete"); shown formatted and honoured while the menu is open. */
  shortcut?: string;
  disabled?: boolean;
  /** Kept for callers; Fluent paints destructive items like any other. */
  danger?: boolean;
  /** Renders a check column and role="menuitemcheckbox". */
  checked?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator { separator: true; id?: string }

export type MenuEntry = MenuItem | MenuSeparator;

export const isSeparator = (entry: MenuEntry): entry is MenuSeparator => "separator" in entry && entry.separator === true;

export type MenuPosition =
  | { x: number; y: number }
  | { anchor: Element | RectLike; placement?: "bottom" | "top" | "right" | "bottom-end" };

export interface ContextMenuProps {
  items: MenuEntry[];
  /** Where to open: a point, or an anchor element / rect. */
  position: MenuPosition;
  onClose: () => void;
  "aria-label"?: string;
  /** Focus the first item on open. Default: only when the last input was the keyboard. */
  focusFirst?: boolean;
  /** Return focus to the element that had it when the menu closes via Esc or a command. Default true. */
  restoreFocus?: boolean;
  className?: string;
  /** Minimum width in px (default 160 — Fluent's 120 is too tight for accelerators). */
  minWidth?: number;
}

const rectOf = (anchor: Element | RectLike): RectLike =>
  anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;

export function ContextMenu({
  items, position, onClose, focusFirst, restoreFocus = true, className, minWidth = 160, ...aria
}: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  const typeahead = useRef(createTypeahead());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const hasGlyphColumn = items.some((entry) => !isSeparator(entry) && (entry.icon !== undefined || entry.checked !== undefined));

  const buttons = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>("button[data-menu-item]:not(:disabled)") ?? [])];

  const positionKey = "x" in position ? `${position.x},${position.y}` : position.anchor;

  useLayoutEffect(() => {
    if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
    const element = menu.current;
    if (!element) return;
    const size = { width: element.offsetWidth || minWidth, height: element.offsetHeight || 0 };
    const placed = "x" in position
      ? placeAtPoint(position.x, position.y, size)
      : placeAnchored(rectOf(position.anchor), size, position.placement ?? "bottom", 4);
    setStyle({ left: placed.left, top: placed.top, minWidth });
    const keyboard = focusFirst ?? lastInputWasKeyboard();
    if (keyboard) focusSafely(buttons()[0] ?? element);
    else focusSafely(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);

  const close = useCallback((restore: boolean) => {
    if (restore && restoreFocus) focusSafely(opener.current);
    closeRef.current();
  }, [restoreFocus]);

  useLightDismiss(menu, true, (reason) => close(reason === "escape"));

  const run = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    item.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in a menu never reach the surface behind it.
    event.stopPropagation();
    const entries = items.filter((entry): entry is MenuItem => !isSeparator(entry));
    const accelerated = entries.find((item) => item.shortcut && !item.disabled && matchesCombo(event.nativeEvent, item.shortcut));
    if (accelerated && (event.ctrlKey || event.altKey || event.metaKey || event.key.length > 1)) {
      event.preventDefault();
      run(accelerated);
      return;
    }
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    switch (event.key) {
      case "ArrowDown": next = index < 0 ? 0 : (index + 1) % list.length; break;
      case "ArrowUp": next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length; break;
      case "Home": next = 0; break;
      case "End": next = list.length - 1; break;
      case "Tab": event.preventDefault(); close(true); return;
      case "Escape": event.preventDefault(); close(true); return;
      case "Enter":
      case " ":
        if (index >= 0) { event.preventDefault(); list[index].click(); }
        return;
      default:
        if (isPrintableKey(event)) {
          next = typeahead.current(event.key, list.map((button) => button.dataset.label ?? ""), index);
          if (next < 0) return;
        } else return;
    }
    event.preventDefault();
    focusSafely(list[next]);
  };

  return createPortal(
    <div
      ref={menu}
      role="menu"
      tabIndex={-1}
      aria-label={aria["aria-label"]}
      className={cx("ui-menu", hasGlyphColumn && "ui-menu--glyphs", className)}
      style={style}
      {...{ [LAYER_ATTR]: "menu" }}
      onContextMenu={(event: SyntheticEvent) => event.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, index) => {
        if (isSeparator(entry)) return <div key={entry.id ?? `separator-${index}`} role="separator" className="ui-menu__separator" />;
        const checkable = entry.checked !== undefined;
        return (
          <button
            key={entry.id ?? entry.label}
            type="button"
            role={checkable ? "menuitemcheckbox" : "menuitem"}
            aria-checked={checkable ? entry.checked : undefined}
            aria-keyshortcuts={ariaKeyShortcuts(entry.shortcut)}
            tabIndex={-1}
            disabled={entry.disabled}
            data-menu-item=""
            data-label={entry.label}
            className={cx("ui-menu__item", entry.danger && "ui-menu__item--danger")}
            onClick={() => run(entry)}
            onMouseEnter={(event) => { if (!entry.disabled) focusSafely(event.currentTarget); }}
          >
            {hasGlyphColumn && (
              <span className="ui-menu__glyph" aria-hidden="true">
                {checkable ? (entry.checked ? <Check size={16} /> : null) : entry.icon}
              </span>
            )}
            <span className="ui-menu__label">{entry.label}</span>
            {entry.shortcut && <kbd className="ui-menu__shortcut">{formatShortcut(entry.shortcut)}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/* --- Hook ---------------------------------------------------------------------- */

type OpenSource =
  | { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void; type?: string; currentTarget?: EventTarget | null; target?: EventTarget | null; nativeEvent?: Event }
  | { key: string; preventDefault?: () => void; stopPropagation?: () => void; currentTarget?: EventTarget | null; target?: EventTarget | null }
  | Element
  | RectLike;

export interface OpenMenuOptions {
  "aria-label"?: string;
  focusFirst?: boolean;
  placement?: "bottom" | "top" | "right" | "bottom-end";
  onClose?: () => void;
}

export function useContextMenu() {
  const [state, setState] = useState<{ items: MenuEntry[]; position: MenuPosition; options: OpenMenuOptions; focusFirst?: boolean; key: number } | null>(null);
  const counter = useRef(0);

  const current = useRef(state);
  current.current = state;

  const close = useCallback(() => {
    const closing = current.current;
    current.current = null;
    setState(null);
    closing?.options.onClose?.();
  }, []);

  const open = useCallback((source: OpenSource, items: MenuEntry[], options: OpenMenuOptions = {}) => {
    let position: MenuPosition;
    let focusFirst = options.focusFirst;
    if (typeof Element !== "undefined" && source instanceof Element) {
      position = { anchor: source, placement: options.placement };
    } else if ("key" in source) {
      source.preventDefault?.();
      source.stopPropagation?.();
      const target = (source.currentTarget ?? source.target) as Element | null;
      position = target instanceof Element ? { anchor: target, placement: options.placement } : { x: 0, y: 0 };
      focusFirst ??= true;
    } else if ("clientX" in source) {
      source.preventDefault?.();
      source.stopPropagation?.();
      // A contextmenu event raised by the keyboard has no coordinates.
      const target = (source.currentTarget ?? source.target) as Element | null;
      if (source.clientX === 0 && source.clientY === 0 && target instanceof Element) position = { anchor: target, placement: options.placement };
      else position = { x: source.clientX, y: source.clientY };
    } else {
      position = { anchor: source, placement: options.placement };
    }
    counter.current += 1;
    setState({ items, position, options, focusFirst, key: counter.current });
  }, []);

  const element = state ? (
    <ContextMenu
      key={state.key}
      items={state.items}
      position={state.position}
      focusFirst={state.focusFirst}
      aria-label={state.options["aria-label"]}
      onClose={close}
    />
  ) : null;

  return { open, close, element, isOpen: state !== null };
}
