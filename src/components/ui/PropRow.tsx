/* PropRow + PropSection — dense inspector rows.

   A row is a grid: label (--prop-label, 104px) | value | 20px reset. 28px
   min height, the label in 12px secondary ink. Give it `scrub` and dragging horizontally on
   the label changes the number (ew-resize cursor, pointer capture, `step` per
   pixel, Shift ×10) — the way every node editor does it. The reset button
   appears only when the value differs from its default.

   A section header is a 28px (--section-row) strip on --surface-chrome with
   a --line above and below: chevron, 12px semibold title, and an optional
   right-aligned `summary` (a count, "1 changed") that stays visible while
   the section is collapsed.

     <PropSection title="Transform" persistKey="clip.transform">
       <PropRow label="Opacity" htmlFor="opacity" value={opacity} defaultValue={100}
         onReset={() => setOpacity(100)} scrub={{ value: opacity, onChange: setOpacity, min: 0, max: 100 }}>
         <input id="opacity" className="text-field" … />
       </PropRow>
     </PropSection>
*/

import { ChevronDown12, Reset12 } from "./icons";
import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { cx } from "./internal";

export interface ScrubOptions {
  value: number;
  onChange: (value: number) => void;
  /** Per pixel of drag (default 1). Shift multiplies by 10. */
  step?: number;
  min?: number;
  max?: number;
  /** Called once when a drag ends (e.g. to seal an undo step). */
  onCommit?: (value: number) => void;
}

export interface PropRowProps {
  label: ReactNode;
  /** Id of the control the label names. */
  htmlFor?: string;
  children?: ReactNode;
  /** Current and default value, to decide whether the reset button shows. */
  value?: unknown;
  defaultValue?: unknown;
  /** Force the modified state (overrides the value/defaultValue comparison). */
  modified?: boolean;
  onReset?: () => void;
  resetLabel?: string;
  scrub?: ScrubOptions;
  className?: string;
}

const DRAG_THRESHOLD = 3;

export function PropRow({ label, htmlFor, children, value, defaultValue, modified, onReset, resetLabel, scrub, className }: PropRowProps) {
  const drag = useRef<{ x: number; start: number; accumulated: number; moved: boolean; pointer: number } | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const suppressClick = useRef(false);
  const isModified = modified ?? (defaultValue !== undefined && value !== undefined && !Object.is(value, defaultValue));

  const clamp = (next: number) => Math.min(scrub?.max ?? Infinity, Math.max(scrub?.min ?? -Infinity, next));
  const round = (next: number, step: number) => {
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Number(next.toFixed(decimals));
  };

  const onPointerDown = (event: PointerEvent<HTMLLabelElement>) => {
    if (!scrub || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { x: event.clientX, start: scrub.value, accumulated: 0, moved: false, pointer: event.pointerId };
  };
  const onPointerMove = (event: PointerEvent<HTMLLabelElement>) => {
    const state = drag.current;
    if (!state || !scrub) return;
    const dx = event.clientX - state.x;
    state.x = event.clientX;
    state.accumulated += dx * (event.shiftKey ? 10 : 1);
    if (!state.moved && Math.abs(state.accumulated) < DRAG_THRESHOLD) return;
    if (!state.moved) { state.moved = true; setScrubbing(true); }
    const step = scrub.step ?? 1;
    const next = clamp(round(state.start + Math.round(state.accumulated) * step, step));
    if (next !== scrub.value) scrub.onChange(next);
  };
  const end = (event: PointerEvent<HTMLLabelElement>) => {
    const state = drag.current;
    if (!state) return;
    event.currentTarget.releasePointerCapture?.(state.pointer);
    drag.current = null;
    if (state.moved) {
      suppressClick.current = true;
      setScrubbing(false);
      scrub?.onCommit?.(scrub.value);
    }
  };

  return (
    <div className={cx("ui-prop-row", scrubbing && "ui-prop-row--scrubbing", className)}>
      <label
        className={cx("ui-prop-row__label", scrub && "ui-prop-row__label--scrub")}
        htmlFor={htmlFor}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        // A drag should not end by focusing (and selecting) the field.
        onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); } }}
      >
        {label}
      </label>
      <div className="ui-prop-row__value">{children}</div>
      {isModified && onReset ? (
        <button
          type="button"
          className="ui-prop-row__reset"
          aria-label={resetLabel ?? `Reset ${typeof label === "string" ? label : "value"}`}
          data-tooltip={resetLabel ?? "Reset to default"}
          onClick={onReset}
        >
          <Reset12 aria-hidden="true" />
        </button>
      ) : <span className="ui-prop-row__reset-spacer" aria-hidden="true" />}
    </div>
  );
}

export interface PropSectionProps {
  title: ReactNode;
  children?: ReactNode;
  /** Controlled open state. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Remember the open state in localStorage under "slopus.section.<key>". */
  persistKey?: string;
  /** Right-aligned in the header, visible when collapsed too: a count or "1 changed". */
  summary?: ReactNode;
  /** Buttons at the header's trailing edge (compact icon buttons). */
  actions?: ReactNode;
  className?: string;
}

function readOpen(key: string | undefined, fallback: boolean) {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(`slopus.section.${key}`);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function PropSection({ title, children, open, defaultOpen = true, onOpenChange, persistKey, summary, actions, className }: PropSectionProps) {
  const [inner, setInner] = useState(() => readOpen(persistKey, defaultOpen));
  const isOpen = open ?? inner;
  const contentId = useId();
  useEffect(() => {
    if (!persistKey || open !== undefined) return;
    try { localStorage.setItem(`slopus.section.${persistKey}`, inner ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [persistKey, inner, open]);
  const toggle = () => {
    if (open === undefined) setInner(!isOpen);
    onOpenChange?.(!isOpen);
  };
  return (
    <section className={cx("ui-prop-section", isOpen && "ui-prop-section--open", className)}>
      <div className="ui-prop-section__header">
        <button type="button" className="ui-prop-section__toggle" aria-expanded={isOpen} aria-controls={contentId} onClick={toggle}>
          <ChevronDown12 aria-hidden="true" className="ui-prop-section__chevron" />
          <span className="ui-prop-section__title">{title}</span>
          {summary !== undefined && summary !== null && summary !== false && <span className="ui-prop-section__summary">{summary}</span>}
        </button>
        {actions && <span className="ui-prop-section__actions">{actions}</span>}
      </div>
      <div id={contentId} className="ui-prop-section__content" hidden={!isOpen}>{children}</div>
    </section>
  );
}
