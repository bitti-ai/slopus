import { useEffect, useState, useSyncExternalStore } from "react";
import { OTHER_WEIGHT_TEMPLATES, otherWeightPaths, refreshOtherWeights, subscribeOtherWeights } from "../lib/upscalers";
import { cancelQueuedWeightDownload, cancelWeightDownload, downloadOtherWeights, getQueuedWeightDownloads, getWeightDownloadState, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";
import { InfoBar, ProgressBar, SettingsCard, SettingsGroup } from "./ui";
import { Image20 } from "./ui/icons";

export function OtherWeightsSettings({ desktop }: { desktop: boolean }) {
  const [, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeOtherWeights(() => refresh((value) => value + 1)), []);
  useEffect(() => { void refreshOtherWeights().catch((reason) => setError(String(reason))); }, []);
  const paths = otherWeightPaths();
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const queued = useSyncExternalStore(subscribeWeightDownloads, getQueuedWeightDownloads);
  return <SettingsGroup heading="Other weights">
    {OTHER_WEIGHT_TEMPLATES.map((template) => {
      const ready = template.files.every((file) => paths[file.url]);
      const active = download?.active && download.otherWeightId === template.id;
      const waiting = queued.find((item) => item.otherWeightId === template.id);
      return <SettingsCard key={template.id} icon={<Image20 />} header={template.name}
        description={waiting ? "Queued for download" : active ? `Downloading ${download.currentFile ?? template.name}` : ready ? "Ready for image and video export" : template.files.map((file) => file.name).join(" · ")}>
        {waiting ? <button type="button" onClick={() => cancelQueuedWeightDownload(waiting.templateId)}>Cancel</button>
          : active ? <><ProgressBar value={weightDownloadProgress(download)} aria-label={`Downloading ${template.name} weights`} />
          <button type="button" onClick={() => void cancelWeightDownload().catch((reason) => setError(String(reason)))}>Cancel</button></>
          : <button type="button" className="secondary-button" disabled={!desktop || ready}
            onClick={() => void downloadOtherWeights(template.id)}>{ready ? "Downloaded" : "Download"}</button>}
      </SettingsCard>;
    })}
    {(error || (download?.otherWeightId && download.error)) && <InfoBar severity="error" title="Couldn’t download weights" message={error ?? download!.error!} />}
  </SettingsGroup>;
}
