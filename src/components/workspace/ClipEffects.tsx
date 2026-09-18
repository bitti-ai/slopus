import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_CLIP_CHROMA_KEY, DEFAULT_CLIP_LOOK, type TimelineClip } from "../../lib/project";
import { MAX_LUT_FILE_BYTES, parseCube } from "../../lib/effectSettings";

type EffectId = "look" | "transition" | "chromaKey" | "sharpen" | "blur" | "colorCorrection" | "vignette" | "lut";
type EditorProps = { clip: TimelineClip; update: (patch: Partial<TimelineClip>) => void };
type EffectDefinition = {
  id: EffectId;
  name: string;
  description: string;
  defaults: Partial<TimelineClip>;
  editor: (props: EditorProps) => ReactNode;
};

function Slider({ label, value, min = 0, max = 100, step = 1, suffix = "%", onChange }: {
  label: string; value: number; min?: number; max?: number; step?: number; suffix?: string; onChange: (value: number) => void;
}) {
  return <label className="range-field"><span>{label} <b>{value}{suffix}</b></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function LutEditor(props: EditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const lut = props.clip.lut!;
  return <>
    <label><span>{lut.table ? "Replace LUT" : "Import LUT"}</span><input aria-label="Import cube LUT" type="file" accept=".cube" onChange={async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const token = ++request.current;
      setError(null); setLoading(true);
      try {
        if (!file.name.toLowerCase().endsWith(".cube")) throw new Error("Choose a 3D .cube LUT file.");
        if (file.size > MAX_LUT_FILE_BYTES) throw new Error("LUT files must be smaller than 16 MB.");
        const table = parseCube(await file.text(), file.name);
        if (request.current === token) latest.current.update({ lut: { ...latest.current.clip.lut!, table } });
      } catch (reason) {
        if (request.current === token) setError(reason instanceof Error ? reason.message : String(reason));
      } finally { if (request.current === token) setLoading(false); }
    }} /></label>
    {loading && <p role="status">Reading LUT…</p>}
    {lut.table ? <p>{lut.table.name} · {lut.table.size}³</p> : <p>Import a 3D .cube LUT (2–65 points). The LUT is saved with the project.</p>}
    {error && <p role="alert">{error}</p>}
    <Slider label="LUT intensity" value={lut.intensity} onChange={(intensity) => props.update({ lut: { ...lut, intensity } })} />
  </>;
}

// One catalogue drives the picker, defaults and editors. Missing settings mean
// the effect is absent; older projects with Look/Transition keep their edits.
const EFFECTS: readonly EffectDefinition[] = [
  {
    id: "look", name: "Look", description: "Opacity and color temperature",
    defaults: { look: DEFAULT_CLIP_LOOK },
    editor: ({ clip, update }) => {
      const look = clip.look!;
      return <>
        <label className="range-field"><span>Opacity <b>{look.opacity}%</b></span><input aria-label="Clip opacity" type="range" min="0" max="100" step="1" value={look.opacity} onChange={(event) => update({ look: { ...look, opacity: Number(event.target.value) } })} /></label>
        <label className="range-field"><span>Temperature <b>{look.temperature > 0 ? "+" : ""}{look.temperature}</b></span><input aria-label="Clip temperature" type="range" min="-100" max="100" step="1" value={look.temperature} onChange={(event) => update({ look: { ...look, temperature: Number(event.target.value) } })} /></label>
      </>;
    },
  },
  {
    id: "transition", name: "Transition", description: "Fade or wipe into the clip",
    defaults: { transition: { type: "fade", durationMs: 500 } },
    editor: ({ clip, update }) => {
      const transition = clip.transition!;
      return <>
        <label><span>When this clip begins</span><select aria-label="Clip transition" value={transition.type} onChange={(event) => update({ transition: { ...transition, type: event.target.value as typeof transition.type } })}>
          <option value="cut">Cut</option><option value="fade">Fade in</option><option value="wipe-left">Wipe from left</option><option value="wipe-right">Wipe from right</option>
        </select></label>
        <label className="range-field"><span>Duration <b>{transition.durationMs} ms</b></span><input aria-label="Transition duration" type="range" min="100" max="3000" step="100" value={transition.durationMs} disabled={transition.type === "cut"} onChange={(event) => update({ transition: { ...transition, durationMs: Number(event.target.value) } })} /></label>
      </>;
    },
  },
  {
    id: "chromaKey", name: "Chroma Key", description: "Make a selected color transparent",
    defaults: { chromaKey: DEFAULT_CLIP_CHROMA_KEY },
    editor: ({ clip, update }) => {
      const key = clip.chromaKey!;
      return <>
        <label className="effect-color"><span>Color</span><input aria-label="Chroma Key color" type="color" value={key.color} onChange={(event) => update({ chromaKey: { ...key, color: event.target.value } })} /><code>{key.color.toUpperCase()}</code></label>
        <label className="range-field"><span>Tolerance <b>{key.tolerance}%</b></span><input aria-label="Chroma Key tolerance" type="range" min="0" max="100" step="1" value={key.tolerance} onChange={(event) => update({ chromaKey: { ...key, tolerance: Number(event.target.value) } })} /></label>
      </>;
    },
  },
  {
    id: "sharpen", name: "Sharpen", description: "Enhance fine edges and detail",
    defaults: { sharpen: { amount: 50 } },
    editor: ({ clip, update }) => <Slider label="Sharpen amount" value={clip.sharpen!.amount} max={200} onChange={(amount) => update({ sharpen: { amount } })} />,
  },
  {
    id: "blur", name: "Gaussian Blur", description: "Soften the picture with a Gaussian blur",
    defaults: { blur: { radius: 4 } },
    editor: ({ clip, update }) => <Slider label="Blur radius" value={clip.blur!.radius} max={24} step={0.5} suffix=" px" onChange={(radius) => update({ blur: { radius } })} />,
  },
  {
    id: "colorCorrection", name: "Color Correction", description: "Adjust exposure, contrast, and saturation",
    defaults: { colorCorrection: { exposure: 0, contrast: 0, saturation: 100 } },
    editor: ({ clip, update }) => {
      const color = clip.colorCorrection!;
      return <>
        <Slider label="Exposure" value={color.exposure} min={-4} max={4} step={0.1} suffix=" stops" onChange={(exposure) => update({ colorCorrection: { ...color, exposure } })} />
        <Slider label="Contrast" value={color.contrast} min={-100} onChange={(contrast) => update({ colorCorrection: { ...color, contrast } })} />
        <Slider label="Saturation" value={color.saturation} max={200} onChange={(saturation) => update({ colorCorrection: { ...color, saturation } })} />
      </>;
    },
  },
  {
    id: "vignette", name: "Vignette", description: "Darken the edges of the picture",
    defaults: { vignette: { amount: 35 } },
    editor: ({ clip, update }) => <Slider label="Vignette amount" value={clip.vignette!.amount} onChange={(amount) => update({ vignette: { amount } })} />,
  },
  {
    id: "lut", name: "3D LUT", description: "Apply a color look from a .cube file",
    defaults: { lut: { intensity: 100 } },
    editor: (props) => <LutEditor key={props.clip.id} {...props} />,
  },
];

export function ClipEffects({ clip, disabled, onChange }: {
  clip: TimelineClip;
  disabled: boolean;
  onChange: (patch: Partial<TimelineClip>) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pickerId = useId();
  const available = EFFECTS.filter((effect) => !clip[effect.id]);
  const update = (patch: Partial<TimelineClip>) => { if (!disabled) onChange(patch); };
  useEffect(() => setOpen(false), [clip.id, disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    root.current?.querySelector<HTMLButtonElement>(".clip-effects__picker button")?.focus();
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  return <>
    {EFFECTS.filter((effect) => clip[effect.id]).map((effect) => <section className="inspector-section clip-effect" key={effect.id} aria-label={`${effect.name} effect`}>
      <header><h3>{effect.name}</h3><button type="button" className="clip-effect__remove" aria-label={`Remove ${effect.name} effect`} disabled={disabled} onClick={() => update({ [effect.id]: undefined })}><X size={14} /></button></header>
      <fieldset disabled={disabled}>{effect.editor({ clip, update })}</fieldset>
    </section>)}
    <div className="clip-effects" ref={root} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      if (open && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End")) {
        event.preventDefault();
        const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".clip-effects__picker button") ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <button ref={trigger} type="button" className="clip-effects__add" disabled={disabled || available.length === 0} aria-expanded={open} aria-controls={pickerId} onClick={() => setOpen((value) => !value)}><Plus size={16} /> Add Effect</button>
      {open && <div id={pickerId} className="clip-effects__picker" role="group" aria-label="Available effects">
        {available.map((effect) => <button type="button" key={effect.id} onClick={() => { update(effect.defaults); setOpen(false); trigger.current?.focus(); }}><strong>{effect.name}</strong><span>{effect.description}</span></button>)}
      </div>}
    </div>
  </>;
}
