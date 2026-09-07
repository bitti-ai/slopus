import { Check, Clock3, ListTodo, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { GENERATION_FRAME_RATE } from "../lib/project";
import { isWorkActive, type WorkItem, type WorkQueue } from "../lib/workQueue";

export function WorkQueuePanel({ queue, items, onClose }: { queue: WorkQueue; items: readonly WorkItem[]; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), summary, [tabindex='0']") ?? []);
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [onClose]);
  const current = items.filter((item) => isWorkActive(item) && item.status !== "queued");
  const upcoming = items.filter((item) => item.status === "queued").sort((a, b) => Number(a.kind === "reference-icons") - Number(b.kind === "reference-icons"));
  const finished = items.filter((item) => !isWorkActive(item)).slice().reverse();
  const row = (item: WorkItem) => <li className={`work-queue__item${isWorkActive(item) && item.status !== "queued" ? "" : " work-queue__item--compact"}`} key={item.id}>
    <div className="work-queue__item-heading">
      <span className={`work-queue__state work-queue__state--${item.status}`} aria-hidden="true">
        {item.status === "completed" ? <Check size={17} /> : item.status === "failed" ? <TriangleAlert size={17} /> : item.status === "queued" ? <Clock3 size={17} /> : item.status === "cancelled" ? <X size={17} /> : <LoaderCircle className="work-queue__spinner" size={17} />}
      </span>
      <div><strong title={item.title}>{item.title}</strong><span title={item.folderPath}>{item.projectName}</span></div>
      {isWorkActive(item) && item.status !== "encoding" && <button type="button" className="icon-button" disabled={item.cancelling} aria-label={`Cancel ${item.title} in ${item.projectName}`} title="Cancel this work" onClick={() => void queue.cancel(item.id)}><X size={16} /></button>}
    </div>
    <div className="work-queue__metadata">
      <div className="work-queue__detail"><span>{item.detail}</span>{isWorkActive(item) && item.status !== "queued" && <b>{Math.floor(item.progress * 100)}%</b>}</div>
      {isWorkActive(item) && item.status !== "queued" && <progress max={1} value={item.progress} aria-label={`${item.title} progress`} />}
      <p className="work-queue__settings">{item.settings.canvasWidth} × {item.settings.canvasHeight} · {item.kind === "reference-icons" ? "JPG icons" : `${(item.settings.frames / GENERATION_FRAME_RATE).toFixed(1)}s`} · {item.settings.steps} steps · {item.settings.seed === -1 ? "Random seed" : `Seed ${item.settings.seed}`}</p>
    </div>
    {item.error && <p className="work-queue__error">{item.error}</p>}
    {item.needsSave && <button type="button" className="secondary-button" onClick={() => void queue.retrySave(item.id)}>Retry project save</button>}
  </li>;
  return createPortal(<div className="work-queue-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="work-queue-panel" role="dialog" aria-modal="true" aria-labelledby="work-queue-title">
      <header className="work-queue__header"><div><ListTodo size={20} /><h2 id="work-queue-title">Work Queue</h2></div><button ref={close} type="button" className="icon-button icon-button--strong" aria-label="Close work queue" onClick={onClose}><X size={18} /></button></header>
      <p className="work-queue__intro">Work continues across projects, using the settings from when it was added.</p>
      <div className="work-queue__list">
        {items.length === 0 && <div className="work-queue__empty"><ListTodo size={28} /><strong>No work yet</strong><p>Generate a scene to add it to the queue.</p></div>}
        {current.length > 0 && <section aria-label="In progress"><h3>In progress</h3><ul>{current.map(row)}</ul></section>}
        {upcoming.length > 0 && <section aria-label="Upcoming work"><h3>Up next <span>{upcoming.length}</span></h3><ul>{upcoming.map(row)}</ul></section>}
        {finished.length > 0 && <section aria-label="Finished work"><h3>Finished <button type="button" onClick={() => queue.clearFinished()}>Clear</button></h3><ul>{finished.map(row)}</ul></section>}
      </div>
    </section>
  </div>, document.body);
}
