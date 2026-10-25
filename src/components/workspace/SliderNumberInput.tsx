import type { ComponentProps } from "react";
import { Slider } from "../ui";
import { CommittedNumberInput } from "./CommittedNumberInput";

/** One bounded value, editable by dragging or typing, with shared column widths
 * so ranges, values and optional units do not shift neighboring controls. */
export function SliderNumberInput({ minimum, maximum, value, step = 1, sliderLabel, suffix, disabled, onCommit, ...input }: Omit<ComponentProps<typeof CommittedNumberInput>, "step"> & {
  step?: number;
  sliderLabel?: string;
  suffix?: string;
}) {
  const label = input["aria-label"] ?? "Value";
  const range = `${minimum} to ${maximum}`;
  const change = (next: number) => { if (!disabled) onCommit(next); };
  return <div className="slider-number">
    <Slider aria-label={sliderLabel ?? `${label} slider`} min={minimum} max={maximum} step={step}
      value={value} disabled={disabled} title={range} onChange={change} />
    <CommittedNumberInput {...input} className={`text-field slider-number__input ${input.className ?? ""}`}
      minimum={minimum} maximum={maximum} step={step} value={value} disabled={disabled} title={input.title ?? range} onCommit={change} />
    <span className="slider-number__unit" aria-hidden="true">{suffix?.trim()}</span>
  </div>;
}

/** Inspector editing ranges; persisted projects and engine limits stay intact. */
export const GENERATION_STEPS_RANGE = { minimum: 2, maximum: 100, step: 1, integer: true } as const;
export const SIGMA_SHIFT_RANGE = { minimum: 0.1, maximum: 20, step: 0.1 } as const;
export const CFG_RANGE = { minimum: 0, maximum: 10, step: 0.1 } as const;
