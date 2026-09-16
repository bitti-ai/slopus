import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { isDownloadUrl, type AdditionalSafetensor } from "../lib/settings";

export function AdditionalSafetensorsEditor({ value, disabled, animate, onChange }: {
  value: AdditionalSafetensor[]; disabled: boolean; animate: boolean; onChange: (files: AdditionalSafetensor[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<AdditionalSafetensor>) => onChange(value.map((file) => file.id === id ? { ...file, ...patch } : file));
  return <details className="weight-sources" open={animate || undefined}>
    <summary>Additional safetensors ({value.length})</summary>
    <p>These files download with this generator into your weights folder.</p>
    {value.map((file, index) => <div className="weight-source" key={`${file.id}-${file.url}`}>
      <label>Name<input aria-label={`Additional safetensor ${index + 1} name`} value={file.name} disabled={disabled}
        onChange={(event) => update(file.id, { name: event.target.value })} /></label>
      <label>Download URL<input aria-label={`Additional safetensor ${index + 1} URL`} defaultValue={file.url} disabled={disabled} onBlur={(event) => {
        const url = event.target.value.trim();
        if (!isDownloadUrl(url)) { setError("Enter an HTTP or HTTPS download URL."); return; }
        setError(null);
        if (url !== file.url) update(file.id, { url, downloadedPath: undefined });
      }} /></label>
      {animate && <label>Use<select aria-label={`Additional safetensor ${index + 1} use`} value={file.role ?? ""} disabled={disabled} onChange={(event) => {
        const role = event.target.value === "promptEmbedding" ? "promptEmbedding" : undefined;
        onChange(value.map((entry) => entry.id === file.id ? { ...entry, role } : role ? { ...entry, role: undefined } : entry));
      }}><option value="">Additional file</option><option value="promptEmbedding">Animate conditioning</option></select></label>}
      <span title={file.downloadedPath}>{file.downloadedPath ? "Downloaded" : "Download required"}</span>
      <button type="button" className="icon-button" disabled={disabled} aria-label={`Remove additional safetensor ${index + 1}`}
        onClick={() => onChange(value.filter((entry) => entry.id !== file.id))}><Trash2 size={15} /></button>
    </div>)}
    <div className="weight-source-add">
      <input aria-label="Add additional safetensor URL" value={url} disabled={disabled} placeholder="https://…"
        onChange={(event) => setUrl(event.target.value)} />
      <button type="button" className="secondary-button" disabled={disabled || !isDownloadUrl(url) || value.some((file) => file.url === url.trim())} onClick={() => {
        onChange([...value, { id: crypto.randomUUID(), name: url.trim().split("/").pop()?.split("?")[0] || "Additional safetensor", url: url.trim(),
          ...(animate && !value.some((file) => file.role === "promptEmbedding") ? { role: "promptEmbedding" } : {}) }]);
        setUrl("");
      }}><Plus size={15} /> Add file</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </details>;
}
