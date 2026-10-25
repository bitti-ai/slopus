import { useEffect, useState } from "react";
import { motionOverride, motionOverrideSchema, motionSchema, type Motion } from "../../lib/motion";
import { PropSection, PropRow } from "../ui";
import { SliderNumberInput } from "./SliderNumberInput";

export function MotionInspector({ motion, selectedId, onSelect, onChange, disabled = false, onRenderReference, rendering = false }: {
  motion: Motion; selectedId: string | null; onSelect: (id: string | null) => void; onChange: (motion: Motion) => void;
  disabled?: boolean; onRenderReference?: () => void; rendering?: boolean;
}) {
  const [source, setSource] = useState(motion.source);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setSource(motion.source), [motion.source]);
  const change = (next: Motion) => {
    const result = motionSchema.safeParse(next);
    if (result.success) { onChange(result.data); setError(null); }
    else setError(result.error.issues[0].message);
  };
  const node = motion.nodes.find(({ id }) => id === selectedId);
  const edit = node ? motionOverride(motion, node.id) : null;
  return <>
    <PropSection title="Motion" persistKey="motion.document">
      <PropRow label="Duration"><SliderNumberInput aria-label="Motion duration" minimum={0.1} maximum={600} step={0.1} suffix="s" disabled={disabled}
        value={motion.duration} onCommit={(duration) => change({ ...motion, duration })} /></PropRow>
      <button className="secondary-button inspector-action" disabled={rendering || !onRenderReference} onClick={onRenderReference}>{rendering ? "Rendering reference…" : "Render as reference video"}</button>
    </PropSection>
    <PropSection title="Elements" persistKey="motion.elements">
      {!motion.nodes.length && <p className="settings-description">This Motion is empty. Ask the agent to add elements and animation.</p>}
      {motion.nodes.map((item) => <button key={item.id} className="secondary-button" aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>{item.name}</button>)}
      {node && edit && <>
        {(["offset", "scale", "rotation"] as const).flatMap((property) => (property === "rotation" ? [2] : [0, 1]).map((axis) => {
          const label = `${property === "offset" ? "Offset" : property === "scale" ? "Scale" : "Rotation"}${property === "rotation" ? "" : axis === 0 ? " X" : " Y"}`;
          return <PropRow key={`${property}-${axis}`} label={label}><input className="text-field" type="number" aria-label={`Element ${label}`} disabled={disabled}
            step={property === "scale" ? 0.05 : 1} value={edit[property][axis]} onChange={(e) => {
              const value = Number(e.target.value); if (!Number.isFinite(value)) return;
              const vector = [...edit[property]] as [number, number, number]; vector[axis] = value;
              change({ ...motion, overrides: { ...motion.overrides, [node.id]: { ...edit, [property]: vector } } });
            }} /></PropRow>;
        }))}
        <PropRow label="Fill"><input className="text-field" aria-label="Element fill" disabled={disabled} value={edit.fill ?? node.fill}
          onChange={(e) => change({ ...motion, overrides: { ...motion.overrides, [node.id]: { ...edit, fill: e.target.value } } })} /></PropRow>
        {node.kind === "text" && <PropRow label="Text"><input className="text-field" aria-label="Element text" disabled={disabled} value={edit.text ?? node.text}
          onChange={(e) => change({ ...motion, overrides: { ...motion.overrides, [node.id]: { ...edit, text: e.target.value } } })} /></PropRow>}
        <button className="secondary-button inspector-action" disabled={disabled} onClick={() => change({ ...motion, overrides: { ...motion.overrides, [node.id]: motionOverrideSchema.parse({}) } })}>Reset element adjustments</button>
      </>}
    </PropSection>
    <PropSection title="Parameters" persistKey="motion.parameters">
      {motion.parameters.length === 0 && <p className="settings-description">The agent can expose movement, timing, color and text controls here.</p>}
      {motion.parameters.map((p) => <PropRow key={p.id} label={p.label}>{p.type === "number" && p.min !== undefined && p.max !== undefined ?
        <SliderNumberInput aria-label={p.label} minimum={p.min} maximum={p.max} step={p.step ?? 0.01} value={Number(p.value)} disabled={disabled}
          onCommit={(value) => change({ ...motion, parameters: motion.parameters.map(item => item.id === p.id ? { ...item, value } : item) })} /> : <input className="text-field" aria-label={p.label} disabled={disabled}
        type={p.type === "boolean" ? "checkbox" : p.type === "number" ? "number" : "text"}
        min={p.min} max={p.max} step={p.step ?? "any"} checked={p.type === "boolean" ? Boolean(p.value) : undefined}
        value={p.type === "boolean" ? undefined : String(p.value)} onChange={(e) => change({ ...motion, parameters: motion.parameters.map((item) => item.id !== p.id ? item : {
          ...item, value: p.type === "boolean" ? e.target.checked : p.type === "number" ? Number(e.target.value) : e.target.value,
        }) })} />}</PropRow>)}
    </PropSection>
    <PropSection title="JavaScript" persistKey="motion.source">
      <textarea className="text-field motion-source" aria-label="Motion JavaScript source" spellCheck={false} disabled={disabled} value={source} onChange={(e) => setSource(e.target.value)} />
      <button className="secondary-button inspector-action" disabled={disabled || source === motion.source} onClick={() => change({ ...motion, source })}>Apply source</button>
      {error && <p role="alert">{error}</p>}
    </PropSection>
  </>;
}
