import { ChevronRight, Ellipsis, FolderOpen, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DEFAULT_CLIP_CHROMA_KEY, DEFAULT_CLIP_LOOK, type TimelineClip } from "../../lib/project";
import { parseCube } from "../../lib/effectSettings";
import { readLutFile } from "../../lib/exportPipeline";
import { inTauri, pickFile } from "../../lib/nativeShell";
import { ComboBox, Flyout, PropRow, Slider, tooltipProps, useContextMenu } from "../ui";
import { ColorSwatch } from "./ColorPicker";

type EffectId = "look" | "transition" | "chromaKey" | "sharpen" | "blur" | "colorCorrection" | "vignette" | "lut";
type EditorProps = { clip: TimelineClip; update: (patch: Partial<TimelineClip>) => void; disabled: boolean };
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
      ><FolderOpen size={14} aria-hidden="true" /> Browse…</button>
    </PropRow>
    {loading && <p className="clip-effect__note" role="status">Reading LUT…</p>}
    {lut.table && <p className="clip-effect__note">{lut.table.name} · {lut.table.size}³</p>}
    {error && <p className="clip-effect__note clip-effect__note--error" role="alert">{error}</p>}
    <Param label="Intensity" ariaLabel="LUT intensity" value={lut.intensity} defaultValue={100} disabled={disabled} onChange={(intensity) => update({ lut: { ...lut, intensity } })} />
  </>;
}

// One catalogue drives the picker, defaults and editors. Missing settings mean
// the effect is absent; older projects with Look/Transition keep their edits.
const EFFECTS: readonly EffectDefinition[] = [
  {
    id: "look", name: "Look", description: "Opacity and colour temperature",
    defaults: { look: DEFAULT_CLIP_LOOK },
    editor: ({ clip, update, disabled }) => {
      const look = clip.look!;
      return <>
        <Param label="Opacity" ariaLabel="Clip opacity" value={look.opacity} defaultValue={DEFAULT_CLIP_LOOK.opacity} disabled={disabled} onChange={(opacity) => update({ look: { ...look, opacity } })} />
        <Param label="Temperature" ariaLabel="Clip temperature" value={look.temperature} min={-100} max={100} defaultValue={DEFAULT_CLIP_LOOK.temperature} disabled={disabled}
          format={(value) => `${value > 0 ? "+" : ""}${value}`} onChange={(temperature) => update({ look: { ...look, temperature } })} />
      </>;
    },
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
    editor: ({ clip, update, disabled }) => <Param label="Amount" ariaLabel="Sharpen amount" value={clip.sharpen!.amount} max={200} defaultValue={50} disabled={disabled} onChange={(amount) => update({ sharpen: { amount } })} />,
  },
  {
    id: "blur", name: "Gaussian blur", description: "Soften the picture with a Gaussian blur",
    defaults: { blur: { radius: 4 } },
    editor: ({ clip, update, disabled }) => <Param label="Radius" ariaLabel="Blur radius" value={clip.blur!.radius} max={24} step={0.5} suffix=" px" defaultValue={4} disabled={disabled} onChange={(radius) => update({ blur: { radius } })} />,
  },
  {
    id: "colorCorrection", name: "Colour correction", description: "Adjust exposure, contrast and saturation",
    defaults: { colorCorrection: { exposure: 0, contrast: 0, saturation: 100 } },
    editor: ({ clip, update, disabled }) => {
      const color = clip.colorCorrection!;
      return <>
        <Param label="Exposure" value={color.exposure} min={-4} max={4} step={0.1} suffix=" stops" defaultValue={0} disabled={disabled} onChange={(exposure) => update({ colorCorrection: { ...color, exposure } })} />
        <Param label="Contrast" value={color.contrast} min={-100} defaultValue={0} disabled={disabled} onChange={(contrast) => update({ colorCorrection: { ...color, contrast } })} />
        <Param label="Saturation" value={color.saturation} max={200} defaultValue={100} disabled={disabled} onChange={(saturation) => update({ colorCorrection: { ...color, saturation } })} />
      </>;
    },
  },
  {
    id: "vignette", name: "Vignette", description: "Darken the edges of the picture",
    defaults: { vignette: { amount: 35 } },
    editor: ({ clip, update, disabled }) => <Param label="Amount" ariaLabel="Vignette amount" value={clip.vignette!.amount} defaultValue={35} disabled={disabled} onChange={(amount) => update({ vignette: { amount } })} />,
  },
  {
    id: "lut", name: "3D LUT", description: "Apply a colour look from a .cube file",
    defaults: { lut: { intensity: 100 } },
    reset: (clip) => ({ lut: { ...clip.lut!, intensity: 100 } }),
    editor: (props) => <LutEditor key={props.clip.id} {...props} />,
  },
];

/* Each effect is an Expander-style block with a 32px header — chevron and
   name, Reset, and a ⋯ menu — the way Premiere's Effect Controls and
   Clipchamp's effect panel stack them. There is no per-effect bypass: effect
   settings carry no "enabled" flag in the project schema yet. */
function EffectBlock({ effect, clip, disabled, update, onRemove }: {
  effect: EffectDefinition; clip: TimelineClip; disabled: boolean;
  update: (patch: Partial<TimelineClip>) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useContextMenu();
  const reset = () => update(effect.reset?.(clip) ?? effect.defaults);
  return <section className={`clip-effect${open ? " clip-effect--open" : ""}`} aria-label={`${effect.name} effect`}>
    <header className="clip-effect__header">
      <button type="button" className="clip-effect__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={12} aria-hidden="true" className="clip-effect__chevron" />
        <h3 className="clip-effect__name">{effect.name}</h3>
      </button>
      <button type="button" className="clip-effect__action" aria-label={`Reset ${effect.name}`} {...tooltipProps("Reset")} disabled={disabled} onClick={reset}>
        <RotateCcw size={14} aria-hidden="true" />
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
          { label: "Reset", icon: <RotateCcw size={16} />, onSelect: reset },
          { separator: true },
          { label: "Remove", shortcut: "Delete", danger: true, onSelect: onRemove },
        ], { "aria-label": `${effect.name} options`, placement: "bottom-end", focusFirst: true })}
      ><Ellipsis size={14} aria-hidden="true" /></button>
    </header>
    {open && <fieldset className="clip-effect__body" disabled={disabled}>{effect.editor({ clip, update, disabled })}</fieldset>}
    {menu.element}
  </section>;
}

export function ClipEffects({ clip, disabled, onChange }: {
  clip: TimelineClip;
  disabled: boolean;
  onChange: (patch: Partial<TimelineClip>) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const available = EFFECTS.filter((effect) => !clip[effect.id]);
  const update = (patch: Partial<TimelineClip>) => { if (!disabled) onChange(patch); };
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
    ><Plus size={16} aria-hidden="true" /> Add effect</button>
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
