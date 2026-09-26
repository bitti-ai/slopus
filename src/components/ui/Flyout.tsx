/* Flyout — an anchored, light-dismiss popup on acrylic (WinUI Flyout).

   For small tools that open from a button: the work queue, a colour picker,
   a filter panel. It is non-modal: a press outside, Esc, a window resize or
   the window losing focus closes it; focus moves into it on open and back to
   the anchor on Esc.

     const button = useRef<HTMLButtonElement>(null);
     const [open, setOpen] = useState(false);
     <button ref={button} aria-expanded={open} onClick={() => setOpen(!open)}>Queue</button>
     <Flyout open={open} anchor={button} onClose={() => setOpen(false)} aria-label="Work queue">
       …
     </Flyout>
*/

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LAYER_ATTR, cx, focusSafely, focusables, placeAnchored, useLightDismiss, type Placement, type RectLike } from "./internal";

export interface FlyoutProps {
  open: boolean;
  /** The element it hangs from (a ref or the element), or a rect. */
  anchor: RefObject<HTMLElement | null> | HTMLElement | RectLike | null;
  onClose: () => void;
  children?: ReactNode;
  placement?: Placement;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
  /** Focus this on open; default the first focusable inside, else the flyout. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Width in px (default: content). */
  width?: number;
  /** Default "dialog". */
  role?: "dialog" | "region" | "group";
}

const resolveAnchor = (anchor: FlyoutProps["anchor"]): { element: HTMLElement | null; rect: RectLike | null } => {
  if (!anchor) return { element: null, rect: null };
  if (typeof HTMLElement !== "undefined" && anchor instanceof HTMLElement) return { element: anchor, rect: anchor.getBoundingClientRect() };
  if ("current" in anchor) return { element: anchor.current, rect: anchor.current?.getBoundingClientRect() ?? null };
  return { element: null, rect: anchor as RectLike };
};

export function Flyout({ open, anchor, onClose, children, placement = "bottom", className, initialFocus, width, role = "dialog", ...aria }: FlyoutProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const anchorElement = resolveAnchor(anchor).element;

  useLayoutEffect(() => {
    if (!open || !panel.current) return;
    const { rect } = resolveAnchor(anchor);
    const size = { width: panel.current.offsetWidth, height: panel.current.offsetHeight };
    const placed = rect ? placeAnchored(rect, size, placement, 4) : { left: 8, top: 8 };
    setStyle({ left: placed.left, top: placed.top, width });
    focusSafely(initialFocus?.current ?? focusables(panel.current)[0] ?? panel.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useLightDismiss(panel, open, (reason) => {
    if (reason === "escape") focusSafely(resolveAnchor(anchor).element);
    onClose();
  }, { ignore: [anchorElement] });

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role={role}
      tabIndex={-1}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      className={cx("ui-flyout", className)}
      style={style}
      {...{ [LAYER_ATTR]: "flyout" }}
    >
      {children}
    </div>,
    document.body,
  );
}
