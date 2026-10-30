import { PropRow } from "../ui";
import { Copy16, Reset16 } from "../ui/icons";

export function UsedSeed({ id, seed, onError }: { id: string; seed?: number; onError: (message: string) => void }) {
  return <PropRow label="Used seed" htmlFor={id}>
    <input id={id} className="text-field" readOnly value={seed ?? "Not recorded"} />
    <button type="button" className="icon-button" aria-label="Copy used seed" data-tooltip="Copy used seed" disabled={seed === undefined} onClick={async () => {
      try { await navigator.clipboard.writeText(String(seed)); }
      catch { onError("Could not copy the seed. Select and copy it from the field."); }
    }}><Copy16 aria-hidden="true" /></button>
  </PropRow>;
}

export function UsedGenerator({ id, name, onUse }: { id: string; name?: string; onUse?: () => void }) {
  return <PropRow label="Used generator" htmlFor={id}>
    <input id={id} className="text-field" readOnly value={name ?? "Not recorded"} title={name} />
    <button type="button" className="icon-button" aria-label="Use this generator" disabled={!onUse}
      data-tooltip={onUse ? "Use this generator" : "Generator unavailable"} onClick={onUse}><Reset16 aria-hidden="true" /></button>
  </PropRow>;
}
