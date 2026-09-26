/* The small WinUI controls: ToggleSwitch, Checkbox, RadioGroup / Radio,
   Slider, ProgressBar, ProgressRing, InfoBadge, Expander, SelectorBar.

   Check boxes, radios and sliders are native inputs underneath (controls.css
   already paints them Fluent); these components add the label layout,
   indeterminate state and the slider's filled track. */

import { ChevronDown } from "lucide-react";
import {
  createContext, useContext, useEffect, useId, useRef,
  type ChangeEvent, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode,
} from "react";
import { cx } from "./internal";
import { useDisclosure } from "./Settings";

/* --- ToggleSwitch --------------------------------------------------------------
   40×20 track, 12px knob, accent when on. WinUI shows "On"/"Off" to the LEFT
   of the switch; pass `stateText={false}` to hide it. The optional `label` is
   the accessible name (visible, left of the state text), or use aria-label. */

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  /** Default ["On", "Off"]; false hides it. */
  stateText?: false | [ReactNode, ReactNode];
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  className?: string;
}

export function ToggleSwitch({ checked, onChange, label, stateText = ["On", "Off"], disabled, id, className, ...aria }: ToggleSwitchProps) {
  const labelId = useId();
  return (
    <label className={cx("ui-toggle", checked && "ui-toggle--on", disabled && "ui-toggle--disabled", className)}>
      {label && <span id={labelId} className="ui-toggle__label">{label}</span>}
      {stateText && <span className="ui-toggle__state" aria-hidden="true">{checked ? stateText[0] : stateText[1]}</span>}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"] ?? (label ? labelId : undefined)}
        aria-describedby={aria["aria-describedby"]}
        disabled={disabled}
        className="ui-toggle__track"
        onClick={() => onChange(!checked)}
      >
        <span className="ui-toggle__knob" />
      </button>
    </label>
  );
}

/* --- Checkbox --------------------------------------------------------------------- */

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "checked"> {
  checked: boolean;
  onChange: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void;
  indeterminate?: boolean;
  label?: ReactNode;
  /** A caption line under the label. */
  description?: ReactNode;
}

export function Checkbox({ checked, onChange, indeterminate = false, label, description, className, disabled, ...rest }: CheckboxProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate; }, [indeterminate]);
  const descriptionId = useId();
  return (
    <label className={cx("ui-check", disabled && "ui-check--disabled", className)}>
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : undefined}
        aria-describedby={description ? descriptionId : rest["aria-describedby"]}
        onChange={(event) => onChange(event.target.checked, event)}
        {...rest}
      />
      {(label || description) && (
        <span className="ui-check__text">
          {label && <span className="ui-check__label">{label}</span>}
          {description && <span id={descriptionId} className="ui-check__description">{description}</span>}
        </span>
      )}
    </label>
  );
}

/* --- RadioGroup / Radio ----------------------------------------------------------- */

interface RadioContextValue { name: string; value: string | undefined; onChange: (value: string) => void; disabled?: boolean }
const RadioContext = createContext<RadioContextValue | null>(null);

export interface RadioGroupProps<V extends string = string> {
  value: V | undefined;
  onChange: (value: V) => void;
  /** Visible group heading (becomes the accessible name). */
  label?: ReactNode;
  "aria-label"?: string;
  name?: string;
  /** Data form; or pass <Radio> children. */
  options?: { value: V; label: ReactNode; description?: ReactNode; disabled?: boolean }[];
  children?: ReactNode;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
  className?: string;
}

export function RadioGroup<V extends string = string>({ value, onChange, label, name, options, children, orientation = "vertical", disabled, className, ...aria }: RadioGroupProps<V>) {
  const autoName = useId();
  const labelId = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={label ? labelId : undefined}
      aria-label={aria["aria-label"]}
      aria-disabled={disabled || undefined}
      className={cx("ui-radio-group", `ui-radio-group--${orientation}`, className)}
    >
      {label && <span id={labelId} className="ui-radio-group__label">{label}</span>}
      <RadioContext.Provider value={{ name: name ?? autoName, value, onChange: onChange as (value: string) => void, disabled }}>
        <div className="ui-radio-group__items">
          {options?.map((option) => <Radio key={option.value} value={option.value} label={option.label} description={option.description} disabled={option.disabled} />)}
          {children}
        </div>
      </RadioContext.Provider>
    </div>
  );
}

export interface RadioProps {
  value: string;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function Radio({ value, label, description, disabled, className }: RadioProps) {
  const group = useContext(RadioContext);
  if (!group) throw new Error("<Radio> must be inside a <RadioGroup>");
  const off = disabled || group.disabled;
  return (
    <label className={cx("ui-check", off && "ui-check--disabled", className)}>
      <input type="radio" name={group.name} value={value} checked={group.value === value} disabled={off} onChange={() => group.onChange(value)} />
      <span className="ui-check__text">
        <span className="ui-check__label">{label}</span>
        {description && <span className="ui-check__description">{description}</span>}
      </span>
    </label>
  );
}

/* --- Slider -------------------------------------------------------------------------
   input[type=range] with `--p` set from value/min/max, so the track fills up
   to the thumb (controls.css). onChange gets a number. */

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "min" | "max" | "step"> {
  value: number;
  onChange: (value: number, event: ChangeEvent<HTMLInputElement>) => void;
  min?: number;
  max?: number;
  step?: number | "any";
}

export function sliderPercent(value: number, min: number, max: number) {
  if (!(max > min)) return "0%";
  return `${Math.round(Math.min(1, Math.max(0, (value - min) / (max - min))) * 10000) / 100}%`;
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, className, style, ...rest }: SliderProps) {
  return (
    <input
      type="range"
      className={cx("ui-slider", className)}
      value={value}
      min={min}
      max={max}
      step={step}
      style={{ ...style, "--p": sliderPercent(value, min, max) } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value), event)}
      {...rest}
    />
  );
}

/* --- ProgressBar / ProgressRing --------------------------------------------------- */

export interface ProgressBarProps {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  state?: "normal" | "paused" | "error";
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
}

export function ProgressBar({ value, state = "normal", className, ...aria }: ProgressBarProps) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(clamped) : undefined}
      aria-label={aria["aria-label"]}
      aria-labelledby={aria["aria-labelledby"]}
      data-state={state}
      className={cx("ui-progress", !determinate && "ui-progress--indeterminate", state !== "normal" && `ui-progress--${state}`, className)}
    >
      <span className="ui-progress__fill" style={determinate ? { width: `${clamped}%` } : undefined} />
    </div>
  );
}

export interface ProgressRingProps {
  /** 0–100. Omit for indeterminate. */
  value?: number;
  size?: 16 | 20 | 32;
  "aria-label"?: string;
  className?: string;
}

export function ProgressRing({ value, size = 16, className, ...aria }: ProgressRingProps) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const clamped = determinate ? Math.min(100, Math.max(0, value)) : 0;
  const stroke = size === 32 ? 3 : 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span
      role="progressbar"
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(clamped) : undefined}
      aria-label={aria["aria-label"]}
      className={cx("ui-ring", !determinate && "ui-ring--indeterminate", className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        {determinate && <circle className="ui-ring__track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={stroke} fill="none" />}
        <circle
          className="ui-ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={determinate ? `${(clamped / 100) * circumference} ${circumference}` : `${circumference * 0.3} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </span>
  );
}

/* --- InfoBadge ---------------------------------------------------------------------
   A 16px pill with a number, or an 8px dot without one. */

export interface InfoBadgeProps {
  value?: number;
  severity?: "attention" | "informational" | "success" | "caution" | "critical";
  /** Numbers above this show as "max+" (default 99). */
  max?: number;
  "aria-label"?: string;
  className?: string;
}

export function InfoBadge({ value, severity = "attention", max = 99, className, ...aria }: InfoBadgeProps) {
  const dot = value === undefined;
  return (
    <span
      className={cx("ui-badge", `ui-badge--${severity}`, dot && "ui-badge--dot", className)}
      role={aria["aria-label"] ? "status" : undefined}
      aria-label={aria["aria-label"]}
      aria-hidden={aria["aria-label"] ? undefined : true}
    >
      {!dot && (value! > max ? `${max}+` : value)}
    </span>
  );
}

/* --- Expander ------------------------------------------------------------------------
   The generic WinUI Expander: a 48px header button with a rotating chevron
   and a content area with its own darker layer. */

export interface ExpanderProps {
  header: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  id?: string;
}

export function Expander({ header, description, icon, children, expanded, defaultExpanded, onExpandedChange, className, id }: ExpanderProps) {
  const [isOpen, toggle] = useDisclosure(expanded, defaultExpanded, onExpandedChange);
  const contentId = useId();
  return (
    <div id={id} className={cx("ui-expander", isOpen && "ui-expander--open", className)}>
      <button type="button" className="ui-expander__header" aria-expanded={isOpen} aria-controls={contentId} onClick={toggle}>
        {icon && <span className="ui-expander__icon" aria-hidden="true">{icon}</span>}
        <span className="ui-expander__text">
          <span className="ui-expander__title">{header}</span>
          {description && <span className="ui-expander__description">{description}</span>}
        </span>
        <ChevronDown size={16} aria-hidden="true" className="ui-expander__chevron" />
      </button>
      <div id={contentId} className="ui-expander__content" hidden={!isOpen}>{children}</div>
    </div>
  );
}

/* --- SelectorBar -----------------------------------------------------------------------
   Text tabs with a 3×16px accent pill under the selected one. role=tablist,
   arrow keys / Home / End move and select (automatic activation). */

export interface SelectorBarItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  /** Id of the tabpanel this tab controls. */
  controls?: string;
}

export interface SelectorBarProps<V extends string = string> {
  items: SelectorBarItem<V>[];
  value: V;
  onChange: (value: V) => void;
  "aria-label"?: string;
  className?: string;
}

export function SelectorBar<V extends string = string>({ items, value, onChange, className, ...aria }: SelectorBarProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = items.map((item, index) => (item.disabled ? -1 : index)).filter((index) => index >= 0);
    const at = enabled.indexOf(items.findIndex((item) => item.value === value));
    let next: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = enabled[(at + 1) % enabled.length];
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={aria["aria-label"]} className={cx("ui-selector-bar", className)} onKeyDown={onKeyDown}>
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(element) => { refs.current[index] = element; }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={item.controls}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx("ui-selector-bar__item", selected && "ui-selector-bar__item--selected")}
            onClick={() => onChange(item.value)}
          >
            {item.icon && <span className="ui-selector-bar__icon" aria-hidden="true">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

