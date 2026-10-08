import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OTHER_WEIGHT_TEMPLATES, localOtherWeightPaths, otherWeightPaths, refreshOtherWeights, saveLocalOtherWeightPaths, subscribeOtherWeights } from "../lib/upscalers";
import { chooseEnginePath } from "../lib/runtime";
import { cancelQueuedWeightDownload, cancelWeightDownload, downloadOtherWeights, getQueuedWeightDownloads, getWeightDownloadState, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";
import { ContentDialog, InfoBar, ProgressBar, SettingsGroup } from "./ui";
import { OpenableCard } from "./OpenableCard";
import { Image20 } from "./ui/icons";
import "../styles/loras.css";

export function OtherWeightsSettings({ desktop }: { desktop: boolean }) {
  const [, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => subscribeOtherWeights(() => refresh((value) => value + 1)), []);
  useEffect(() => { void refreshOtherWeights().catch((reason) => setError(String(reason))); }, []);
  const paths = otherWeightPaths();
  const local = localOtherWeightPaths();
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const queued = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  return <SettingsGroup heading="Other weights">
    <div className="settings-card-list" role="list" aria-label="Other weights">
    {OTHER_WEIGHT_TEMPLATES.map((template) => {
      const ready = template.files.every((file) => paths[file.url]);
      const active = download?.active && download.otherWeightId === template.id;
      const waiting = queued.find((item) => item.otherWeightId === template.id);
      return <OpenableCard key={template.id} icon={<Image20 />} header={template.name}
        openLabel={`Edit ${template.name} weights`} onOpen={() => setEditing(template.id)}
        description={waiting ? "Queued for download" : active ? `Downloading ${download.currentFile ?? template.name}` : ready ? template.id === "latent-upscale" ? "Ready for scene generation" : "Ready for image and video export" : template.files.map((file) => file.name).join(" · ")}
        actions={<>
        {waiting ? <button type="button" onClick={() => cancelQueuedWeightDownload(waiting.templateId)}>Cancel</button>
          : active ? <><ProgressBar value={weightDownloadProgress(download)} aria-label={`Downloading ${template.name} weights`} />
          <button type="button" onClick={() => void cancelWeightDownload().catch((reason) => setError(String(reason)))}>Cancel</button></>
          : <button type="button" className="secondary-button" disabled={!desktop || ready}
            onClick={() => void downloadOtherWeights(template.id)}>{ready ? template.files.some((file) => local[file.url]) ? "Available" : "Downloaded" : "Download"}</button>}
        </>} />;
    })}
    </div>
    {(error || (download?.otherWeightId && download.error)) && <InfoBar severity="error" title="Couldn’t download weights" message={error ?? download!.error!} />}
    {editing && <OtherWeightEditor key={editing} template={OTHER_WEIGHT_TEMPLATES.find((item) => item.id === editing)!} desktop={desktop}
      busy={Boolean(download?.active && download.otherWeightId === editing) || queued.some((item) => item.otherWeightId === editing)} onDone={() => setEditing(null)} />}
  </SettingsGroup>;
}

function OtherWeightEditor({ template, desktop, busy, onDone }: {
  template: typeof OTHER_WEIGHT_TEMPLATES[number]; desktop: boolean; busy: boolean; onDone: () => void;
}) {
  const [paths, setPaths] = useState(localOtherWeightPaths);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const browse = async (file: typeof template.files[number]) => {
    try {
      const picked = await chooseEnginePath({ id: "transformer", label: file.name, hint: "", directory: false, extensions: ["safetensors"], required: false });
      if (picked) setPaths((current) => ({ ...current, [file.url]: picked }));
    } catch (reason) { setError(String(reason)); }
  };
  const save = async () => {
    const selected = Object.fromEntries(template.files.map((file) => [file.url, (paths[file.url] ?? "").trim()]));
    const files = Object.values(selected).filter(Boolean);
    if (files.some((path) => !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path) || path.includes("\0"))) {
      setError("Choose local weight files using their absolute paths."); return;
    }
    try {
      setSaving(true); setError(null);
      if (desktop && files.length) {
        const exists = await invoke<Record<string, boolean>>("check_weight_files", { paths: files });
        const missing = files.find((path) => !exists?.[path]);
        if (missing) throw new Error(`Weight file not found: ${missing}`);
      }
      saveLocalOtherWeightPaths(selected);
      onDone();
    } catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  };
  return <ContentDialog title={`${template.name} weights`} width={560} primaryText="Save" onPrimary={() => void save()}
    primaryDisabled={saving || busy} closeText="Cancel" onClose={onDone} defaultButton="primary" disableEscape={saving}>
    <fieldset className="lora-manual" disabled={saving || busy}>
      <p>Choose local files, or leave paths empty to use downloaded weights.</p>
      {template.files.map((file) => <label key={file.id}>{file.name}<span className="lora-manual__path">
        <input className="text-field" aria-label={`${file.name} path`} value={paths[file.url] ?? ""} spellCheck={false}
          onChange={(event) => setPaths({ ...paths, [file.url]: event.target.value })} placeholder="Absolute path to a .safetensors file" />
        <button className="secondary-button" type="button" disabled={!desktop} aria-label={`Browse for ${file.name}`} onClick={() => void browse(file)}>Browse…</button>
      </span></label>)}
      {template.id === "latent-upscale" && <p>Used by the Latent upscale toggle in scene Generation settings. Workers receive local files or download the standard weights.</p>}
      {template.id === "seedvr2" && <p>SeedVR2 runs locally or on the selected worker. Workers receive local files and download any weights without a local path.</p>}
      {error && <InfoBar severity="error" message={error} />}
    </fieldset>
  </ContentDialog>;
}
