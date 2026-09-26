import { useEffect, useState, type ReactNode } from "react";
import icon from "../../marketing/icon.png";
import {
  closeWindow, minimizeWindow, onMaximizedChange, onWindowFocusChange, toggleMaximizeWindow,
} from "../lib/nativeShell";

/* The window's title bar. The window is frameless (tauri.conf.json
   `decorations: false`), so this row IS the caption: it drags the window,
   double-clicking it maximizes and restores (Tauri's drag script does both),
   and it carries the three caption buttons at the right edge.

   Screens own what goes in it:

     [leading] [icon title secondary] [children ········] [actions] [– □ ×]

   The whole bar is a drag region "deep", so any plain text or empty space in
   any slot drags the window; Tauri's drag script stops at the first button,
   link, input, [tabindex] or interactive role on the way up, so the controls a
   screen puts in a slot keep working without opting out. Something clickable
   that is none of those needs `data-tauri-drag-region="false"`. */

export interface TitleBarProps {
  /** The window's caption, 12px. Defaults to "Slopus". */
  title?: ReactNode;
  /** Quieter text after the title, e.g. the open project's folder. */
  secondary?: ReactNode;
  /** Replaces the 16px app icon; `false` leaves it out. */
  icon?: ReactNode | false;
  /** Before the icon, e.g. a Back button. */
  leading?: ReactNode;
  /** The flexible middle, e.g. a search box or tabs. Fills the free width. */
  children?: ReactNode;
  /** Right-aligned, just before the caption buttons, e.g. Save. */
  actions?: ReactNode;
  className?: string;
}

/* Segoe Fluent Icons (Windows 11), with Segoe MDL2 Assets (Windows 10) at the
   same code points, which is what Windows' own caption buttons draw. */
const GLYPH = {
  minimize: "",
  maximize: "",
  restore: "",
  close: "",
} as const;

/** Follows the native maximized state. False outside Tauri. */
export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => onMaximizedChange(setMaximized), []);
  return maximized;
}

function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => onWindowFocusChange(setFocused), []);
  return focused;
}

export function TitleBar({
  title = "Slopus",
  secondary,
  icon: customIcon,
  leading,
  children,
  actions,
  className,
}: TitleBarProps) {
  const maximized = useWindowMaximized();
  const focused = useWindowFocused();
  const classes = ["titlebar", focused ? "" : "titlebar--inactive", className ?? ""].filter(Boolean).join(" ");
  const run = (action: () => Promise<void>) => () => { void action().catch(() => undefined); };

  return (
    <header className={classes} data-tauri-drag-region="deep" data-maximized={maximized || undefined}>
      {leading && <div className="titlebar__leading">{leading}</div>}
      <div className="titlebar__identity">
        {customIcon !== false && (
          <span className="titlebar__icon" aria-hidden="true">
            {customIcon ?? <img src={icon} alt="" draggable={false} />}
          </span>
        )}
        <span className="titlebar__title">{title}</span>
        {secondary && <span className="titlebar__secondary">{secondary}</span>}
      </div>
      <div className="titlebar__middle">{children}</div>
      {actions && <div className="titlebar__actions">{actions}</div>}
      {/* Not tab stops, like Windows' own: the keyboard reaches them through
          Alt+Space, Win+Up/Down and Alt+F4. */}
      <div className="titlebar__captions" role="group" aria-label="Window controls">
        <button type="button" className="titlebar__caption" tabIndex={-1} aria-label="Minimize" data-tooltip="Minimize" onClick={run(minimizeWindow)}>
          <span aria-hidden="true">{GLYPH.minimize}</span>
        </button>
        <button
          type="button"
          className="titlebar__caption titlebar__caption--maximize"
          tabIndex={-1}
          aria-label={maximized ? "Restore" : "Maximize"}
          data-tooltip={maximized ? "Restore Down" : "Maximize"}
          onClick={run(toggleMaximizeWindow)}
        >
          <span aria-hidden="true">{maximized ? GLYPH.restore : GLYPH.maximize}</span>
        </button>
        <button type="button" className="titlebar__caption titlebar__caption--close" tabIndex={-1} aria-label="Close" data-tooltip="Close" onClick={run(closeWindow)}>
          <span aria-hidden="true">{GLYPH.close}</span>
        </button>
      </div>
    </header>
  );
}
