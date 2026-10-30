import { useEffect, useRef, useState } from "react";
import { effectiveLoras, isLoraStrength, loadLoras, selectionConflict, subscribeLoras, type TemplateLora } from "../../lib/loras";
import type { GeneratorTemplate } from "../../lib/settings";
import { Checkbox, Flyout, InfoBar, PropRow } from "../ui";
import { Add16, Delete14 } from "../ui/icons";

export function SceneLoras({ template, value, disabled = false, onChange }: {
  template?: GeneratorTemplate; value?: TemplateLora[] | null; disabled?: boolean;
  onChange: (value: TemplateLora[] | undefined) => void;
}) {
  const [library, setLibrary] = useState(loadLoras);
  useEffect(() => subscribeLoras(() => setLibrary(loadLoras())), []);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const modelType = template?.modelType ?? "minimax-h3";
  const overrides = value ?? [];
  const effective = effectiveLoras(template?.loras, overrides, modelType, library);
  const conflict = selectionConflict(effective, library);
  const available = library.filter((lora) => (lora.modelType ?? "minimax-h3") === modelType && !effective.some((entry) => entry.loraId === lora.id));
  const update = (entry: TemplateLora) => onChange([...overrides.filter((item) => item.loraId !== entry.loraId), entry]);
  const conflictsWith = (entry: TemplateLora) => selectionConflict(effectiveLoras(template?.loras,
    [...overrides.filter((item) => item.loraId !== entry.loraId), entry], modelType, library), library);
  return <div className="clip-effects generation-effects scene-loras" role="group" aria-label="Scene LoRAs">
    {effective.map((entry) => {
      const lora = library.find((lora) => lora.id === entry.loraId);
      const name = lora?.name ?? "Missing LoRA";
      const global = modelType === "minimax-h3" && lora?.globallyEnabled === true && (lora.modelType ?? "minimax-h3") === modelType;
      const overridden = overrides.some((item) => item.loraId === entry.loraId);
      const locked = disabled || global;
      const enableConflict = conflictsWith({ ...entry, enabled: true });
      return <section key={entry.loraId} className={`clip-effect clip-effect--open${entry.enabled ? "" : " clip-effect--bypassed"}`} aria-label={`${name} LoRA`}>
        <div className="clip-effect__header">
          <Checkbox className="clip-effect__bypass" aria-label={`Enable scene LoRA ${name}`} checked={entry.enabled} disabled={locked || (!entry.enabled && !!enableConflict)} onChange={(enabled) => update({ ...entry, enabled })} />
          <h3 className="clip-effect__name">{name}</h3>
          {overridden && !global && <button type="button" className="clip-effect__action" aria-label={`Remove ${name} override`} disabled={disabled} onClick={() => {
            const next = overrides.filter((item) => item.loraId !== entry.loraId); onChange(next.length ? next : undefined);
          }}><Delete14 /></button>}
        </div>
        <div className="clip-effect__body">
          <p className="clip-effect__note">{global ? "Global · Read only" : overridden ? "Scene override" : "Generator template"}</p>
          <PropRow label="Strength"><input className="text-field" type="number" step="0.1" aria-label={`${name} scene strength`} disabled={locked || !entry.enabled} value={entry.strength}
            onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && isLoraStrength(strength) && !conflictsWith({ ...entry, strength })) update({ ...entry, strength }); }} /></PropRow>
          {!lora?.path && <p className="clip-effect__note">Download or locate this LoRA in Settings.</p>}
        </div>
      </section>;
    })}
    <button ref={trigger} className="secondary-button clip-effects__add" type="button" disabled={disabled || !available.length} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><Add16 />Add LoRA</button>
    <Flyout open={open && !disabled} anchor={trigger} onClose={() => setOpen(false)} aria-label="Available scene LoRAs" role="group" placement="top" width={260}>
      <div className="clip-effects__picker">{available.map((lora) => {
        const entry = { loraId: lora.id, enabled: true, strength: 1 };
        const reason = conflictsWith(entry);
        return <button type="button" className="clip-effects__item" key={lora.id} disabled={!!reason} data-tooltip={reason ?? undefined} onClick={() => {
          update(entry); setOpen(false); trigger.current?.focus();
        }}>{lora.name}</button>;
      })}</div>
    </Flyout>
    {conflict && <InfoBar severity="error" message={conflict} />}
  </div>;
}
