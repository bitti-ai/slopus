import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Checkbox, ComboBox, Flyout, PropRow, PropSection, Slider, tooltipProps } from "../ui";
import { Add16, ChevronDown12, Delete14, Reset16 } from "../ui/icons";
import { GENERATION_EFFECTS, GENERATION_EFFECT_DEFAULTS, generationEffectsSchema, type GenerationEffectId, type GenerationEffects as Settings } from "../../lib/generationEffects";

export function GenerationEffects({ value, onChange, supported, disabled = false }: {
  value?: Settings | null; onChange: (value: Settings | undefined) => void; supported: boolean; disabled?: boolean;
}) {
  const effects = value ?? {};
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(picker.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };
  const locked = disabled || !supported;
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  const present = GENERATION_EFFECTS.filter(({ id }) => effects[id]);
  const available = GENERATION_EFFECTS.filter(({ id }) => !effects[id]);
  const update = (next: Settings) => {
    if (disabled || !generationEffectsSchema.safeParse(next).success) return;
    onChange(GENERATION_EFFECTS.some(({ id }) => next[id]) ? next : undefined);
  };
  const set = <K extends GenerationEffectId>(id: K, patch: Partial<NonNullable<Settings[K]>>) => update({ ...effects, [id]: { ...effects[id], ...patch } });
  const param = (id: GenerationEffectId, field: string, label: string, min: number, max: number, initial: number) => {
    const settings = effects[id] as unknown as Record<string, number>;
    const inactive = locked || effects[id]?.enabled === false;
    const change = (next: number) => { if (!inactive) set(id, { [field]: next }); };
    return <PropRow key={field} label={label} value={settings[field]} defaultValue={initial} onReset={inactive ? undefined : () => change(initial)} scrub={inactive ? undefined : { value: settings[field], onChange: change, step: 0.01, min, max }}>
      <Slider aria-label={label} min={min} max={max} step={0.01} value={settings[field]} disabled={inactive} onChange={change} />
      <span className="clip-effect__value">{settings[field].toFixed(2)}</span>
    </PropRow>;
  };
  return <PropSection title="Effects" tooltip={supported ? "Applied during generation. The first use prepares a reusable calibration for your VAE." : "This model does not support generation effects. Bypass or remove existing effects to generate."} persistKey="generation.effects" summary={present.length ? `${present.length}` : "None"}>
    <div className="clip-effects generation-effects">
      {present.map(({ id, name }) => {
        const on = effects[id]?.enabled !== false;
        const inactive = locked || !on;
        return <section key={id} className={`clip-effect${collapsed.has(id) ? "" : " clip-effect--open"}${on ? "" : " clip-effect--bypassed"}`} aria-label={name}>
          <div className="clip-effect__header">
            <Checkbox className="clip-effect__bypass" aria-label={`Enable ${name}`} checked={on} disabled={disabled || (!supported && !on)} onChange={(enabled) => set(id, { enabled })} />
            <button type="button" className="clip-effect__toggle" aria-expanded={!collapsed.has(id)} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; })}><ChevronDown12 aria-hidden="true" className="clip-effect__chevron" /><h3 className="clip-effect__name">{name}</h3></button>
            <button type="button" className="clip-effect__action" aria-label={`Reset ${name}`} disabled={locked} onClick={() => update({ ...effects, [id]: { ...GENERATION_EFFECT_DEFAULTS[id], ...(on ? {} : { enabled: false }) } })}><Reset16 aria-hidden="true" /></button>
            <button type="button" className="clip-effect__action" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => { const next = { ...effects }; delete next[id]; update(next); }}><Delete14 aria-hidden="true" /></button>
          </div>
          {!collapsed.has(id) && <fieldset className="clip-effect__body" disabled={inactive}>
            {id === "color" && effects.color && <>
              <PropRow label="Target color"><input type="color" aria-label="Target color" value={effects.color.color} disabled={inactive} onChange={(event) => set("color", { color: event.target.value })} /></PropRow>
              {param(id, "strength", "Color strength", 0, 2, 0.35)}
              <PropRow label="Method"><ComboBox aria-label="Color method" disabled={inactive} value={effects.color.mode} options={[{ value: "interpolated", label: "Interpolated" }, { value: "type_i", label: "Type I" }, { value: "type_ii", label: "Type II" }]} onChange={(mode) => set("color", { mode: mode as NonNullable<Settings["color"]>["mode"] })} /></PropRow>
            </>}
            {id === "tone" && <>{param(id, "contrast", "Contrast", 0, 4, 1)}{param(id, "brightness", "Brightness", -1, 1, 0)}{param(id, "saturation", "Saturation", 0, 4, 1)}{param(id, "temperature", "Temperature", -1, 1, 0)}</>}
            {id === "sharpness" && param(id, "strength", "Sharpness", -5, 5, 0.1)}
            {id === "anchor" && effects.anchor && <>
              <PropRow label="Anchor"><ComboBox aria-label="Color anchor" disabled={inactive} value={effects.anchor.mode} options={[{ value: "self", label: "Self" }, { value: "smooth", label: "Smooth" }]} onChange={(mode) => set("anchor", { mode: mode as "self" | "smooth" })} /></PropRow>
              {param(id, "strength", "Anchor strength", 0, 1, 0.25)}
            </>}
          </fieldset>}
        </section>;
      })}
      <button ref={trigger} type="button" className="secondary-button clip-effects__add" disabled={locked || !available.length} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><Add16 aria-hidden="true" />Add effect</button>
      <Flyout open={open} anchor={trigger} onClose={() => setOpen(false)} aria-label="Available generation effects" role="group" placement="top" width={240}>
        <div ref={picker} className="clip-effects__picker" onKeyDown={moveFocus}>{available.map(({ id, name, description }) => <button type="button" key={id} className="clip-effects__item" {...tooltipProps(description)} onClick={() => { if (!locked) update({ ...effects, [id]: { ...GENERATION_EFFECT_DEFAULTS[id] } }); setOpen(false); trigger.current?.focus(); }}>{name}</button>)}</div>
      </Flyout>
      {present.length > 0 && <>
        <PropRow label="First step"><input className="text-field" aria-label="First effect step" type="number" min={0} max={effects.endStep ?? 2147483647} disabled={locked} value={effects.startStep ?? 0} onChange={(e) => update({ ...effects, startStep: Number(e.target.value) })} /></PropRow>
        <PropRow label="Last step"><input className="text-field" aria-label="Last effect step" type="number" min={effects.startStep ?? 0} max={2147483647} placeholder="Last" disabled={locked} value={effects.endStep ?? ""} onChange={(e) => update({ ...effects, endStep: e.target.value === "" ? undefined : Number(e.target.value) })} /></PropRow>
        <p className="clip-effect__note">Steps start at 0. Leave the last step empty to apply through completion.</p>
        <Checkbox label="Limit to a region" checked={!!effects.region} disabled={locked} onChange={(enabled) => update({ ...effects, region: enabled ? { x: 0, y: 0, width: 100, height: 100, invert: false } : undefined })} />
        {effects.region && <>
          {(["x", "y", "width", "height"] as const).map((field) => <PropRow key={field} label={`${field[0].toUpperCase()}${field.slice(1)} (%)`}><input className="text-field" aria-label={`Effect region ${field}`} type="number" min={field === "x" || field === "y" ? 0 : 0.1} max={100} step={0.1} disabled={locked} value={effects.region![field]} onChange={(e) => update({ ...effects, region: { ...effects.region!, [field]: Number(e.target.value) } })} /></PropRow>)}
          <Checkbox label="Apply outside region" checked={effects.region.invert} disabled={locked} onChange={(invert) => update({ ...effects, region: { ...effects.region!, invert } })} />
        </>}
      </>}
    </div>
  </PropSection>;
}
