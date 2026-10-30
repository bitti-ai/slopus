import { DEFAULT_VIDEO_SIGMA_SHIFT, DEFAULT_AUDIO_SIGMA_SHIFT, MIN_SIGMA_SHIFT, MAX_SIGMA_SHIFT, isSigmaShift } from "../lib/sampling";
import { Add20, ArrowDown16, ArrowUp16, Delete16, Download16, Lora20, Spinner16, Wrench16 } from "./ui/icons";
import "../styles/loras.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { effectiveLoras, selectionConflict, moveLibraryLora, highestLoraStepOverride, loraSigmaShiftOverrides, isLoraStepOverride, loadLoras, saveLoras, subscribeLoras, type Lora, type TemplateLora } from "../lib/loras";
import { generatorModel } from "../lib/generatorModels";
import { MAX_GENERATION_STEPS } from "../lib/project";
import { isTauri } from "../lib/persistence";
import { chooseEnginePath } from "../lib/runtime";
import { getQueuedWeightDownloads, downloadLora, getWeightDownloadState, prepareLora, refreshDownloadedLoras, removeLora, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";
import { Checkbox, ComboBox, ContentDialog, InfoBar, ProgressBar, SettingsCard, SettingsGroup, ToggleSwitch } from "./ui";
import { OpenableCard } from "./OpenableCard";

function useLoras() {
  const [loras, setLoras] = useState(loadLoras);
  useEffect(() => subscribeLoras(() => setLoras(loadLoras())), []);
  return loras;
}

export function LoraLibrary({ modelType, onAdd, onEdit }: { modelType: string; onAdd: () => void; onEdit: (id: string) => void }) {
  const loras = useLoras().filter((lora) => (lora.modelType ?? "minimax-h3") === modelType);
  const supported = generatorModel(modelType).loras;
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const queuedDownloads = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  const [error, setError] = useState<string | null>(null);
  const desktop = isTauri();
  const dragged = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const updateGlobal = (id: string, patch: Partial<Lora>) => {
    try { saveLoras(loadLoras().map((lora) => lora.id === id ? { ...lora, ...patch } : lora)); setError(null); }
    catch (reason) { setError(String(reason)); }
  };
  useEffect(() => {
    const refresh = () => { void refreshDownloadedLoras().catch((reason) => setError(String(reason))); };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => { window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  return <SettingsGroup heading="LoRAs">
    {supported ? <SettingsCard icon={<Add20 />} header="Add a LoRA" description="Enable globally or choose LoRAs in generators and scenes. Drag to set their application order.">
      <button className="secondary-button" type="button" onClick={onAdd}>Add LoRA</button>
    </SettingsCard> : <p className="settings-caption">This model does not support LoRAs.</p>}
    <div className="settings-card-list" role="list" aria-label="LoRAs">
      {loras.map((lora, index) => {
        const active = download?.active && download.loraId === lora.id;
        const queued = queuedDownloads.some((item) => item.loraId === lora.id);
        const preparing = active && download?.phase === "preparing";
        const percent = download ? Math.floor(weightDownloadProgress(download)) : 0;
        const conflict = selectionConflict(effectiveLoras([], [{ loraId: lora.id, enabled: true, strength: 1 }], modelType));
        return <OpenableCard key={lora.id} icon={<Lora20 />} header={lora.name} openLabel={`Edit ${lora.name} LoRA`} onOpen={() => onEdit(lora.id)}
          className={dropTarget === lora.id ? "lora-drop-target" : undefined}
          dragProps={{ draggable: true,
            onDragStart: (event) => { dragged.current = lora.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-slopus-lora", lora.id); },
            onDragOver: (event) => { if (dragged.current) { event.preventDefault(); setDropTarget(lora.id); } },
            onDrop: (event) => { event.preventDefault(); if (dragged.current) moveLibraryLora(dragged.current, lora.id); dragged.current = null; setDropTarget(null); },
            onDragEnd: () => { dragged.current = null; setDropTarget(null); } }}
          description={<span data-tooltip={lora.path || undefined}>{queued ? "Queued for download" : active ? preparing ? "Preparing…" : `Downloading · ${percent}%` : lora.needsPreparation ? "Needs preparation" : lora.path ? "Available" : "Not downloaded"}</span>}
          progress={active && !preparing && <ProgressBar className="settings-progress" value={weightDownloadProgress(download!)} aria-label={`Downloading ${lora.name}`} />}
          actions={<>
            <button className="icon-button" type="button" aria-label={`Move ${lora.name} up`} disabled={index === 0} onClick={() => moveLibraryLora(lora.id, loras[index - 1].id)}><ArrowUp16 /></button>
            <button className="icon-button" type="button" aria-label={`Move ${lora.name} down`} disabled={index === loras.length - 1} onClick={() => moveLibraryLora(lora.id, loras[index + 1].id)}><ArrowDown16 /></button>
            {modelType === "minimax-h3" && <>
              {lora.globallyEnabled && <label className="template-lora__strength">Strength<input type="number" className="text-field settings-field settings-field--number" step="0.1" aria-label={`${lora.name} global strength`} value={lora.globalStrength ?? 1}
                onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && Number.isFinite(strength) && strength !== 0) updateGlobal(lora.id, { globalStrength: strength }); }} /></label>}
              <span data-tooltip={!lora.globallyEnabled ? conflict ?? "Always use this LoRA" : "Always used by MiniMax H3"}>
                <ToggleSwitch aria-label={`Use ${lora.name} globally`} checked={lora.globallyEnabled ?? false} disabled={!lora.globallyEnabled && !!conflict} onChange={(globallyEnabled) => updateGlobal(lora.id, { globallyEnabled })} />
              </span>
            </>}
            {lora.path && <button className="icon-button" type="button" disabled={!desktop || active || queued} aria-label={`Prepare LoRA ${lora.name}`} data-tooltip="Prepare missing timestep grid"
              onClick={() => { setError(null); void prepareLora(lora).catch((reason) => setError(String(reason))); }}>{preparing ? <Spinner16 className="spin" /> : <Wrench16 />}</button>}
            {lora.url && !lora.path
              ? <button className="icon-button" type="button" disabled={!desktop || active || queued} aria-label={`Download LoRA ${lora.name}`} data-tooltip="Download" onClick={() => void downloadLora(lora.id)}><Download16 /></button>
              : <button className="icon-button" type="button" disabled={Boolean(download?.active)} aria-label={`Remove LoRA ${lora.name}`} data-tooltip="Remove" onClick={() => void removeLora(lora.id).catch((reason) => setError(String(reason)))}><Delete16 /></button>}
          </>} />;
      })}
    </div>
    {error && <InfoBar severity="error" message={error} onClose={() => setError(null)} />}
  </SettingsGroup>;
}

export function LoraEditor({ loraId, modelType, onDone }: { loraId: string; modelType: string; onDone: () => void }) {
  const existing = loadLoras().find(({ id }) => id === loraId);
  const [name, setName] = useState(existing?.name ?? "");
  const [path, setPath] = useState(existing?.path ?? "");
  const [override, setOverride] = useState(existing?.stepOverride !== undefined);
  const [steps, setSteps] = useState(String(existing?.stepOverride ?? 3));
  const [videoShift, setVideoShift] = useState(existing?.videoSigmaShiftOverride === undefined ? "" : String(existing.videoSigmaShiftOverride));
  const [audioShift, setAudioShift] = useState(existing?.audioSigmaShiftOverride === undefined ? "" : String(existing.audioSigmaShiftOverride));
  const [samplingPreset, setSamplingPreset] = useState(existing?.samplingPreset);
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
  const invalid = !name.trim() || (!path.trim() && !existing?.url) || (!samplingPreset && override && !isLoraStepOverride(Number(steps)))
    || (!samplingPreset && [videoShift, audioShift].some((value) => value !== "" && !isSigmaShift(Number(value))));
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
      const entry: Lora = { ...library.find(({ id }) => id === loraId), id: loraId, name: name.trim(), modelType: existing ? existing.modelType ?? "minimax-h3" : modelType, path: path.trim(), samplingPreset, stepOverride: !samplingPreset && override ? Number(steps) : undefined,
        videoSigmaShiftOverride: !samplingPreset && videoShift !== "" ? Number(videoShift) : undefined,
        audioSigmaShiftOverride: !samplingPreset && audioShift !== "" ? Number(audioShift) : undefined,
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
      <label>Sampling recipe<ComboBox aria-label="LoRA sampling recipe" value={samplingPreset ?? "default"}
        onChange={(value) => setSamplingPreset(value === "dmad-4step" || value === "pika-6step" ? value : undefined)}
        options={[{ value: "default", label: "Default" }, { value: "dmad-4step", label: "DMAD 4-Step" }, { value: "pika-6step", label: "Pika H3 Flex 6-Step" }]} /></label>
      {samplingPreset && <InfoBar severity="informational" message={samplingPreset === "pika-6step"
        ? "Pika H3 Flex uses six re-noising evaluations with video/audio shifts of 12/3. Its fixed schedule overrides step counts and turns off MotionCache. Use FL2VA with First/Last Frame generators and Ref2VA with References generators."
        : "DMAD uses four re-noising evaluations with video/audio shifts of 12/2. Its fixed schedule overrides step counts and turns off MotionCache."} />}
      {!samplingPreset && <Checkbox aria-label="Override step count" checked={override} onChange={setOverride} label="Override step count"
        description="The highest override among active LoRAs replaces the scene's step count." />}
      {!samplingPreset && override && <label>Step count<input className="text-field" aria-label="LoRA step override" type="number" min={2} max={MAX_GENERATION_STEPS} step={1} value={steps} onChange={(event) => setSteps(event.target.value)} /></label>}
      {!samplingPreset && <>
        <label>Video sigma shift override<input className="text-field" aria-label="LoRA video sigma shift override" type="number" min={MIN_SIGMA_SHIFT} max={MAX_SIGMA_SHIFT} step={0.1} placeholder={`No override (default ${DEFAULT_VIDEO_SIGMA_SHIFT})`} value={videoShift} onChange={(event) => setVideoShift(event.target.value)} /></label>
        <label>Audio sigma shift override<input className="text-field" aria-label="LoRA audio sigma shift override" type="number" min={MIN_SIGMA_SHIFT} max={MAX_SIGMA_SHIFT} step={0.1} placeholder={`No override (default ${DEFAULT_AUDIO_SIGMA_SHIFT})`} value={audioShift} onChange={(event) => setAudioShift(event.target.value)} /></label>
        <p>Leave shifts blank to use scene or generator values. The highest active override wins for each stream.</p>
      </>}
      <Checkbox aria-label="Download missing timestep grid" checked={allowDownload} onChange={setAllowDownload} label="Download missing timestep grid"
        description="New files are prepared in place before use, which may embed a timestep grid." />
      {error && <InfoBar severity="error" message={error} />}
    </fieldset>
  </ContentDialog>;
}

export function TemplateLorasEditor({ modelType, value: selection, onChange }: { modelType: string; value: TemplateLora[]; onChange: (value: TemplateLora[]) => void }) {
  const library = useLoras();
  const order = new Map(library.map((entry, index) => [entry.id, index]));
  const value = [...selection].sort((a, b) => (order.get(a.loraId) ?? Infinity) - (order.get(b.loraId) ?? Infinity));
  const effective = effectiveLoras(value, [], modelType, library);
  const active = effective.filter((entry) => entry.enabled && entry.strength !== 0);
  const conflict = selectionConflict(effective, library);
  const conflictsWith = (next: TemplateLora[]) => selectionConflict(effectiveLoras(next, [], modelType, library), library);
  const dmad = active.some((entry) => library.find(({ id }) => id === entry.loraId)?.samplingPreset === "dmad-4step");
  const pika = active.some((entry) => library.find(({ id }) => id === entry.loraId)?.samplingPreset === "pika-6step");
  const stepOverride = highestLoraStepOverride(active
    .flatMap((entry) => library.filter(({ id }) => id === entry.loraId)));
  const shifts = loraSigmaShiftOverrides(active.flatMap((entry) => library.filter(({ id }) => id === entry.loraId)));
  const available = library.filter((entry) => (entry.modelType ?? "minimax-h3") === modelType && (entry.path || entry.url) && !value.some(({ loraId }) => loraId === entry.id));
  const update = (index: number, patch: Partial<TemplateLora>) => {
    const next = value.map((entry, i) => i === index ? { ...entry, ...patch } : entry);
    if (!conflictsWith(next) || patch.enabled === false || patch.strength === 0) onChange(next);
  };
  const move = (index: number, delta: number) => {
    const next = [...value];
    moveLibraryLora(next[index].loraId, next[index + delta].loraId);
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  return <SettingsGroup heading={<>LoRAs <span className="settings-group__count">{active.length} active</span></>}>
    {value.map((entry, index) => {
      const lora = library.find(({ id }) => id === entry.loraId);
      const name = lora?.name ?? "Missing LoRA";
      return <SettingsCard key={entry.loraId} className="template-lora" icon={<Lora20 />} header={`${index + 1}. ${name}`}
        description={!lora?.path ? (lora?.url ? "Download required" : "File unavailable") : undefined}>
        <label className="template-lora__strength">Strength<input className="text-field settings-field settings-field--number" type="number" step="0.1" aria-label={`${name} strength`} value={entry.strength}
          onChange={(event) => { const strength = Number(event.target.value); if (event.target.value && Number.isFinite(strength)) update(index, { strength }); }} /></label>
        <button className="icon-button" type="button" aria-label={`Move ${name} up`} data-tooltip="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp16 /></button>
        <button className="icon-button" type="button" aria-label={`Move ${name} down`} data-tooltip="Move down" disabled={index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown16 /></button>
        <button className="icon-button" type="button" aria-label={`Deactivate and remove ${name}`} data-tooltip="Remove" onClick={() => onChange(value.filter((_, i) => i !== index))}><Delete16 /></button>
        <ToggleSwitch checked={entry.enabled} aria-label={`Enable ${name}`} disabled={!entry.enabled && !!conflictsWith(value.map((item, i) => i === index ? { ...item, enabled: true } : item))} onChange={(enabled) => update(index, { enabled })} />
      </SettingsCard>;
    })}
    <SettingsCard icon={<Add20 />} header="Add a LoRA" description="A strength of 0 turns an adapter off. Missing active LoRAs download with the generator.">
      <ComboBox aria-label="Add LoRA to generator" value="" disabled={!available.length} placeholder={available.length ? "Choose a LoRA" : "None available"}
        onChange={(loraId) => { if (loraId) onChange([...value, { loraId, enabled: true, strength: 1 }]); }}
        options={available.map((lora) => ({ value: lora.id, label: lora.name, disabled: !!conflictsWith([...value, { loraId: lora.id, enabled: true, strength: 1 }]) }))} />
    </SettingsCard>
    {(shifts.videoSigmaShift !== undefined || shifts.audioSigmaShift !== undefined) && <InfoBar severity="informational" message={`Active LoRA sigma shifts: ${[shifts.videoSigmaShift !== undefined ? `video ${shifts.videoSigmaShift}` : "", shifts.audioSigmaShift !== undefined ? `audio ${shifts.audioSigmaShift}` : ""].filter(Boolean).join(", ")}.`} />}
    <p className="settings-caption">Application order follows the LoRA library. Global LoRAs are always included.</p>
    {conflict ? <InfoBar severity="error" message={conflict} />
      : pika ? <InfoBar severity="informational" message="Pika H3 Flex fixes generation to six re-noising evaluations and turns off MotionCache. Use FL2VA with First/Last Frame generators and Ref2VA with References generators." />
      : dmad ? <InfoBar severity="informational" message="DMAD fixes generation to four re-noising evaluations and turns off MotionCache." />
      : stepOverride !== undefined && <InfoBar severity="informational" message={`Active LoRAs set the scene's step count to ${stepOverride}, the highest selected override.`} />}
  </SettingsGroup>;
}
