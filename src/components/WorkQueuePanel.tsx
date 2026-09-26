import { Check16, Clock16, Dismiss16, Download16, Film16, Warning16, WorkQueue32 } from "./ui/icons";
import { useState, useSyncExternalStore, type RefObject } from "react";
import { GENERATION_FRAME_RATE } from "../lib/project";
import { isWorkActive, type WorkItem, type WorkQueue } from "../lib/workQueue";
import { loadGeneratorTemplateSettings } from "../lib/settings";
import { cancelExportJob, exportFraction, useExportJob } from "../lib/exportJob";
import { cancelWeightDownload, retryWeightDownload, getWeightDownloadState, subscribeWeightDownloads, weightDownloadProgress } from "../lib/weightDownloads";
import { Flyout, ProgressBar, ProgressRing } from "./ui";

/* The work queue, as a flyout hanging from its title-bar button: no scrim, no
   focus trap, light dismiss (a click outside, Esc, the window losing focus).
   One flat list — what is running, the weight download, what is up next,
   what has finished — each row an icon, a title, one caption line and, while
   it runs, a 3px bar. The render settings a row was queued with sit in its
   tooltip rather than on a third line. */

const settingsLine = (item: WorkItem) => `${item.settings.canvasWidth} × ${item.settings.canvasHeight} · ${item.kind === "reference-icons" ? "JPG icons" : item.kind === "image" ? "JPG image" : `${(item.settings.frames / GENERATION_FRAME_RATE).toFixed(1)}s`} · ${item.settings.steps} steps · ${item.settings.seed === -1 ? "Random seed" : `Seed ${item.settings.seed}`}`;

function StateGlyph({ item }: { item: WorkItem }) {
  if (item.status === "completed") return <Check16 />;
  if (item.status === "failed") return <Warning16 />;
  if (item.status === "queued") return <Clock16 />;
  if (item.status === "cancelled") return <Dismiss16 />;
  return <ProgressRing size={16} />;
}

export function WorkQueuePanel({ queue, items, open = true, anchor = null, onClose }: {
  queue: WorkQueue;
  items: readonly WorkItem[];
  /** Default true, so it can be rendered conditionally. */
  open?: boolean;
  /** The title-bar button it hangs from. */
  anchor?: RefObject<HTMLElement | null> | null;
  onClose: () => void;
}) {
  // Downloads are observed here, never enqueued in the GPU generation scheduler.
  const download = useSyncExternalStore(subscribeWeightDownloads, getWeightDownloadState);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadName = download ? download.name ?? loadGeneratorTemplateSettings().templates.find((template) => template.id === download.templateId)?.name ?? "Generator weights" : "";
  /* A running export lives in lib/exportJob.ts, not in the generation queue;
     it is shown here so it can be followed (and stopped) from anywhere. */
  const exportJob = useExportJob();
  const exporting = exportJob.progress;
  const exportTitle = exportJob.projectName ? `Export ${exportJob.projectName}` : "Export";
  const exportPercent = Math.floor(exportFraction(exporting) * 100);
  const current = items.filter((item) => isWorkActive(item) && item.status !== "queued");
  const upcoming = items.filter((item) => item.status === "queued").sort((a, b) => Number(a.kind === "reference-icons") - Number(b.kind === "reference-icons"));
  const finished = items.filter((item) => !isWorkActive(item)).slice().reverse();

  const row = (item: WorkItem) => {
    const running = isWorkActive(item) && item.status !== "queued";
    return <li className="work-queue__row" key={item.id}>
      <span className={`work-queue__state work-queue__state--${item.status}`} aria-hidden="true"><StateGlyph item={item} /></span>
      <div className="work-queue__text">
        <span className="work-queue__title" data-tooltip={`${item.title} — ${settingsLine(item)}`}>{item.title}</span>
        <span className="work-queue__caption" data-tooltip={item.folderPath}>{item.projectName} · {item.detail}{running ? ` · ${Math.floor(item.progress * 100)}%` : ""}</span>
        {running && <ProgressBar value={item.progress * 100} aria-label={`${item.title} progress`} className="work-queue__progress" />}
        {item.error && <span className="work-queue__error">{item.error}</span>}
        {item.needsSave && <button type="button" className="work-queue__link" onClick={() => void queue.retrySave(item.id)}>Retry project save</button>}
      </div>
      {isWorkActive(item) && item.status !== "encoding" && (
        <button type="button" className="icon-button work-queue__cancel" disabled={item.cancelling} aria-label={`Cancel ${item.title} in ${item.projectName}`} data-tooltip="Cancel" onClick={() => void queue.cancel(item.id)}><Dismiss16 /></button>
      )}
    </li>;
  };

  return (
    <Flyout open={open} anchor={anchor} onClose={onClose} placement="bottom" aria-labelledby="work-queue-title" className="work-queue" width={360}>
      <header className="work-queue__header">
        <h2 id="work-queue-title">Work queue</h2>
        {finished.length > 0 && <button type="button" className="work-queue__link" onClick={() => queue.clearFinished()}>Clear finished</button>}
      </header>
      <div className="work-queue__list">
        {items.length === 0 && !download && !exporting && <div className="work-queue__empty"><WorkQueue32 aria-hidden="true" /><strong>No work yet</strong><span>Generated scenes and images show up here.</span></div>}
        {current.length > 0 && <section aria-label="In progress"><ul>{current.map(row)}</ul></section>}
        {exporting && <section aria-label="Export"><ul><li className="work-queue__row">
          <span className="work-queue__state work-queue__state--preparing" aria-hidden="true"><Film16 /></span>
          <div className="work-queue__text">
            <span className="work-queue__title" data-tooltip={exportJob.destination ?? undefined}>{exportTitle}</span>
            <span className="work-queue__caption">{exporting.detail || "Exporting"} · {exportPercent}%</span>
            <ProgressBar value={exportPercent} aria-label={`${exportTitle} progress`} className="work-queue__progress" />
          </div>
          <button type="button" className="icon-button work-queue__cancel" aria-label={`Cancel ${exportTitle}`} data-tooltip="Cancel" disabled={exportJob.cancelling} onClick={cancelExportJob}><Dismiss16 /></button>
        </li></ul></section>}
        {download && <section aria-label="Weight downloads"><ul><li className="work-queue__row">
          <span className={`work-queue__state work-queue__state--${download.active ? "preparing" : download.error ? "failed" : "completed"}`} aria-hidden="true">
            {download.active ? <Download16 /> : download.error ? <Warning16 /> : <Check16 />}
          </span>
          <div className="work-queue__text">
            <span className="work-queue__title">{downloadName}</span>
            <span className="work-queue__caption">
              {download.loraId ? "LoRA download" : "Weight download"} · {download.active
                ? `${download.completed}/${download.files} files · ${(download.downloaded / 1024 ** 3).toFixed(2)} GB${download.total ? ` of ${(download.total / 1024 ** 3).toFixed(2)} GB` : ""} · ${Math.floor(weightDownloadProgress(download))}%`
                : download.error ? "Failed" : "Download complete"}
            </span>
            {download.active && <ProgressBar value={weightDownloadProgress(download)} aria-label={`${downloadName} download progress`} className="work-queue__progress" />}
            {download.error && <span className="work-queue__error">{download.error}</span>}
            {download.error && <button type="button" className="work-queue__link" onClick={() => { setDownloadError(null); void retryWeightDownload(); }}>Retry download</button>}
            {downloadError && <span className="work-queue__error" role="alert">{downloadError}</span>}
          </div>
          {download.active && <button type="button" className="icon-button work-queue__cancel" aria-label={`Cancel ${downloadName} download`} data-tooltip="Cancel" onClick={() => {
            setDownloadError(null);
            void cancelWeightDownload().catch((reason) => setDownloadError(String(reason)));
          }}><Dismiss16 /></button>}
        </li></ul></section>}
        {upcoming.length > 0 && <section aria-label="Upcoming work"><h3 className="work-queue__group">Up next · {upcoming.length}</h3><ul>{upcoming.map(row)}</ul></section>}
        {finished.length > 0 && <section aria-label="Finished work"><h3 className="work-queue__group">Finished</h3><ul>{finished.map(row)}</ul></section>}
      </div>
    </Flyout>
  );
}
