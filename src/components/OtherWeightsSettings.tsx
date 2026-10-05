import { useEffect, useState } from "react";
import { OTHER_WEIGHT_TEMPLATES, cancelOtherDownload, downloadOtherWeights, otherDownloadState, otherWeightPaths, refreshOtherWeights, subscribeOtherWeights } from "../lib/upscalers";
import { InfoBar, ProgressBar, SettingsCard, SettingsGroup } from "./ui";
import { Image20 } from "./ui/icons";

export function OtherWeightsSettings({ desktop }: { desktop: boolean }) {
  const [, refresh] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => subscribeOtherWeights(() => refresh((value) => value + 1)), []);
  useEffect(() => { void refreshOtherWeights().catch((reason) => setError(String(reason))); }, []);
  const paths = otherWeightPaths();
  const download = otherDownloadState();
  return <SettingsGroup heading="Other weights">
    {OTHER_WEIGHT_TEMPLATES.map((template) => {
      const ready = template.files.every((file) => paths[file.url]);
      const active = download?.active && download.templateId === template.id;
      return <SettingsCard key={template.id} icon={<Image20 />} header={template.name}
        description={active ? `Downloading ${download.file}` : ready ? "Ready for image and video export" : template.files.map((file) => file.name).join(" · ")}>
        {active ? <><ProgressBar value={download.progress} aria-label={`Downloading ${template.name} weights`} />
          <button type="button" onClick={() => void cancelOtherDownload().catch((reason) => setError(String(reason)))}>Cancel</button></>
          : <button type="button" className="secondary-button" disabled={!desktop || ready || download?.active}
            onClick={() => void downloadOtherWeights(template.id)}>{ready ? "Downloaded" : "Download"}</button>}
      </SettingsCard>;
    })}
    {(error || download?.error) && <InfoBar severity="error" title="Couldn’t download weights" message={error ?? download!.error!} />}
  </SettingsGroup>;
}
