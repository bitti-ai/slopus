import { Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { DEFAULT_CLIP_CHROMA_KEY, DEFAULT_CLIP_LOOK, type TimelineClip } from "../../lib/project";

type EffectId = "look" | "transition" | "chromaKey";
type EditorProps = { clip: TimelineClip; update: (patch: Partial<TimelineClip>) => void };
type EffectDefinition = {
  id: EffectId;
  name: string;
  description: string;
  defaults: Partial<TimelineClip>;
  editor: (props: EditorProps) => ReactNode;
};

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
