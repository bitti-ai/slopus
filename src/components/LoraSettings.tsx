import { ArrowDown, ArrowUp, Download, Layers, LoaderCircle, Plus, Trash2, Wrench } from "lucide-react";
import "../styles/loras.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { highestLoraStepOverride, isLoraStepOverride, loadLoras, saveLoras, subscribeLoras, type Lora, type TemplateLora } from "../lib/loras";
import { MAX_GENERATION_STEPS } from "../lib/project";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath } from "../lib/runtime";
import { downloadLora, getWeightDownloadState, prepareLora, refreshDownloadedLoras, removeLora, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";
import { Checkbox, ComboBox, ContentDialog, InfoBar, ProgressBar, SettingsCard, SettingsGroup, ToggleSwitch } from "./ui";
import { OpenableCard } from "./OpenableCard";

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
  return <SettingsGroup heading="LoRAs">
    <SettingsCard icon={<Plus size={20} />} header="Add a LoRA" description="Download adapters or add local files, then turn them on in a generator">
      <button className="secondary-button" type="button" onClick={onAdd}>Add LoRA</button>
    </SettingsCard>
    <div className="settings-card-list" role="list" aria-label="LoRAs">
      {loras.map((lora) => {
        const active = download?.active && download.loraId === lora.id;
        const preparing = active && download?.phase === "preparing";
        const percent = download ? Math.floor(weightDownloadProgress(download)) : 0;
        return <OpenableCard key={lora.id} icon={<Layers size={20} />} header={lora.name} openLabel={`Edit ${lora.name} LoRA`} onOpen={() => onEdit(lora.id)}
          description={<span data-tooltip={lora.path || undefined}>{active ? preparing ? "Preparing…" : `Downloading · ${percent}%` : lora.needsPreparation ? "Needs preparation" : lora.path ? "Available" : "Not downloaded"}</span>}
          progress={active && !preparing && <ProgressBar className="settings-progress" value={weightDownloadProgress(download!)} aria-label={`Downloading ${lora.name}`} />}
          actions={<>
            {lora.path && <button className="icon-button" type="button" disabled={!desktop || download?.active} aria-label={`Prepare LoRA ${lora.name}`} data-tooltip="Prepare missing timestep grid"
              onClick={() => { setError(null); void prepareLora(lora).catch((reason) => setError(String(reason))); }}>{preparing ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}</button>}
            {lora.url && !lora.path
              ? <button className="icon-button" type="button" disabled={!desktop || download?.active} aria-label={`Download LoRA ${lora.name}`} data-tooltip="Download" onClick={() => void downloadLora(lora.id)}><Download size={16} /></button>
              : <button className="icon-button" type="button" disabled={Boolean(download?.active)} aria-label={`Remove LoRA ${lora.name}`} data-tooltip="Remove" onClick={() => void removeLora(lora.id).catch((reason) => setError(String(reason)))}><Trash2 size={16} /></button>}
          </>} />;
      })}
    </div>
    {error && <InfoBar severity="error" message={error} onClose={() => setError(null)} />}
  </SettingsGroup>;
}

export function LoraEditor({ loraId, onDone }: { loraId: string; onDone: () => void }) {
  const existing = loadLoras().find(({ id }) => id === loraId);
  const [name, setName] = useState(existing?.name ?? "");
  const [path, setPath] = useState(existing?.path ?? "");
  const [override, setOverride] = useState(existing?.stepOverride !== undefined);
  const [steps, setSteps] = useState(String(existing?.stepOverride ?? 3));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [allowDownload, setAllowDownload] = useState(true);
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const browse = async () => {
    try {
      const picked = await chooseEnginePath({ id: "transformer", label: "LoRA", hint: "", directory: false, extensions: ["safetensors"], required: false });
      if (!picked) return;
      setPath(picked);
      if (!name.trim()) setName(picked.split(/[\\/]/).pop()!.replace(/\.safetensors$/i, ""));
    } catch (reason) { setError(String(reason)); }
  };
  const invalid = !name.trim() || (!path.trim() && !existing?.url) || (override && !isLoraStepOverride(Number(steps)));
  const save = async () => {
    if (invalid) return;
    if (path.trim() && (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path.trim()) || path.includes("\0"))) {
      setError("Choose a local LoRA file using its absolute path."); return;
    }
    try {
      setSaving(true); setError(null);
      if (path.trim() && path.trim() !== existing?.path && isTauri()) {
        await prepareLora({ id: loraId, name: name.trim(), path: path.trim() }, allowDownload);
      }
      const library = loadLoras();
      const entry: Lora = { ...library.find(({ id }) => id === loraId), id: loraId, name: name.trim(), path: path.trim(), stepOverride: override ? Number(steps) : undefined,
        ...(path.trim() !== existing?.path ? { needsPreparation: undefined } : {}) };
      saveLoras(existing ? library.map((lora) => lora.id === loraId ? entry : lora) : [...library, entry]);
      if (mounted.current) onDone();
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <ContentDialog title={existing ? "Edit LoRA" : "Add LoRA"} className="lora-dialog" width={560}
    primaryText={saving ? "Preparing LoRA…" : existing ? "Save" : "Add"} onPrimary={() => void save()} primaryDisabled={saving || Boolean(download?.active) || invalid}
    closeText="Cancel" onClose={onDone} defaultButton="primary" disableEscape={saving}>
    <fieldset className="lora-manual" disabled={saving}>
      <label>Name<input className="text-field" aria-label="LoRA name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Local file<span className="lora-manual__path"><input className="text-field" aria-label="LoRA path" value={path} spellCheck={false} onChange={(event) => setPath(event.target.value)} placeholder="Absolute path to a .safetensors file" />
        <button className="secondary-button" type="button" disabled={!isTauri()} onClick={() => void browse()}>Browse…</button></span></label>
      <Checkbox aria-label="Override step count" checked={override} onChange={setOverride} label="Override step count"
        description="The highest override among active LoRAs replaces the scene's step count." />
      {override && <label>Step count<input className="text-field" aria-label="LoRA step override" type="number" min={2} max={MAX_GENERATION_STEPS} step={1} value={steps} onChange={(event) => setSteps(event.target.value)} /></label>}
      <Checkbox aria-label="Download missing timestep grid" checked={allowDownload} onChange={setAllowDownload} label="Download missing timestep grid"
        description="New files are prepared in place before use, which may embed a timestep grid." />
      {error && <InfoBar severity="error" message={error} />}
    </fieldset>
  </ContentDialog>;
}

export function TemplateLorasEditor({ value, onChange }: { value: TemplateLora[]; onChange: (value: TemplateLora[]) => void }) {
  const library = useLoras();
  const active = value.filter((entry) => entry.enabled && entry.strength !== 0);
  const stepOverride = highestLoraStepOverride(active
    .flatMap((entry) => library.filter(({ id }) => id === entry.loraId)));
  const available = library.filter((entry) => (entry.path || entry.url) && !value.some(({ loraId }) => loraId === entry.id));
  const update = (index: number, patch: Partial<TemplateLora>) => onChange(value.map((entry, i) => i === index ? { ...entry, ...patch } : entry));
  const move = (index: number, delta: number) => {
    const next = [...value];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return <SettingsGroup heading={<>LoRAs <span className="settings-group__count">{active.length} active</span></>}>
    {value.map((entry, index) => {
      const lora = library.find(({ id }) => id === entry.loraId);
      const name = lora?.name ?? "Missing LoRA";
      return <SettingsCard key={entry.loraId} className="template-lora" icon={<Layers size={20} />} header={`${index + 1}. ${name}`}
        description={!lora?.path ? (lora?.url ? "Download required" : "File unavailable") : undefined}>
        <label className="template-lora__strength">Strength<input className="text-field settings-field settings-field--number" type="number" step="0.1" aria-label={`${name} strength`} value={entry.strength}
          onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && Number.isFinite(strength)) update(index, { strength }); }} /></label>
        <button className="icon-button" type="button" aria-label={`Move ${name} up`} data-tooltip="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button>
        <button className="icon-button" type="button" aria-label={`Move ${name} down`} data-tooltip="Move down" disabled={index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button>
        <button className="icon-button" type="button" aria-label={`Deactivate and remove ${name}`} data-tooltip="Remove" onClick={() => onChange(value.filter((_, i) => i !== index))}><Trash2 size={16} /></button>
        <ToggleSwitch checked={entry.enabled} aria-label={`Enable ${name}`} onChange={(enabled) => update(index, { enabled })} />
      </SettingsCard>;
    })}
    <SettingsCard icon={<Plus size={20} />} header="Add a LoRA" description="A strength of 0 turns an adapter off. Missing active LoRAs download with the generator.">
      <ComboBox aria-label="Add LoRA to generator" value="" disabled={!available.length} placeholder={available.length ? "Choose a LoRA" : "None available"}
        onChange={(loraId) => { if (loraId) onChange([...value, { loraId, enabled: true, strength: 1 }]); }}
        options={available.map((lora) => ({ value: lora.id, label: lora.name }))} />
    </SettingsCard>
    {stepOverride !== undefined && <InfoBar severity="informational" message={`Active LoRAs set the scene's step count to ${stepOverride}, the highest selected override.`} />}
  </SettingsGroup>;
}
