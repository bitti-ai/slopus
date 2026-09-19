import { ArrowDown, ArrowUp, Download, FolderSearch, Layers, Plus, Trash2 } from "lucide-react";
import "../styles/loras.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { effectiveLoraStrength, highestLoraStepOverride, isLoraMultiplier, isLoraStepOverride, loadLoras, MAX_LORA_MULTIPLIER, saveLoras, subscribeLoras, type Lora, type TemplateLora } from "../lib/loras";
import { MAX_GENERATION_STEPS } from "../lib/project";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath } from "../lib/runtime";
import { downloadLora, getWeightDownloadState, refreshDownloadedLoras, removeLora, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";

function useLoras() {
  const [loras, setLoras] = useState(loadLoras);
  useEffect(() => subscribeLoras(() => setLoras(loadLoras())), []);
  return loras;
}

export function LoraLibrary({ onAdd, onEdit }: { onAdd: () => void; onEdit: (id: string) => void }) {
  const loras = useLoras();
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();
  useEffect(() => {
    const refresh = () => { void refreshDownloadedLoras().catch((reason) => setError(String(reason))); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  return <section className="generator-templates" aria-labelledby="loras-heading">
    <header><div><h2 id="loras-heading">LoRAs</h2><p>Download adapters or add local files, then activate them in a generator template.</p></div>
      <button className="secondary-button" type="button" onClick={onAdd}><Plus size={16} /> Add Lora</button></header>
    <div className="generator-template-list" role="list" aria-label="LoRAs">
      {loras.map((lora) => <div className="generator-template-item lora-library-item" role="listitem" key={lora.id}>
        {download?.active && download.loraId === lora.id && <span className="generator-template-item__progress" role="progressbar" aria-label={`Downloading ${lora.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(weightDownloadProgress(download))} style={{ width: `${weightDownloadProgress(download)}%` }} />}
        <button type="button" className="generator-template-item__open" aria-label={`Edit ${lora.name} LoRA`} onClick={() => onEdit(lora.id)}><Layers size={16} /><b>{lora.name}</b><small title={lora.path}>{download?.active && download.loraId === lora.id ? `Downloading · ${Math.floor(weightDownloadProgress(download))}%` : lora.path ? "Available" : "Not downloaded"}</small></button>
        {lora.url && !lora.path ? <button className="icon-button" type="button" disabled={!desktop || download?.active} aria-label={`Download LoRA ${lora.name}`} onClick={() => void downloadLora(lora.id)}><Download size={15} /></button>
          : <button className="icon-button" type="button" disabled={Boolean(download?.active)} aria-label={`Remove LoRA ${lora.name}`} onClick={() => void removeLora(lora.id).catch((reason) => setError(String(reason)))}><Trash2 size={15} /></button>}
      </div>)}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function LoraEditor({ loraId, onDone }: { loraId: string; onDone: () => void }) {
  const existing = loadLoras().find(({ id }) => id === loraId);
  const [name, setName] = useState(existing?.name ?? "");
  const [path, setPath] = useState(existing?.path ?? "");
  const [multiplier, setMultiplier] = useState(String(existing?.multiplier ?? 1));
  const validMultiplier = multiplier.trim() !== "" && isLoraMultiplier(Number(multiplier));
  const [override, setOverride] = useState(existing?.stepOverride !== undefined);
  const [steps, setSteps] = useState(String(existing?.stepOverride ?? 3));
  const [error, setError] = useState<string | null>(null);
  const browse = async () => {
    try {
      const picked = await chooseEnginePath({ id: "transformer", label: "LoRA", hint: "", directory: false, extensions: ["safetensors"], required: false });
      if (!picked) return;
      setPath(picked);
      if (!name.trim()) setName(picked.split(/[\\/]/).pop()!.replace(/\.safetensors$/i, ""));
    } catch (reason) { setError(String(reason)); }
  };
  const save = () => {
    if (!name.trim() || (!path.trim() && !existing?.url) || !validMultiplier) return;
    if (path.trim() && (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path.trim()) || path.includes("\0"))) {
      setError("Choose a local LoRA file using its absolute path."); return;
    }
    try {
      const library = loadLoras();
      const entry: Lora = { ...library.find(({ id }) => id === loraId), id: loraId, name: name.trim(), path: path.trim(), multiplier: Number(multiplier), stepOverride: override ? Number(steps) : undefined };
      saveLoras(existing ? library.map((lora) => lora.id === loraId ? entry : lora) : [...library, entry]);
      onDone();
    } catch (reason) { setError(String(reason)); }
  };
  return <div className="generator-editor">
    <header className="generator-editor__head"><h2 id="lora-editor-heading">{existing ? "Edit Lora" : "Add Lora"}</h2></header>
    <div className="lora-manual">
      <label>Name<input aria-label="LoRA name" autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Local file<div className="settings-path__row"><input aria-label="LoRA path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="Absolute path to a .safetensors file" />
        <button className="secondary-button" type="button" disabled={!isTauri()} onClick={() => void browse()}><FolderSearch size={16} /> Browse</button></div></label>
      <label>Multiplier<input aria-label="LoRA multiplier" aria-describedby="lora-multiplier-help" type="number" min={-MAX_LORA_MULTIPLIER} max={MAX_LORA_MULTIPLIER} step="any" value={multiplier} onChange={(event) => setMultiplier(event.target.value)} /></label>
      <p id="lora-multiplier-help">Multiplies this LoRA's strength in every generator. 1 keeps the original strength, 0 disables it, and negative values reverse its effect.</p>
      <label className="lora-toggle"><input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} /> Override step count</label>
      {override && <label>Step count<input aria-label="LoRA step override" type="number" min={2} max={MAX_GENERATION_STEPS} step={1} value={steps} onChange={(event) => setSteps(event.target.value)} /></label>}
      <p>The highest override among active LoRAs replaces the scene's step count. Without an override, the scene's steps are used.</p>
      <p>The file stays in its current location.</p>
      <button className="primary-button" type="button" disabled={!name.trim() || (!path.trim() && !existing?.url) || !validMultiplier || (override && !isLoraStepOverride(Number(steps)))} onClick={save}>{existing ? "Save Lora" : "Add Lora"}</button>
      {error && <p role="alert">{error}</p>}
    </div>
  </div>;
}

export function TemplateLorasEditor({ value, onChange }: { value: TemplateLora[]; onChange: (value: TemplateLora[]) => void }) {
  const library = useLoras();
  const active = value.filter((entry) => entry.enabled && effectiveLoraStrength(entry, library.find(({ id }) => id === entry.loraId)) !== 0);
  const stepOverride = highestLoraStepOverride(active
    .flatMap((entry) => library.filter(({ id }) => id === entry.loraId)));
  const available = library.filter((entry) => (entry.path || entry.url) && !value.some(({ loraId }) => loraId === entry.id));
  const update = (index: number, patch: Partial<TemplateLora>) => onChange(value.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  const move = (index: number, delta: number) => {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return <section className="template-loras" aria-labelledby="template-loras-heading">
    <h3 id="template-loras-heading">LoRAs <small>{active.length} active</small></h3>
    <p>Enable adapters and arrange their order. Strength is multiplied by each LoRA's multiplier in its settings. Either value at 0 disables the adapter.</p>
    <p>Missing active LoRAs with download links are downloaded with the generator.</p>
    {value.map((entry, index) => {
      const lora = library.find(({ id }) => id === entry.loraId);
      const name = lora?.name ?? "Missing LoRA";
      return <div className="template-lora-row" key={entry.loraId}>
        <span>{index + 1}.</span>
        <label className="lora-toggle"><input type="checkbox" checked={entry.enabled} aria-label={`Enable ${name}`} onChange={(event) => update(index, { enabled: event.target.checked })} /> {name}{!lora?.path && (lora?.url ? " (download required)" : " (file unavailable)")}</label>
        <label>Strength<input type="number" step="0.1" aria-label={`${name} strength`} value={entry.strength} onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && Number.isFinite(strength)) update(index, { strength }); }} /></label>
        {lora?.multiplier !== undefined && lora.multiplier !== 1 && <small aria-label={`${name} effective strength`}>× {lora.multiplier} = {Number(effectiveLoraStrength(entry, lora).toPrecision(6))}</small>}
        <button className="icon-button" type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
        <button className="icon-button" type="button" aria-label={`Move ${name} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
        <button className="icon-button" type="button" aria-label={`Deactivate and remove ${name}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
      </div>;
    })}
    <select aria-label="Add LoRA to generator" value="" disabled={!available.length} onChange={(event) => { if (event.target.value) onChange([...value, { loraId: event.target.value, enabled: true, strength: 1 }]); }}>
      <option value="">{available.length ? "Add an available LoRA…" : "Download or add a LoRA in Generators settings"}</option>
      {available.map((lora) => <option value={lora.id} key={lora.id}>{lora.name}</option>)}
    </select>
    {stepOverride !== undefined && <p>Active LoRAs override the scene's step count to {stepOverride}, the highest selected override.</p>}
  </section>;
}
