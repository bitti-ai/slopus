import { ArrowDown, ArrowUp, Download, FolderSearch, Layers, Plus, Trash2 } from "lucide-react";
import "../styles/loras.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { loadLoras, saveLoras, subscribeLoras, type TemplateLora } from "../lib/loras";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath } from "../lib/runtime";
import { downloadLora, getWeightDownloadState, refreshDownloadedLoras, removeLora, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";

function useLoras() {
  const [loras, setLoras] = useState(loadLoras);
  useEffect(() => subscribeLoras(() => setLoras(loadLoras())), []);
  return loras;
}

export function LoraLibrary() {
  const loras = useLoras();
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [taomate, setTaomate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();
  useEffect(() => {
    const refresh = () => { void refreshDownloadedLoras().catch((reason) => setError(String(reason))); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  const browse = async () => {
    try {
      const picked = await chooseEnginePath({ id: "transformer", label: "LoRA", hint: "", directory: false, extensions: ["safetensors"], required: false });
      if (!picked) return;
      setPath(picked);
      if (!name.trim()) setName(picked.split(/[\\/]/).pop()!.replace(/\.safetensors$/i, ""));
      setTaomate(/taomate/i.test(picked));
    } catch (reason) { setError(String(reason)); }
  };
  const add = () => {
    if (!name.trim() || !path.trim()) return;
    if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path.trim()) || path.includes("\0")) {
      setError("Choose a local LoRA file using its absolute path."); return;
    }
    try {
      saveLoras([...loadLoras(), { id: `lora-${crypto.randomUUID()}`, name: name.trim(), path: path.trim(), ...(taomate ? { schedule: "taomate-3step" as const } : {}) }]);
      setAdding(false); setName(""); setPath(""); setTaomate(false); setError(null);
    } catch (reason) { setError(String(reason)); }
  };
  return <section className="generator-templates" aria-labelledby="loras-heading">
    <header><div><h2 id="loras-heading">LoRAs</h2><p>Download adapters or add local files, then activate them in a generator template.</p></div>
      <button className="secondary-button" type="button" onClick={() => setAdding(!adding)}><Plus size={16} /> Add LoRA manually</button></header>
    <div className="generator-template-list" role="list" aria-label="LoRAs">
      {loras.map((lora) => <div className="generator-template-item lora-library-item" role="listitem" key={lora.id}>
        {download?.active && download.loraId === lora.id && <span className="generator-template-item__progress" role="progressbar" aria-label={`Downloading ${lora.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(weightDownloadProgress(download))} style={{ width: `${weightDownloadProgress(download)}%` }} />}
        <div className="generator-template-item__open"><Layers size={16} /><b>{lora.name}</b><small title={lora.path}>{download?.active && download.loraId === lora.id ? `Downloading · ${Math.floor(weightDownloadProgress(download))}%` : lora.path ? "Available" : "Not downloaded"}</small></div>
        {lora.url && !lora.path ? <button className="icon-button" type="button" disabled={!desktop || download?.active} aria-label={`Download LoRA ${lora.name}`} onClick={() => void downloadLora(lora.id)}><Download size={15} /></button>
          : <button className="icon-button" type="button" disabled={Boolean(download?.active)} aria-label={`Remove LoRA ${lora.name}`} onClick={() => void removeLora(lora.id).catch((reason) => setError(String(reason)))}><Trash2 size={15} /></button>}
      </div>)}
    </div>
    {adding && <div className="lora-manual">
      <label>Name<input aria-label="LoRA name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Local file<div className="settings-path__row"><input aria-label="LoRA path" value={path} onChange={(event) => { setPath(event.target.value); setTaomate(/taomate/i.test(event.target.value)); }} placeholder="Absolute path to a .safetensors file" />
        <button className="secondary-button" type="button" disabled={!desktop} onClick={() => void browse()}><FolderSearch size={16} /> Browse</button></div></label>
      <label className="lora-toggle"><input type="checkbox" checked={taomate} onChange={(event) => setTaomate(event.target.checked)} /> Use TaoMate three-step schedule</label>
      <p>The file stays in its current location.</p>
      <button className="secondary-button" type="button" disabled={!name.trim() || !path.trim()} onClick={add}>Add local LoRA</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function TemplateLorasEditor({ value, onChange }: { value: TemplateLora[]; onChange: (value: TemplateLora[]) => void }) {
  const library = useLoras();
  const available = library.filter((entry) => entry.path && !value.some(({ loraId }) => loraId === entry.id));
  const update = (index: number, patch: Partial<TemplateLora>) => onChange(value.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  const move = (index: number, delta: number) => {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return <section className="template-loras" aria-labelledby="template-loras-heading">
    <h3 id="template-loras-heading">LoRAs <small>{value.filter((entry) => entry.enabled && entry.strength !== 0).length} active</small></h3>
    <p>Enable any number of adapters and arrange their order. Strength 0 disables an adapter.</p>
    {value.map((entry, index) => {
      const lora = library.find(({ id }) => id === entry.loraId);
      const name = lora?.name ?? "Missing LoRA";
      return <div className="template-lora-row" key={entry.loraId}>
        <span>{index + 1}.</span>
        <label className="lora-toggle"><input type="checkbox" checked={entry.enabled} aria-label={`Enable ${name}`} onChange={(event) => update(index, { enabled: event.target.checked })} /> {name}{!lora?.path && " (file unavailable)"}</label>
        <label>Strength<input type="number" step="0.1" aria-label={`${name} strength`} value={entry.strength} onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && Number.isFinite(strength)) update(index, { strength }); }} /></label>
        <button className="icon-button" type="button" aria-label={`Move ${name} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={15} /></button>
        <button className="icon-button" type="button" aria-label={`Move ${name} down`} disabled={index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={15} /></button>
        <button className="icon-button" type="button" aria-label={`Deactivate and remove ${name}`} onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
      </div>;
    })}
    <select aria-label="Add LoRA to generator" value="" disabled={!available.length} onChange={(event) => { if (event.target.value) onChange([...value, { loraId: event.target.value, enabled: true, strength: 1 }]); }}>
      <option value="">{available.length ? "Add an available LoRA…" : "Download or add a LoRA in Generators settings"}</option>
      {available.map((lora) => <option value={lora.id} key={lora.id}>{lora.name}</option>)}
    </select>
    {value.some((entry) => entry.enabled && entry.strength !== 0 && library.find(({ id }) => id === entry.loraId)?.schedule === "taomate-3step") && <p>TaoMate uses its three-step schedule, overriding the scene's step count.</p>}
  </section>;
}
