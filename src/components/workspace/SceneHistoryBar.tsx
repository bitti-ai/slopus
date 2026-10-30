import { useEffect, useState } from "react";
import { Film16, Edit16, Delete16 } from "../ui/icons";
import { useContextMenu } from "../ui";
import { sceneHistory } from "../../lib/sceneHistory";
import { sceneMediaStartSeconds } from "../../lib/continuationMedia";
import type { GenerationJob, ProjectAsset } from "../../lib/project";
import { shotPoster } from "./ShotThumbnail";

function TakePoster({ folderPath, media }: { folderPath: string; media: ProjectAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true; setUrl(null);
    if (media.relativePath) void shotPoster(folderPath, media.relativePath, sceneMediaStartSeconds(media)).then(result => { if (live) setUrl(result.poster); }, () => {});
    return () => { live = false; };
  }, [folderPath, media.relativePath]);
  return url ? <img src={url} alt="" draggable={false} /> : <Film16 aria-hidden="true" />;
}

export function SceneHistoryBar({ job, assets, folderPath, onSelect, onMakePrimary, onRemove, onRemoveDraft }: {
  job: GenerationJob; assets: ProjectAsset[]; folderPath: string;
  onSelect?: (job: GenerationJob, id: string | null) => void;
  onMakePrimary?: (job: GenerationJob, id: string) => void;
  onRemove?: (job: GenerationJob, id: string) => void;
  onRemoveDraft?: (job: GenerationJob) => void;
}) {
  const history = sceneHistory(job, assets);
  const busy = ["queued", "generating", "ready"].includes(job.status);
  const menu = useContextMenu();
  const draftMenu = (source: Parameters<typeof menu.open>[0]) => menu.open(source, [{ id: "remove-draft", label: "Remove draft", icon: <Delete16 />, danger: true,
    disabled: busy || !onRemoveDraft || !history.versions.length,
    onSelect: () => onRemoveDraft?.(job) }], { "aria-label": `Draft actions for ${job.title}` });
  return <aside className="scene-history" aria-label={`Generation history for ${job.title}`}>
    {history.versions.map((version, index) => {
      const primary = version.id === history.primaryId;
      const open = (source: Parameters<typeof menu.open>[0]) => menu.open(source, [{ id: "primary", label: "Make Primary", disabled: busy || primary || !onMakePrimary,
        onSelect: () => onMakePrimary?.(job, version.id) }, { separator: true },
        { id: "remove", label: "Remove generation", icon: <Delete16 />, danger: true, disabled: busy && primary || !onRemove,
          onSelect: () => onRemove?.(job, version.id) }], { "aria-label": `Generation ${index + 1} actions` });
      return <button key={version.id} type="button" className="scene-history__take" disabled={busy ? primary || !onRemove : !onSelect && !onRemove}
        aria-label={`Generation ${index + 1}${primary ? " (Primary)" : ""} of ${job.title}`} aria-pressed={history.selectedId === version.id}
        data-tooltip={`Generation ${index + 1}${primary ? " - Primary" : ""}${version.upscaleFactor ? ` - Upscaled ${version.upscaleFactor}x (${version.media.width} × ${version.media.height})` : ""} - ${new Date(version.createdAt).toLocaleString()}`}
        onClick={() => { if (!busy) onSelect?.(job, version.id); }} onContextMenu={open} onKeyDown={event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); open(event); } }}>
        <span className="scene-history__picture"><TakePoster folderPath={folderPath} media={version.media} /></span>
        <span>{primary ? "Primary" : `Take ${index + 1}`}</span>
        {version.upscaleFactor && <span>{version.upscaleFactor}x upscale</span>}
      </button>;
    })}
    {(history.draft || !history.versions.length) && <button type="button" className="scene-history__take scene-history__draft" disabled={busy || !onSelect}
      aria-label={`Draft of ${job.title}`} aria-pressed={!history.selectedId} onClick={() => onSelect?.(job, null)}
      onContextMenu={draftMenu} onKeyDown={event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); draftMenu(event); } }}>
      <span className="scene-history__picture"><Edit16 aria-hidden="true" /></span><span>Draft</span>
    </button>}
    {menu.element}
  </aside>;
}
