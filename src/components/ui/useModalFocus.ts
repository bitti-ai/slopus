/* useModalFocus — the focus half of a modal surface.

   While `active`:
   - focus moves into `ref` (to `initialFocus`, else the first element marked
     [data-autofocus], else the first focusable element in the container's
     body region [data-modal-body], else the first focusable at all, else the
     container itself);
   - Tab and Shift+Tab wrap inside the container;
   - focus that escapes (a click on the page behind, a script) is pulled back,
     except into a popup layer opened from inside the modal (a ComboBox list,
     a menu), which lives in its own portal;
   - when it ends, focus returns to whatever had it before, if that is still
     in the document.

   ContentDialog uses it; any other modal surface (a full-screen editor, a
   wizard) can too:

     const panel = useRef<HTMLDivElement>(null);
     useModalFocus(panel, { active: open });
*/

import { useLayoutEffect, useRef, type RefObject } from "react";
import { LAYER_ATTR, focusSafely, focusables } from "./internal";

export interface ModalFocusOptions {
  /** Default true. */
  active?: boolean;
  /** Element to focus first. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Fallback when the body has nothing focusable (ContentDialog: its default button). */
  fallbackFocus?: () => HTMLElement | null | undefined;
  /** Default true. */
  restoreFocus?: boolean;
}

export function useModalFocus(ref: RefObject<HTMLElement | null>, options: ModalFocusOptions = {}) {
  const { active = true, restoreFocus = true } = options;
  const opts = useRef(options);
  opts.current = options;

  useLayoutEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const previous = document.activeElement as HTMLElement | null;

    const initial =
      opts.current.initialFocus?.current ??
      container.querySelector<HTMLElement>("[data-autofocus]") ??
      (() => {
        const body = container.querySelector<HTMLElement>("[data-modal-body]");
        return body ? focusables(body)[0] : undefined;
      })() ??
      opts.current.fallbackFocus?.() ??
      focusables(container)[0] ??
      container;
    if (initial === container && !container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
    focusSafely(initial);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) return;
      const items = focusables(container);
      if (!items.length) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        focusSafely(last);
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        focusSafely(first);
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node | null;
      if (!target || container.contains(target)) return;
      // A popup layer opened later than this modal belongs to it.
      const layer = target instanceof Element ? target.closest(`[${LAYER_ATTR}]`) : null;
      if (layer && layer !== container && container.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) return;
      // Another modal stacked on top of this one owns focus.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      const top = modals[modals.length - 1];
      if (top && top !== container && !top.contains(container)) return;
      focusSafely(focusables(container)[0] ?? container);
    };
    container.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      // Synchronously: during unmount the dialog is still in the document,
      // so focus moves straight from it to the opener with no stop at <body>.
      // A modal opened on top of this one keeps the focus it took.
      if (restoreFocus && previous && previous !== document.body && previous.isConnected) {
        const now = document.activeElement;
        const stolen = now && now !== document.body && !container.contains(now) && now.closest('[aria-modal="true"]');
        if (!stolen) focusSafely(previous);
      }
    };
  }, [active, ref, restoreFocus]);
}

