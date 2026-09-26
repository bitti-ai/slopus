import { useState } from "react";
import { FileBox, Plus, Trash2 } from "lucide-react";
import { isDownloadUrl, type AdditionalSafetensor } from "../lib/settings";
import { ComboBox, InfoBar, SettingsCard, SettingsExpander, SettingsGroup, SettingsRow } from "./ui";

/* Extra .safetensors files that download with a generator. Each file is an
   expander (name + download state in the header, its fields inside); the
   last card adds one by URL. */
export function AdditionalSafetensorsEditor({ value, disabled, animate, onChange }: {
  value: AdditionalSafetensor[]; disabled: boolean; animate: boolean; onChange: (files: AdditionalSafetensor[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const update = (id: string, patch: Partial<AdditionalSafetensor>) => onChange(value.map((file) => file.id === id ? { ...file, ...patch } : file));
  return <SettingsGroup heading={`Additional safetensors (${value.length})`} className="additional-safetensors">
    {value.map((file, index) => <SettingsExpander key={`${file.id}-${file.url}`} icon={<FileBox size={20} />} header={file.name || "Additional safetensor"}
      description={<span data-tooltip={file.downloadedPath}>{file.downloadedPath ? "Downloaded" : "Download required"}</span>} defaultExpanded={!file.downloadedPath}
      control={<button type="button" className="icon-button" disabled={disabled} aria-label={`Remove additional safetensor ${index + 1}`} data-tooltip="Remove"
        onClick={() => onChange(value.filter((entry) => entry.id !== file.id))}><Trash2 size={16} /></button>}>
      <SettingsRow header="Name">
        <input className="text-field settings-field" aria-label={`Additional safetensor ${index + 1} name`} value={file.name} disabled={disabled}
          onChange={(event) => update(file.id, { name: event.target.value })} />
      </SettingsRow>
      <SettingsRow header="Download URL">
        <input className="text-field settings-field" aria-label={`Additional safetensor ${index + 1} URL`} defaultValue={file.url} disabled={disabled} spellCheck={false} onBlur={(event) => {
          const next = event.target.value.trim();
          if (!isDownloadUrl(next)) { setError("Enter an HTTP or HTTPS download URL."); return; }
          setError(null);
          if (next !== file.url) update(file.id, { url: next, downloadedPath: undefined });
        }} />
      </SettingsRow>
      {animate && <SettingsRow header="Use">
        <ComboBox aria-label={`Additional safetensor ${index + 1} use`} value={file.role ?? ""} disabled={disabled} onChange={(next) => {
          const role = next === "promptEmbedding" ? "promptEmbedding" : undefined;
          onChange(value.map((entry) => entry.id === file.id ? { ...entry, role } : role ? { ...entry, role: undefined } : entry));
        }} options={[{ value: "", label: "Additional file" }, { value: "promptEmbedding", label: "Animate conditioning" }]} />
      </SettingsRow>}
    </SettingsExpander>)}
    <SettingsCard icon={<Plus size={20} />} header="Add a file" description="Downloads with this generator into your weights folder">
      <input className="text-field settings-field" aria-label="Add additional safetensor URL" value={url} disabled={disabled} placeholder="https://…" spellCheck={false}
        onChange={(event) => setUrl(event.target.value)} />
      <button type="button" className="secondary-button" disabled={disabled || !isDownloadUrl(url) || value.some((file) => file.url === url.trim())} onClick={() => {
        onChange([...value, { id: crypto.randomUUID(), name: url.trim().split("/").pop()?.split("?")[0] || "Additional safetensor", url: url.trim(),
          ...(animate && !value.some((file) => file.role === "promptEmbedding") ? { role: "promptEmbedding" } : {}) }]);
        setUrl("");
      }}>Add file</button>
    </SettingsCard>
    {error && <InfoBar severity="error" message={error} onClose={() => setError(null)} />}
  </SettingsGroup>;
}
