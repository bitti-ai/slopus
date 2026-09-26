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
       { id: "rename", label: "Rename", icon: <Rename16 />, shortcut: "F2", onSelect: rename },
       { separator: true },
       { id: "delete", label: "Delete", icon: <Delete16 />, shortcut: "Delete", onSelect: remove },
     ])} />
     {menu.element}

   `open` also takes a KeyboardEvent (anchors to its target and focuses the
   first item) or an element / DOMRect (anchors below it).

   Submenus: an item with `items` instead of `onSelect` opens a cascading
   menu beside it: on hover after a short pause, or on click, Enter, Space or
   Right. Left or Esc closes just that level and puts focus back on its item;
   a command anywhere in the cascade closes all of it. The item shows a
   chevron, and the submenu flips to the left when there is no room on the
   right:

     { id: "move", label: "Move to", items: scenes.map((scene) => ({ label: scene.title, onSelect: … })) } */

import { Check16, ChevronRight16 } from "./icons";
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
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
  /** Runs the command. Optional only for a submenu item (one with `items`). */
  onSelect?: () => void;
  /** Makes this a submenu item: these entries open in a cascading menu. */
  items?: MenuEntry[];
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
  /** Internal, for submenus: a command ran somewhere below, close everything. */
  onChosen?: () => void;
  /** Internal, for submenus: Left closes this level. */
  closeOnLeft?: boolean;
  /** Internal, for submenus opened by hovering: leave focus on the parent item. */
  keepFocus?: boolean;
  /** Internal, for submenus: the pointer reached it (cancels a pending close). */
  onPointerEnter?: () => void;
}

/** How long the pointer rests on a submenu item before it opens. WinUI waits
 *  about this long, so a diagonal move towards the submenu does not flicker. */
export const SUBMENU_HOVER_DELAY = 250;

const rectOf = (anchor: Element | RectLike): RectLike =>
  anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;

export function ContextMenu({
  items, position, onClose, focusFirst, restoreFocus = true, className, minWidth = 160, onChosen, closeOnLeft = false, onPointerEnter, keepFocus = false, ...aria
}: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  const typeahead = useRef(createTypeahead());
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [sub, setSub] = useState<{ index: number; anchor: HTMLElement; keyboard: boolean; hover: boolean; key: number } | null>(null);
  const subCounter = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHover = () => { if (hoverTimer.current !== undefined) { clearTimeout(hoverTimer.current); hoverTimer.current = undefined; } };
  useEffect(() => clearHover, []);
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
    else if (!keepFocus) focusSafely(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionKey]);

  const close = useCallback((restore: boolean) => {
    if (restore && restoreFocus) focusSafely(opener.current);
    closeRef.current();
  }, [restoreFocus]);

  useLightDismiss(menu, true, (reason) => close(reason === "escape"));

  /* A command closes the whole cascade: a submenu hands it up to the root,
     which restores focus to whatever had it before the menu opened. */
  const chosen = useCallback(() => {
    if (onChosen) onChosen();
    else close(true);
  }, [onChosen, close]);

  const openSub = (index: number, anchor: HTMLElement, keyboard: boolean, hover = false) => {
    clearHover();
    subCounter.current += 1;
    setSub({ index, anchor, keyboard, hover, key: subCounter.current });
  };

  const cascadeAt = (button: HTMLElement | null) => {
    const entry = button ? items[Number(button.dataset.index)] : undefined;
    return entry && !isSeparator(entry) && entry.items ? Number(button!.dataset.index) : -1;
  };

  const run = (item: MenuItem, button?: HTMLElement | null) => {
    if (item.disabled) return;
    if (item.items) {
      const index = items.indexOf(item);
      if (button && sub?.index !== index) openSub(index, button, lastInputWasKeyboard());
      return;
    }
    chosen();
    item.onSelect?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in a menu never reach the surface behind it.
    event.stopPropagation();
    const entries = items.filter((entry): entry is MenuItem => !isSeparator(entry));
    const accelerated = entries.find((item) => item.shortcut && !item.disabled && !item.items && matchesCombo(event.nativeEvent, item.shortcut));
    if (accelerated && (event.ctrlKey || event.altKey || event.metaKey || event.key.length > 1)) {
      event.preventDefault();
      run(accelerated);
      return;
    }
    const list = buttons();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const focused = index >= 0 ? list[index] : null;
    let next = -1;
    switch (event.key) {
      case "ArrowRight": {
        const at = cascadeAt(focused);
        if (focused && at >= 0) { event.preventDefault(); openSub(at, focused, true); }
        return;
      }
      case "ArrowLeft":
        if (closeOnLeft) { event.preventDefault(); close(true); }
        return;
      case "ArrowDown": next = index < 0 ? 0 : (index + 1) % list.length; break;
      case "ArrowUp": next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length; break;
      case "Home": next = 0; break;
      case "End": next = list.length - 1; break;
      case "Tab": event.preventDefault(); close(true); return;
      case "Escape": event.preventDefault(); close(true); return;
      case "Enter":
      case " ":
        if (focused) {
          event.preventDefault();
          const at = cascadeAt(focused);
          if (at >= 0) openSub(at, focused, true);
          else focused.click();
        }
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

  const subItem = sub ? items[sub.index] : undefined;
  const submenu = sub && subItem && !isSeparator(subItem) && subItem.items ? (
    <ContextMenu
      key={sub.key}
      items={subItem.items}
      position={{ anchor: sub.anchor, placement: "right" }}
      focusFirst={sub.keyboard}
      keepFocus={sub.hover}
      aria-label={subItem.label}
      minWidth={minWidth}
      closeOnLeft
      onChosen={chosen}
      onPointerEnter={clearHover}
      onClose={() => setSub(null)}
    />
  ) : null;

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
      onMouseEnter={onPointerEnter}
      onKeyDown={onKeyDown}
    >
      {items.map((entry, index) => {
        if (isSeparator(entry)) return <div key={entry.id ?? `separator-${index}`} role="separator" className="ui-menu__separator" />;
        const checkable = entry.checked !== undefined;
        const cascade = Boolean(entry.items);
        return (
          <button
            key={entry.id ?? entry.label}
            type="button"
            role={checkable ? "menuitemcheckbox" : "menuitem"}
            aria-checked={checkable ? entry.checked : undefined}
            aria-keyshortcuts={cascade ? undefined : ariaKeyShortcuts(entry.shortcut)}
            aria-haspopup={cascade ? "menu" : undefined}
            aria-expanded={cascade ? sub?.index === index : undefined}
            tabIndex={-1}
            disabled={entry.disabled}
            data-menu-item=""
            data-index={index}
            data-label={entry.label}
            className={cx("ui-menu__item", entry.danger && "ui-menu__item--danger", cascade && "ui-menu__item--cascade")}
            onClick={(event) => run(entry, event.currentTarget)}
            onMouseEnter={(event) => {
              clearHover();
              if (entry.disabled) return;
              const button = event.currentTarget;
              focusSafely(button);
              if (cascade) {
                if (sub?.index !== index) hoverTimer.current = setTimeout(() => openSub(index, button, false, true), SUBMENU_HOVER_DELAY);
              } else if (sub) {
                hoverTimer.current = setTimeout(() => setSub(null), SUBMENU_HOVER_DELAY);
              }
            }}
          >
            {hasGlyphColumn && (
              <span className="ui-menu__glyph" aria-hidden="true">
                {checkable ? (entry.checked ? <Check16 /> : null) : entry.icon}
              </span>
            )}
            <span className="ui-menu__label">{entry.label}</span>
            {entry.shortcut && !cascade && <kbd className="ui-menu__shortcut">{formatShortcut(entry.shortcut)}</kbd>}
            {cascade && <ChevronRight16 className="ui-menu__chevron" aria-hidden="true" />}
          </button>
        );
      })}
      {submenu}
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
