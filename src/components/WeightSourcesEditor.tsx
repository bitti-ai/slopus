import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { isDownloadUrl, type WeightSource } from "../lib/settings";

export function WeightSourcesEditor({ label, sources, disabled, onChange }: {
  label: string; sources: WeightSource[]; disabled: boolean; onChange: (sources: WeightSource[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = (index: number, patch: Partial<WeightSource>) => onChange(sources.map((source, i) => i === index ? { ...source, ...patch } : source));
  return <details className="weight-sources">
    <summary>Download variants{sources.length > 0 ? ` (${sources.length})` : ""}</summary>
    <p>GPU model matches part of the device name, such as “RTX 5090”. Leave it blank for any GPU. Among matches, the highest minimum VRAM that fits is selected.</p>
    {sources.map((source, index) => <div className="weight-source" key={`${index}-${source.url}`}>
      <label>Download URL<input aria-label={`${label} variant ${index + 1} URL`} defaultValue={source.url} disabled={disabled} onBlur={(event) => {
        const value = event.target.value.trim();
        if (!isDownloadUrl(value)) { setError("Enter an HTTP or HTTPS download URL."); return; }
        setError(null);
        if (value !== source.url) update(index, { url: value, downloadedPath: undefined });
      }} /></label>
      <label>GPU model<input aria-label={`${label} variant ${index + 1} GPU model`} defaultValue={source.gpuModel} placeholder="Any GPU" disabled={disabled} onBlur={(event) => update(index, { gpuModel: event.target.value })} /></label>
      <label>Minimum VRAM (GB)<input aria-label={`${label} variant ${index + 1} minimum VRAM`} type="number" min={0} step={1} value={source.minVramGb} disabled={disabled} onChange={(event) => update(index, { minVramGb: Math.max(0, Number(event.target.value) || 0) })} /></label>
      <button type="button" className="icon-button" disabled={disabled} onClick={() => onChange(sources.filter((_, i) => i !== index))} aria-label={`Remove ${label} variant ${index + 1}`}><Trash2 size={15} /></button>
    </div>)}
    <div className="weight-source-add">
      <input aria-label={`Add ${label} download URL`} value={url} disabled={disabled} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} />
      <button type="button" className="secondary-button" disabled={disabled || !isDownloadUrl(url) || sources.some((source) => source.url === url.trim())} onClick={() => {
        onChange([...sources, { url: url.trim(), gpuModel: "", minVramGb: 0 }]); setUrl("");
      }}><Plus size={15} /> Add URL</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
