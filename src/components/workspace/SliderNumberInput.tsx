import type { ComponentProps, CSSProperties } from "react";
import { Slider } from "../ui";
import { CommittedNumberInput } from "./CommittedNumberInput";

/** One bounded value, editable by dragging or typing. Keep number widths large
 * enough for the range, sign and fractional precision without crowding the bar. */
export function SliderNumberInput({ minimum, maximum, value, step = 1, sliderLabel, suffix, disabled, onCommit, ...input }: Omit<ComponentProps<typeof CommittedNumberInput>, "step"> & {
  step?: number;
  sliderLabel?: string;
  suffix?: string;
}) {
  const label = input["aria-label"] ?? "Value";
  const precision = Math.min(6, String(step).split(".")[1]?.length ?? 0);
  const digits = Math.max(String(minimum.toFixed(precision)).length, String(maximum.toFixed(precision)).length, String(value).length);
  const range = `${minimum} to ${maximum}`;
  const change = (next: number) => { if (!disabled) onCommit(next); };
  return <div className="slider-number" style={{ "--number-width": `${Math.max(4, digits)}ch` } as CSSProperties}>
    <Slider aria-label={sliderLabel ?? `${label} slider`} min={minimum} max={maximum} step={step}
      value={value} disabled={disabled} title={range} onChange={change} />
    <CommittedNumberInput {...input} className={`text-field slider-number__input ${input.className ?? ""}`}
      minimum={minimum} maximum={maximum} step={step} value={value} disabled={disabled} title={input.title ?? range} onCommit={change} />
    {suffix && <span className="slider-number__unit" aria-hidden="true">{suffix.trim()}</span>}
  </div>;
}

/** Inspector editing ranges; persisted projects and engine limits stay intact. */
export const GENERATION_STEPS_RANGE = { minimum: 2, maximum: 1000, step: 1, integer: true } as const;
export const SIGMA_SHIFT_RANGE = { minimum: 0.1, maximum: 100, step: 0.1 } as const;
export const CFG_RANGE = { minimum: 0, maximum: 30, step: 0.1 } as const;
