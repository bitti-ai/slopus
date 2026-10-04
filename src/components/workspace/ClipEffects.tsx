import { Add16, ChevronDown12, Copy16, FolderOpen14, More14, Paste16, Reset14, Reset16 } from "../ui/icons";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DEFAULT_CLIP_CHROMA_KEY, DEFAULT_CLIP_LOOK, type TimelineClip } from "../../lib/project";
import { CREATIVE_LOOKS, DEFAULT_CREATIVE, DEFAULT_WHEELS, isEffectOn, parseCube } from "../../lib/effectSettings";
import { readLutFile } from "../../lib/exportPipeline";
import { inTauri, pickFile } from "../../lib/nativeShell";
import { Checkbox, ComboBox, Flyout, PropRow, Slider, tooltipProps, useContextMenu } from "../ui";
import { CurveEditor } from "./CurveEditor";
import { GradingWheel } from "./GradingWheel";
import { ColorSwatch } from "./ColorPicker";

type EffectId = "look" | "transition" | "chromaKey" | "sharpen" | "blur" | "colorCorrection" | "vignette" | "lut" | "creative" | "curves" | "colorWheels";
// Keep copied settings across clip selections and inspector remounts, like the
// image-node clipboard. Snapshots include bypass and embedded LUT data.
let effectClipboard: { id: EffectId; settings: NonNullable<TimelineClip[EffectId]> } | null = null;
/** `key` names a run of edits to one parameter (a slider drag), so the
 *  project's undo stack folds it into one step. */
type Update = (patch: Partial<TimelineClip>, key?: string) => void;
type EditorProps = { clip: TimelineClip; update: Update; disabled: boolean };
type EffectDefinition = {
  id: EffectId;
  name: string;
  description: string;
  defaults: Partial<TimelineClip>;
  /** What Reset writes. Defaults to `defaults`; the LUT keeps its table. */
  reset?: (clip: TimelineClip) => Partial<TimelineClip>;
  editor: (props: EditorProps) => ReactNode;
};

/** One numeric parameter as an inspector row: the label scrubs, the slider
 *  drags, the value reads in tabular figures, and Reset appears once it moves
 *  off its default. */
function Param({ label, value, min = 0, max = 100, step = 1, suffix = "%", defaultValue, ariaLabel, disabled, format, onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; suffix?: string; defaultValue: number;
  ariaLabel?: string; disabled?: boolean; format?: (value: number) => string; onChange: (value: number) => void;
}) {
  return <PropRow
    label={label}
    value={value}
    defaultValue={defaultValue}
    onReset={disabled ? undefined : () => onChange(defaultValue)}
    resetLabel={`Reset ${label.toLowerCase()}`}
    scrub={disabled ? undefined : { value, onChange, step, min, max }}
  >
    <Slider aria-label={ariaLabel ?? label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(next) => onChange(next)} />
    <span className="clip-effect__value">{format ? format(value) : `${value}${suffix}`}</span>
  </PropRow>;
}

function LutEditor({ clip, update, disabled }: EditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef({ clip, update });
  latest.current = { clip, update };
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const lut = clip.lut!;
  /* The native Open dialog, filtered to .cube files, then Rust reads the text
     (the webview cannot open a path itself). Parsing stays here. A clip that
     changes while the file is being read keeps its own LUT. */
  const browse = async () => {
    const token = ++request.current;
    setError(null);
    try {
      const path = await pickFile({ title: "Import LUT", filters: [{ name: "Cube LUT", extensions: ["cube"] }] });
      if (!path || request.current !== token) return;
      setLoading(true);
      const name = path.split(/[\\/]/).pop() ?? path;
      const table = parseCube(await readLutFile(path), name);
      if (request.current === token) latest.current.update({ lut: { ...latest.current.clip.lut!, table } });
    } catch (reason) {
      if (request.current === token) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === token) setLoading(false);
    }
  };
  return <>
    <PropRow label="File">
      <span className="clip-effect__file" {...tooltipProps(lut.table ? `${lut.table.name} · ${lut.table.size}³` : "3D .cube LUT, 2–65 points. Saved with the project.")}>
        {loading ? "Reading…" : lut.table ? lut.table.name : "None"}
      </span>
      <button
        type="button"
        className="secondary-button clip-effect__browse"
        disabled={disabled || loading || !inTauri()}
        aria-label={lut.table ? "Replace LUT" : "Import LUT"}
        {...tooltipProps(inTauri() ? "Choose a .cube file" : "Available in the desktop app")}
        onClick={() => void browse()}
      ><FolderOpen14 aria-hidden="true" /> Browse…</button>
    </PropRow>
    {loading && <p className="clip-effect__note" role="status">Reading LUT…</p>}
    {lut.table && <p className="clip-effect__note">{lut.table.name} · {lut.table.size}³</p>}
    {error && <p className="clip-effect__note clip-effect__note--error" role="alert">{error}</p>}
    <Param label="Intensity" ariaLabel="LUT intensity" value={lut.intensity} defaultValue={100} disabled={disabled} onChange={(intensity) => update({ lut: { ...lut, intensity } })} />
  </>;
}

// One catalogue drives the picker, defaults and editors. Missing settings mean
// the effect is absent; opacity retains the legacy `look` project key.
const EFFECTS: readonly EffectDefinition[] = [
  {
    id: "look", name: "Opacity", description: "Control clip transparency",
    defaults: { look: DEFAULT_CLIP_LOOK },
    editor: ({ clip, update, disabled }) => <Param label="Opacity" ariaLabel="Clip opacity" value={clip.look!.opacity} defaultValue={DEFAULT_CLIP_LOOK.opacity} disabled={disabled} onChange={(opacity) => update({ look: { ...clip.look!, opacity } })} />,
  },
  {
    id: "transition", name: "Transition", description: "Fade or wipe into the clip",
    defaults: { transition: { type: "fade", durationMs: 500 } },
    editor: ({ clip, update, disabled }) => {
      const transition = clip.transition!;
      return <>
        <PropRow label="Type">
          <ComboBox aria-label="Clip transition" value={transition.type} disabled={disabled}
            onChange={(type) => update({ transition: { ...transition, type: type as typeof transition.type } })}
            options={[
              { value: "cut", label: "Cut" }, { value: "fade", label: "Fade in" },
              { value: "wipe-left", label: "Wipe from left" }, { value: "wipe-right", label: "Wipe from right" },
            ]} />
        </PropRow>
        <Param label="Duration" ariaLabel="Transition duration" value={transition.durationMs} min={100} max={3000} step={100} suffix=" ms" defaultValue={500}
          disabled={disabled || transition.type === "cut"} onChange={(durationMs) => update({ transition: { ...transition, durationMs } })} />
      </>;
    },
  },
  {
    id: "chromaKey", name: "Chroma key", description: "Make a selected colour transparent",
    defaults: { chromaKey: DEFAULT_CLIP_CHROMA_KEY },
    editor: ({ clip, update, disabled }) => {
      const key = clip.chromaKey!;
      return <>
        <PropRow label="Colour" value={key.color.toLowerCase()} defaultValue={DEFAULT_CLIP_CHROMA_KEY.color.toLowerCase()}
          onReset={disabled ? undefined : () => update({ chromaKey: { ...key, color: DEFAULT_CLIP_CHROMA_KEY.color } })} resetLabel="Reset colour">
          <ColorSwatch label="Chroma key colour" value={key.color} disabled={disabled} onChange={(color) => update({ chromaKey: { ...key, color } })} />
          <code className="clip-effect__value">{key.color.toUpperCase()}</code>
        </PropRow>
        <Param label="Tolerance" ariaLabel="Chroma key tolerance" value={key.tolerance} defaultValue={DEFAULT_CLIP_CHROMA_KEY.tolerance} disabled={disabled} onChange={(tolerance) => update({ chromaKey: { ...key, tolerance } })} />
      </>;
    },
  },
  {
    id: "sharpen", name: "Sharpen", description: "Enhance fine edges and detail",
    defaults: { sharpen: { amount: 50 } },
    editor: ({ clip, update, disabled }) => <Param label="Amount" ariaLabel="Sharpen amount" value={clip.sharpen!.amount} max={200} defaultValue={50} disabled={disabled} onChange={(amount) => update({ sharpen: { ...clip.sharpen!, amount } })} />,
  },
  {
    id: "blur", name: "Gaussian blur", description: "Soften the picture with a Gaussian blur",
    defaults: { blur: { radius: 4 } },
    editor: ({ clip, update, disabled }) => <Param label="Radius" ariaLabel="Blur radius" value={clip.blur!.radius} max={24} step={0.5} suffix=" px" defaultValue={4} disabled={disabled} onChange={(radius) => update({ blur: { ...clip.blur!, radius } })} />,
  },
  {
    id: "colorCorrection", name: "Basic Corrections", description: "White balance, exposure, tonal ranges and saturation",
    defaults: { colorCorrection: { exposure: 0, brightness: 0, contrast: 0, saturation: 100 } },
    editor: ({ clip, update, disabled }) => {
      const color = clip.colorCorrection!;
      return <>
        {(["temperature", "tint"] as const).map((key) => <Param key={key} label={key[0].toUpperCase() + key.slice(1)} value={color[key] ?? 0} min={-100} defaultValue={0} disabled={disabled} onChange={(value) => update({ colorCorrection: { ...color, [key]: value } })} />) }
        <Param label="Exposure" value={color.exposure} min={-4} max={4} step={0.1} suffix=" stops" defaultValue={0} disabled={disabled} onChange={(exposure) => update({ colorCorrection: { ...color, exposure } })} />
        <Param label="Brightness" value={color.brightness ?? 0} min={-100} defaultValue={0} disabled={disabled} onChange={(brightness) => update({ colorCorrection: { ...color, brightness } })} />
        <Param label="Contrast" value={color.contrast} min={-100} defaultValue={0} disabled={disabled} onChange={(contrast) => update({ colorCorrection: { ...color, contrast } })} />
        {(["highlights", "shadows", "whites", "blacks"] as const).map((key) => <Param key={key} label={key[0].toUpperCase() + key.slice(1)} value={color[key] ?? 0} min={-100} defaultValue={0} disabled={disabled} onChange={(value) => update({ colorCorrection: { ...color, [key]: value } })} />)}
        <Param label="Saturation" value={color.saturation} max={200} defaultValue={100} disabled={disabled} onChange={(saturation) => update({ colorCorrection: { ...color, saturation } })} />
      </>;
    },
  },
  {
    id: "creative", name: "Creative", description: "Eight built-in looks, faded film, sharpening and vibrance",
    defaults: { creative: DEFAULT_CREATIVE },
    editor: ({ clip, update, disabled }) => {
      const creative = clip.creative!;
      return <>
        <PropRow label="Look"><ComboBox aria-label="Creative look" value={creative.look} disabled={disabled} options={CREATIVE_LOOKS.map((look) => ({ value: look, label: look }))}
          onChange={(look) => update({ creative: { ...creative, look } })} /></PropRow>
        <Param label="Intensity" ariaLabel="Creative intensity" value={creative.intensity} defaultValue={100} disabled={disabled} onChange={(intensity) => update({ creative: { ...creative, intensity } })} />
        <Param label="Faded film" value={creative.fadedFilm} defaultValue={0} disabled={disabled} onChange={(fadedFilm) => update({ creative: { ...creative, fadedFilm } })} />
        <Param label="Sharpen" ariaLabel="Creative sharpen" value={creative.sharpen} max={200} defaultValue={0} disabled={disabled} onChange={(sharpen) => update({ creative: { ...creative, sharpen } })} />
        <Param label="Vibrance" value={creative.vibrance} min={-100} defaultValue={0} disabled={disabled} onChange={(vibrance) => update({ creative: { ...creative, vibrance } })} />
      </>;
    },
  },
  {
    id: "curves", name: "Curves", description: "RGB and hue, saturation and luma curves",
    defaults: { curves: {} },
    editor: ({ clip, update, disabled }) => <CurveEditor key={clip.id} value={clip.curves!} disabled={disabled} onChange={(curves) => update({ curves })} />,
  },
  {
    id: "colorWheels", name: "Color Wheels", description: "Tint and lightness for shadows, midtones and highlights",
    defaults: { colorWheels: DEFAULT_WHEELS },
    editor: ({ clip, update, disabled }) => {
      const wheels = clip.colorWheels!;
      return <>{(["shadows", "midtones", "highlights"] as const).map((key) => {
        const label = key[0].toUpperCase() + key.slice(1), wheel = wheels[key];
        return <div className="grading-wheel-section" key={key}>
          <div className="grading-wheel-section__heading"><span>{label}</span><button type="button" className="clip-effect__action" aria-label={`Reset ${label} wheel`} disabled={disabled}
            onClick={() => update({ colorWheels: { ...wheels, [key]: { x: 0, y: 0, lightness: 0 } } })}><Reset14 /></button></div>
          <GradingWheel label={label} x={wheel.x} y={wheel.y} disabled={disabled} onChange={(x, y) => update({ colorWheels: { ...wheels, [key]: { ...wheel, x, y } } })} />
          <Param label="Lightness" ariaLabel={`${label} lightness`} value={wheel.lightness} min={-100} defaultValue={0} disabled={disabled} onChange={(lightness) => update({ colorWheels: { ...wheels, [key]: { ...wheel, lightness } } })} />
        </div>;
      })}</>;
    },
  },
  {
    id: "vignette", name: "Vignette", description: "Shape and soften dark or light edges",
    defaults: { vignette: { amount: 35 } },
    editor: ({ clip, update, disabled }) => {
      const vignette = clip.vignette!;
      return <>
        <Param label="Amount" ariaLabel="Vignette amount" value={vignette.amount} min={-100} defaultValue={35} disabled={disabled} onChange={(amount) => update({ vignette: { ...vignette, amount } })} />
        <Param label="Midpoint" ariaLabel="Vignette midpoint" value={vignette.midpoint ?? 50} defaultValue={50} disabled={disabled} onChange={(midpoint) => update({ vignette: { ...vignette, midpoint } })} />
        <Param label="Roundness" ariaLabel="Vignette roundness" value={vignette.roundness ?? 0} min={-100} defaultValue={0} disabled={disabled} onChange={(roundness) => update({ vignette: { ...vignette, roundness } })} />
        <Param label="Feather" ariaLabel="Vignette feather" value={vignette.feather ?? 100} defaultValue={100} disabled={disabled} onChange={(feather) => update({ vignette: { ...vignette, feather } })} />
      </>;
    },
  },
  {
    id: "lut", name: "3D LUT", description: "Apply a colour look from a .cube file",
    defaults: { lut: { intensity: 100 } },
    reset: (clip) => ({ lut: { ...clip.lut!, intensity: 100 } }),
    editor: (props) => <LutEditor key={props.clip.id} {...props} />,
  },
];

/** How many effects a clip carries, and how many of them are switched on —
 *  the inspector's section summary and the fx badge on the timeline clip. */
export function clipEffectCount(clip: TimelineClip): { total: number; on: number } {
  let total = 0;
  let on = 0;
  for (const effect of EFFECTS) {
    const settings = clip[effect.id] as { enabled?: boolean | null } | null | undefined;
    if (!settings) continue;
    total += 1;
    if (isEffectOn(settings)) on += 1;
  }
  return { total, on };
}

/* Each effect is an Expander-style block with a 32px header — the bypass
   checkbox, chevron and name, Reset, and a ⋯ menu — the way Premiere's
   Effect Controls and Clipchamp's effect panel stack them. Unticking the
   checkbox writes `enabled: false` into the effect's settings: the monitor
   and the export render without it, and its values stay for when it is
   ticked again (which removes the flag, so the file keeps its old shape). */
function EffectBlock({ effect, clip, disabled, update, onRemove }: {
  effect: EffectDefinition; clip: TimelineClip; disabled: boolean;
  update: Update; onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const more = useRef<HTMLButtonElement>(null);
  /* Every parameter edit of this effect shares one undo key, so a slider drag
     is one step rather than sixty. */
  const keyed: Update = (patch, key) => update(patch, key ?? effect.id);
  const menu = useContextMenu();
  useEffect(() => menu.close(), [clip.id, disabled, menu.close]);
  const settings = clip[effect.id] as { enabled?: boolean | null } | null | undefined;
  const on = isEffectOn(settings);
  /* Reset puts the values back, not the bypass: a switched-off effect stays off. */
  const reset = () => {
    const patch = effect.reset?.(clip) ?? effect.defaults;
    const values = patch[effect.id] as object | undefined;
    update(on || !values ? patch : { [effect.id]: { ...values, enabled: false } });
  };
  const bypass = (next: boolean) => update({ [effect.id]: { ...settings, enabled: next ? undefined : false } });
  return <section className={`clip-effect${open ? " clip-effect--open" : ""}${on ? "" : " clip-effect--bypassed"}`} aria-label={`${effect.name} effect`}>
    <header className="clip-effect__header">
      <Checkbox className="clip-effect__bypass" checked={on} disabled={disabled} aria-label={`${effect.name} on`}
        {...tooltipProps(on ? "Turn off (bypass)" : "Turn on")} onChange={bypass} />
      <button type="button" className="clip-effect__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronDown12 aria-hidden="true" className="clip-effect__chevron" />
        <h3 className="clip-effect__name">{effect.name}</h3>
      </button>
      <button type="button" className="clip-effect__action" aria-label={`Reset ${effect.name}`} {...tooltipProps("Reset")} disabled={disabled} onClick={reset}>
        <Reset14 aria-hidden="true" />
      </button>
      <button
        ref={more}
        type="button"
        className="clip-effect__action"
        aria-label={`${effect.name} options`}
        aria-haspopup="menu"
        {...tooltipProps("More options")}
        disabled={disabled}
        onClick={() => more.current && menu.open(more.current, [
          { label: "Copy settings", icon: <Copy16 />, onSelect: () => {
            const values = clip[effect.id];
            if (values) effectClipboard = { id: effect.id, settings: structuredClone(values) };
          } },
          { label: "Paste settings", icon: <Paste16 />, disabled: effectClipboard?.id !== effect.id, onSelect: () => {
            if (effectClipboard?.id === effect.id) update({ [effect.id]: structuredClone(effectClipboard.settings) });
          } },
          { separator: true },
          { label: "Reset", icon: <Reset16 />, onSelect: reset },
          { separator: true },
          { label: "Remove", shortcut: "Delete", danger: true, onSelect: onRemove },
        ], { "aria-label": `${effect.name} options`, placement: "bottom-end", focusFirst: true })}
      ><More14 aria-hidden="true" /></button>
    </header>
    {open && <fieldset className="clip-effect__body" disabled={disabled}>{effect.editor({ clip, update: keyed, disabled })}</fieldset>}
    {menu.element}
  </section>;
}

export function ClipEffects({ clip, disabled, onChange }: {
  clip: TimelineClip;
  disabled: boolean;
  onChange: (patch: Partial<TimelineClip>, key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const available = EFFECTS.filter((effect) => !clip[effect.id]).sort((a, b) => a.name.localeCompare(b.name));
  const update: Update = (patch, key) => { if (!disabled) onChange(patch, key); };
  useEffect(() => setOpen(false), [clip.id, disabled]);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  return <div className="clip-effects">
    {EFFECTS.filter((effect) => clip[effect.id]).map((effect) => <EffectBlock
      key={effect.id}
      effect={effect}
      clip={clip}
      disabled={disabled}
      update={update}
      onRemove={() => update({ [effect.id]: undefined })}
    />)}
    <button
      ref={trigger}
      type="button"
      className="secondary-button clip-effects__add"
      disabled={disabled || available.length === 0}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    ><Add16 aria-hidden="true" /> Add effect</button>
    <Flyout open={open} anchor={trigger} onClose={() => setOpen(false)} aria-label="Available effects" role="group" placement="top" width={220}>
      <div ref={list} className="clip-effects__picker" onKeyDown={moveFocus}>
        {available.map((effect) => <button
          type="button"
          key={effect.id}
          className="clip-effects__item"
          {...tooltipProps(effect.description)}
          onClick={() => { update(effect.defaults); setOpen(false); trigger.current?.focus(); }}
        >{effect.name}</button>)}
      </div>
    </Flyout>
  </div>;
}
