/* Shortcuts the browser guard gets to first.

   installBrowserGuards (nativeShell.ts) cancels a few keys before the page
   sees them — Alt+Left (browser Back) in the capture phase, and Ctrl+F (the
   Edge find bar) in a window listener registered at startup, ahead of the
   commands.ts dispatcher. The dispatcher skips any press whose default is
   already prevented, so useShortcut can never fire for those keys in the
   desktop app. These two ARE Slopus commands (Back to the library, Search
   projects), so they listen on the document instead: a document listener
   runs before any window listener in the bubble phase, and it ignores the
   guard's preventDefault, which only exists to stop the browser's own action.

   Same rules as useShortcut otherwise: nothing while an aria-modal dialog is
   open, text fields left alone unless `allowInInput`. */

import { useEffect, useRef } from "react";
import { isTextEntry, matchesCombo } from "./commands";

export function useGuardedShortcut(
  combo: string,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; allowInInput?: boolean } = {},
) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const { enabled = true, allowInInput = false } = options;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !matchesCombo(event, combo)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if (!allowInInput && isTextEntry(event.target)) return;
      event.preventDefault();
      handlerRef.current(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [combo, enabled, allowInInput]);
}
