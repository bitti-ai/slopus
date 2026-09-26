/* Splitter + usePaneSize — resizable panes.

   A 4px hit area centred on a 1px line that turns accent under the mouse and
   while dragging. role="separator" with aria-valuenow/min/max; arrow keys
   move it 8px (Shift: 32px), Home/End jump to the limits, double-click
   resets. Sizes persist in localStorage under "slopus.pane.<key>".

     const inspector = usePaneSize("generator.inspector", 340, { min: 260, max: 560 });
     <div className="generator" style={inspector.style}>          // sets --pane-generator-inspector
       <main />
       <Splitter {...inspector.splitterProps} reverse aria-label="Resize inspector" />
       <aside />
     </div>
     .generator { grid-template-columns: 1fr auto var(--pane-generator-inspector); }

   `reverse` is for a pane on the right (or bottom) of the splitter: dragging
   towards it makes it smaller. Orientation "vertical" (default) is a vertical
   line between columns; "horizontal" is a horizontal line between rows. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { cx } from "./internal";

export interface PaneSizeOptions {
  min?: number;
  max?: number;
  /** CSS custom property name. Default `--pane-<key with dots → dashes>`. */
  cssVar?: string;
  /** Default true. */
  persist?: boolean;
}

export interface SplitterValueProps {
  value: number;
  min: number;
  max: number;
  onChange: (size: number) => void;
  onReset?: () => void;
}

export interface PaneSize {
  size: number;
  setSize: (size: number) => void;
  reset: () => void;
  min: number;
  max: number;
  cssVar: string;
  /** Spread on the grid container. */
  style: CSSProperties;
  /** Spread on the <Splitter>. */
  splitterProps: SplitterValueProps;
}

const STORAGE_PREFIX = "slopus.pane.";

function readStored(key: string): number | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function usePaneSize(key: string, defaultSize: number, options: PaneSizeOptions = {}): PaneSize {
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const persist = options.persist !== false;
  const cssVar = options.cssVar ?? `--pane-${key.replace(/[^a-zA-Z0-9-]+/g, "-")}`;
  const clampSize = useCallback((value: number) => Math.round(Math.min(max, Math.max(min, value))), [min, max]);
  const [size, setRaw] = useState(() => Math.round((persist ? readStored(key) : undefined) ?? defaultSize));

  useEffect(() => {
    if (!persist) return;
    try { localStorage.setItem(STORAGE_PREFIX + key, String(size)); } catch { /* storage unavailable */ }
  }, [key, size, persist]);

  const setSize = useCallback((value: number) => setRaw(clampSize(value)), [clampSize]);
  const reset = useCallback(() => setRaw(clampSize(defaultSize)), [clampSize, defaultSize]);
  /* The limits may move (a max that follows the window width). What is shown
     is clamped to the limits of the moment; the stored preference is not
     touched, so a pane squeezed by a narrow window comes back to its size
     when the window grows again. */
  const shown = clampSize(size);

  return useMemo(() => ({
    size: shown,
    setSize,
    reset,
    min,
    max,
    cssVar,
    style: { [cssVar]: `${shown}px` } as CSSProperties,
    splitterProps: { value: shown, min, max, onChange: setSize, onReset: reset },
  }), [shown, setSize, reset, min, max, cssVar]);
}

export interface SplitterProps extends SplitterValueProps {
  /** "vertical" = a vertical line between columns (default); "horizontal" = between rows. */
  orientation?: "vertical" | "horizontal";
  /** The pane being sized is after the splitter (right / below). */
  reverse?: boolean;
  "aria-label"?: string;
  /** Id of the pane being sized. */
  "aria-controls"?: string;
  className?: string;
  disabled?: boolean;
  /** Keyboard step in px (default 8; Shift ×4). */
  step?: number;
}

export function Splitter({
  value, min, max, onChange, onReset, orientation = "vertical", reverse, className, disabled, step = 8, ...aria
}: SplitterProps) {
  const drag = useRef<{ start: number; size: number; pointer: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === "vertical";
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { start: vertical ? event.clientX : event.clientY, size: value, pointer: event.pointerId };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = (vertical ? event.clientX : event.clientY) - drag.current.start;
    const next = clamp(drag.current.size + (reverse ? -delta : delta));
    if (next !== value) onChange(next);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    event.currentTarget.releasePointerCapture?.(drag.current.pointer);
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const amount = event.shiftKey ? step * 4 : step;
    const grow = reverse ? -amount : amount;
    let next: number | undefined;
    if (vertical && event.key === "ArrowLeft") next = value - grow;
    else if (vertical && event.key === "ArrowRight") next = value + grow;
    else if (!vertical && event.key === "ArrowUp") next = value - grow;
    else if (!vertical && event.key === "ArrowDown") next = value + grow;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter" && onReset) { event.preventDefault(); onReset(); return; }
    if (next === undefined) return;
    event.preventDefault();
    next = clamp(next);
    if (next !== value) onChange(next);
  };

  return (
    <div
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max === Number.MAX_SAFE_INTEGER ? undefined : max}
      aria-label={aria["aria-label"]}
      aria-controls={aria["aria-controls"]}
      aria-disabled={disabled || undefined}
      className={cx("ui-splitter", `ui-splitter--${orientation}`, dragging && "ui-splitter--dragging", className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => { if (!disabled) onReset?.(); }}
      onKeyDown={onKeyDown}
    />
  );
}
