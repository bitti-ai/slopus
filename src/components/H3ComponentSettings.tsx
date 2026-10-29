import { useState, useSyncExternalStore } from "react";
import { type H3ComponentTemplate, type H3ComponentType } from "../lib/h3Components";
import { isDownloadUrl, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings, type GeneratorTemplateSettings } from "../lib/settings";
import { chooseEnginePath } from "../lib/runtime";
import { downloadH3Component, getQueuedWeightDownloads, getWeightDownloadState, subscribeWeightDownloads } from "../lib/weightDownloads";
import { ComboBox, ContentDialog, InfoBar, SettingsCard, SettingsGroup } from "./ui";
import { Add20, Delete16, Download16, ModelFile20, TextFile20 } from "./ui/icons";
import { OpenableCard } from "./OpenableCard";
import { WeightSourcesEditor } from "./WeightSourcesEditor";

export function H3ComponentSettings({ settings, desktop }: { settings: GeneratorTemplateSettings; desktop: boolean }) {
  const [editing, setEditing] = useState<H3ComponentTemplate | null>(null);
  const library = settings.h3Components!;
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const queued = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  const add = (type: H3ComponentType) => setEditing({ id: `h3-component-${crypto.randomUUID()}`, name: "", type, path: "", sources: [] });
  const used = (entry: H3ComponentTemplate) => entry.id === library.defaultTextEncoderId || settings.templates.some((template) =>
    template.modelType === "minimax-h3" && (template.videoVaeId === entry.id || template.audioVaeId === entry.id));
  const remove = (id: string) => {
    const current = loadGeneratorTemplateSettings();
    saveGeneratorTemplateSettings({ ...current, h3Components: { ...current.h3Components!, templates: current.h3Components!.templates.filter((entry) => entry.id !== id) } });
  };
  const makeDefault = (defaultTextEncoderId: string) => {
    const current = loadGeneratorTemplateSettings();
    saveGeneratorTemplateSettings({ ...current, h3Components: { ...current.h3Components!, defaultTextEncoderId } });
  };
  return <>
    {([false, true] as const).map((encoders) => <SettingsGroup key={String(encoders)} heading={encoders ? "Text Encoders" : "VAEs"}>
      <SettingsCard icon={<Add20 />} header={encoders ? "Add a text encoder" : "Add a VAE"}
        description={encoders ? "The default text encoder is used whenever MiniMax H3 needs one. Missing files download with generators." : "Name video and audio VAEs, then select them in your generators."}>
        <button type="button" className="secondary-button" onClick={() => add(encoders ? "textEncoder" : "video")}>{encoders ? "New text encoder" : "New VAE"}</button>
      </SettingsCard>
      <div className="settings-card-list" role="list" aria-label={encoders ? "Text Encoders" : "VAEs"}>
        {library.templates.filter((entry) => (entry.type === "textEncoder") === encoders).map((entry) => {
          const active = download?.active && download.h3ComponentId === entry.id;
          const waiting = queued.some((item) => item.h3ComponentId === entry.id);
          const ready = entry.path && !isDownloadUrl(entry.path) && !isDownloadUrl(entry.tokenizer ?? "");
          return <OpenableCard key={entry.id} icon={encoders ? <TextFile20 /> : <ModelFile20 />} header={entry.name}
            openLabel={`Edit ${entry.name} ${encoders ? "text encoder" : "VAE"}`} onOpen={() => setEditing(entry)}
            description={waiting ? "Queued for download" : active ? "Downloading…" : `${encoders ? entry.id === library.defaultTextEncoderId ? "Used by default" : "Text encoder" : entry.type === "video" ? "Video" : "Audio"} · ${ready ? "Available" : "Download required"}`}
            actions={<>
              {encoders && entry.id !== library.defaultTextEncoderId && <button type="button" className="secondary-button" aria-label={`Set ${entry.name} as default`} onClick={() => makeDefault(entry.id)}>Set as default</button>}
              {!ready && <button type="button" className="icon-button" aria-label={`Download ${entry.name}`} disabled={!desktop || active || waiting || !entry.sources.length} onClick={() => void downloadH3Component(entry.id)}><Download16 /></button>}
              <button type="button" className="icon-button" aria-label={`Remove ${entry.name} template`} data-tooltip={used(entry) ? "This template is in use" : "Remove template"}
                disabled={used(entry) || Boolean(download?.active) || waiting} onClick={() => remove(entry.id)}><Delete16 /></button>
            </>} />;
        })}
      </div>
    </SettingsGroup>)}
    {editing && <ComponentEditor key={editing.id} initial={editing} desktop={desktop} onDone={() => setEditing(null)} />}
  </>;
}

function ComponentEditor({ initial, desktop, onDone }: { initial: H3ComponentTemplate; desktop: boolean; onDone: () => void }) {
  const [entry, setEntry] = useState(() => structuredClone(initial));
  const [error, setError] = useState<string | null>(null);
  const encoder = entry.type === "textEncoder";
  const updatePath = (path: string) => setEntry((current) => ({ ...current, path,
    sources: isDownloadUrl(path) ? [{ url: path.trim(), gpuModel: "", minVramGb: 0 }, ...current.sources.filter((source) => source.url !== current.path && source.url !== path.trim())] : current.sources }));
  const browse = async (tokenizer = false) => {
    try {
      const path = await chooseEnginePath({ id: tokenizer ? "tokenizer" : encoder ? "textEncoder" : entry.type === "video" ? "videoVae" : "audioVae",
        label: tokenizer ? "Tokenizer" : encoder ? "Text encoder weights" : "VAE weights", hint: "", directory: tokenizer, extensions: tokenizer ? [] : ["safetensors", "gguf", "bin"], required: !tokenizer });
      if (path) { if (tokenizer) setEntry((current) => ({ ...current, tokenizer: path })); else updatePath(path); }
    } catch (reason) { setError(String(reason)); }
  };
  const save = () => {
    const current = loadGeneratorTemplateSettings();
    const library = current.h3Components!;
    if (!entry.name.trim() || (!entry.path.trim() && !entry.sources.length)) { setError("Enter a name and a weight path or download URL."); return; }
    if (entry.type !== initial.type && current.templates.some((template) => template.videoVaeId === entry.id || template.audioVaeId === entry.id)) {
      setError("Select another VAE in generators using this template before changing its type."); return;
    }
    const saved = { ...entry, name: entry.name.trim(), path: entry.path.trim() || entry.sources[0]?.url || "" };
    if (saved.tokenizer !== initial.tokenizer) saved.tokenizerUrl = isDownloadUrl(saved.tokenizer ?? "") ? saved.tokenizer : undefined;
    // Preserve downloads completed while this dialog was open if their source was not edited.
    const latest = library.templates.find((item) => item.id === entry.id);
    saved.sources = saved.sources.map((source) => ({ ...source, downloadedPath: latest?.sources.find((item) => item.url === source.url)?.downloadedPath ?? source.downloadedPath }));
    if (latest && saved.path === initial.path) saved.path = latest.path;
    saveGeneratorTemplateSettings({ ...current, h3Components: { ...library,
      templates: latest ? library.templates.map((item) => item.id === entry.id ? saved : item) : [...library.templates, saved] } });
    onDone();
  };
  return <ContentDialog title={encoder ? "Text encoder template" : "VAE template"} width={640} primaryText="Save" onPrimary={save} closeText="Cancel" onClose={onDone} defaultButton="primary">
    <div className="lora-manual">
      <label>Name<input className="text-field" aria-label={encoder ? "Text encoder name" : "VAE name"} value={entry.name} onChange={(event) => setEntry({ ...entry, name: event.target.value })} /></label>
      {!encoder && <label>Type<ComboBox aria-label="VAE type" value={entry.type} options={[{ value: "video", label: "Video" }, { value: "audio", label: "Audio" }]} onChange={(type) => setEntry({ ...entry, type: type as "video" | "audio" })} /></label>}
      <label>Weight path or URL<span className="lora-manual__path"><input className="text-field" aria-label="Weight path or URL" value={entry.path} spellCheck={false} onChange={(event) => updatePath(event.target.value)} />
        <button type="button" className="secondary-button" disabled={!desktop} onClick={() => void browse()}>Browse…</button></span></label>
      {encoder && <label>Tokenizer (optional)<span className="lora-manual__path"><input className="text-field" aria-label="Text encoder tokenizer" value={entry.tokenizer ?? ""} onChange={(event) => setEntry({ ...entry, tokenizer: event.target.value })} />
        <button type="button" className="secondary-button" disabled={!desktop} onClick={() => void browse(true)}>Browse…</button></span></label>}
      <WeightSourcesEditor label={encoder ? "Text encoder" : "VAE"} sources={entry.sources} disabled={false} onChange={(sources) => setEntry({ ...entry, sources,
        path: !entry.path || isDownloadUrl(entry.path) ? sources.find((source) => source.url === entry.path)?.url ?? sources[0]?.url ?? "" : entry.path })} />
      {error && <InfoBar severity="error" message={error} />}
    </div>
  </ContentDialog>;
}
