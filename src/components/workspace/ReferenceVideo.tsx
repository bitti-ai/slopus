import { Pause, Play, Scissors, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { readMediaFileUrl } from "../../lib/persistence";
import type { ProjectReference } from "../../lib/project";
import { editReferenceVideoTrim, initialReferenceVideoTrim, normalizeReferenceVideoTrim, referenceTime, type ReferenceVideoTrim, type TrimAction } from "../../lib/referenceVideoTrim";

type VideoOptions = NonNullable<ProjectReference["video"]>;

type ReferenceVideoProps = { folderPath: string; reference: ProjectReference; onChange: (video: VideoOptions) => void };

export function ReferenceVideo(props: ReferenceVideoProps) {
  const [open, setOpen] = useState(false);
  const start = props.reference.video?.startSeconds ?? 0;
  const length = props.reference.video?.durationSeconds ?? 15;
  return <>
    {!open && <div className="reference-trim__summary"><strong>{referenceTime(start)} – {referenceTime(start + length)}</strong><span>{Number(length.toFixed(2))} s selected</span></div>}
    <button type="button" className="secondary-button" onClick={() => setOpen(true)}><Scissors size={16} /> Edit video clip</button>
    {open && createPortal(<ReferenceVideoDialog {...props} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function ReferenceVideoDialog({ onClose, ...props }: ReferenceVideoProps & { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const workspace = document.querySelector<HTMLElement>(".references-view");
    const wasInert = workspace?.inert ?? false;
    if (workspace) workspace.inert = true;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (workspace) workspace.inert = wasInert;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return <div className="reference-video-dialog-overlay" onKeyDown={(event) => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), video[controls]') ?? []);
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }}>
    <div ref={dialog} className="reference-video-dialog" role="dialog" aria-modal="true" aria-labelledby="reference-video-heading">
      <header><h2 id="reference-video-heading">{props.reference.name} — Video clip</h2><button type="button" className="icon-button" aria-label="Close video clip settings" onClick={onClose}><X size={18} /></button></header>
      <div className="reference-video"><ReferenceVideoEditor {...props} /></div>
    </div>
  </div>;
}

function ReferenceVideoEditor({ folderPath, reference, onChange }: ReferenceVideoProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef({ reference, onChange });
  latest.current = { reference, onChange };
  const bar = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; action: TrimAction; x: number; width: number; trim: ReferenceVideoTrim; scrollLeft: number } | null>(null);
  const selectionPlayback = useRef(false);
  const frameCallback = useRef<number | null>(null);
  const previewEdge = useRef<"start" | "end">("start");
  useEffect(() => {
    let disposed = false;
    let owned: string | null = null;
    setUrl(null); setError(null); setSourceDuration(null); setPreviewing(false);
    selectionPlayback.current = false;
    previewEdge.current = "start";
    gesture.current = null;
    void readMediaFileUrl(folderPath, reference, "video/mp4").then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
      if (!value) setError("The source video is unavailable.");
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, reference.id, reference.sourcePath, reference.relativePath]);

  const trim = sourceDuration === null ? null : normalizeReferenceVideoTrim(reference.video ?? initialReferenceVideoTrim(sourceDuration), sourceDuration);
  const start = trim?.startSeconds ?? 0;
  const length = trim?.durationSeconds ?? 15;
  const end = start + length;
  useEffect(() => {
    const viewport = scroller.current, timeline = bar.current;
    if (!viewport || !timeline || !sourceDuration || gesture.current || !viewport.clientWidth) return;
    const scale = timeline.getBoundingClientRect().width / sourceDuration;
    const left = start * scale, right = end * scale;
    if (left < viewport.scrollLeft) viewport.scrollLeft = Math.max(0, left - 16);
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth + 16;
  }, [start, end, sourceDuration]);

  const stop = () => {
    selectionPlayback.current = false;
    if (frameCallback.current !== null) video.current?.cancelVideoFrameCallback?.(frameCallback.current);
    frameCallback.current = null;
    video.current?.pause();
    setPreviewing(false);
  };
  useEffect(() => {
    const element = video.current;
    return () => { if (frameCallback.current !== null) element?.cancelVideoFrameCallback?.(frameCallback.current); };
  }, [url]);
  useEffect(() => {
    stop();
    const time = previewEdge.current === "end" ? end : start;
    if (video.current && sourceDuration !== null && video.current.currentTime !== time) video.current.currentTime = time;
  }, [start, length]);

  const previewTrim = (action: TrimAction, selection: ReferenceVideoTrim) => {
    stop();
    previewEdge.current = action === "end" || action === "duration" ? "end" : "start";
    const time = selection.startSeconds + (previewEdge.current === "end" ? selection.durationSeconds : 0);
    if (video.current && video.current.currentTime !== time) video.current.currentTime = time;
  };
  const change = (action: TrimAction, value: number, original = trim) => {
    if (!original || sourceDuration === null) return;
    const next = editReferenceVideoTrim(original, sourceDuration, action, value);
    previewTrim(action, next);
    onChange({ ...next, includeAudio: reference.video?.includeAudio ?? true });
  };
  const checkPlayback = () => {
    const element = video.current;
    if (!element || !selectionPlayback.current) return;
    const settings = latest.current.reference.video;
    const limit = (settings?.startSeconds ?? start) + (settings?.durationSeconds ?? length);
    if (element.currentTime >= limit) { stop(); element.currentTime = limit; return; }
    if (element.requestVideoFrameCallback) frameCallback.current = element.requestVideoFrameCallback(checkPlayback);
  };
  const playSelection = async () => {
    const element = video.current;
    if (!element || !trim) return;
    if (previewing) { stop(); return; }
    element.currentTime = start;
    selectionPlayback.current = true; setPreviewing(true);
    try { await element.play(); if (selectionPlayback.current) checkPlayback(); }
    catch (reason) { stop(); setError(`Could not play the selection: ${String(reason)}`); }
  };
  const beginDrag = (event: PointerEvent, action: TrimAction) => {
    if (!trim || !bar.current || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const box = bar.current.getBoundingClientRect();
    if (!box.width) return;
    previewTrim(action, trim);
    gesture.current = { pointerId: event.pointerId, action, x: event.clientX, width: box.width, trim, scrollLeft: scroller.current?.scrollLeft ?? 0 };
    bar.current.setPointerCapture(event.pointerId);
  };
  const keyboard = (event: KeyboardEvent, action: TrimAction, value: number, min: number, max: number) => {
    const step = event.shiftKey ? 1 : .1;
    const next = event.key === "Home" ? min : event.key === "End" ? max
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? value - step
      : event.key === "ArrowRight" || event.key === "ArrowUp" ? value + step : null;
    if (next !== null) { event.preventDefault(); change(action, Math.round(next * 1000) / 1000); }
  };

  return <>
    {error && <p role="alert">{error}</p>}
    {!url && !error && <p>Loading video preview…</p>}
    {url && <video ref={video} className="reference-video-preview" src={url} controls preload="metadata" aria-label={`${reference.name} video preview`}
      muted={reference.video?.includeAudio === false}
      onLoadedMetadata={(event) => {
        const duration = event.currentTarget.duration;
        try {
          const settings = latest.current.reference.video;
          const normalized = normalizeReferenceVideoTrim(settings ?? initialReferenceVideoTrim(duration), duration);
          setSourceDuration(duration);
          event.currentTarget.currentTime = normalized.startSeconds;
          if (!settings || settings.startSeconds !== normalized.startSeconds || settings.durationSeconds !== normalized.durationSeconds) {
            latest.current.onChange({ ...normalized, includeAudio: settings?.includeAudio ?? true });
          }
        } catch (reason) { setError(String(reason)); }
      }}
      onTimeUpdate={(event) => {
        if (selectionPlayback.current && event.currentTarget.currentTime >= end) { stop(); event.currentTarget.currentTime = end; }
      }}
      onPause={() => { selectionPlayback.current = false; setPreviewing(false); }}
      onError={() => setError("This computer cannot preview this video codec.")} />}
    {trim && sourceDuration !== null && <div className="reference-trim" aria-label="Reference segment editor">
      <div className="reference-trim__summary"><strong>{referenceTime(start)} – {referenceTime(end)}</strong><span>{Number(length.toFixed(2))} s selected · 15 s max</span></div>
      <div ref={scroller} className="reference-trim__scroll" role="region" aria-label="Video trim timeline">
        <div className="reference-trim__track" style={{ minWidth: `${sourceDuration * 24}px` }}>
          <div ref={bar} className="reference-trim__bar" aria-label="Drag the selection or its edges"
            onPointerDown={(event) => {
              if (event.target !== event.currentTarget || event.button !== 0) return;
              const box = event.currentTarget.getBoundingClientRect();
              if (box.width) change("move", (event.clientX - box.left) / box.width * sourceDuration - length / 2);
            }}
            onPointerMove={(event) => {
              const drag = gesture.current;
              if (!drag || event.pointerId !== drag.pointerId) return;
              const viewport = scroller.current;
              if (viewport && viewport.clientWidth) {
                const bounds = viewport.getBoundingClientRect();
                if (event.clientX > bounds.right - 24) viewport.scrollLeft += 16;
                else if (event.clientX < bounds.left + 24) viewport.scrollLeft -= 16;
              }
              const delta = (event.clientX - drag.x + (viewport?.scrollLeft ?? 0) - drag.scrollLeft) / drag.width * sourceDuration;
              const original = drag.action === "end" ? drag.trim.startSeconds + drag.trim.durationSeconds : drag.trim.startSeconds;
              const maximum = sourceDuration - (drag.action === "move" ? drag.trim.durationSeconds : 0);
              const value = Math.max(0, Math.min(maximum, original + delta));
              change(drag.action, Math.round(value * 1000) / 1000, drag.trim);
            }}
            onPointerUp={() => { gesture.current = null; }}
            onPointerCancel={() => { gesture.current = null; }}
            onLostPointerCapture={() => { gesture.current = null; }}>
            <div className="reference-trim__selection" style={{ left: `${start / sourceDuration * 100}%`, width: `${length / sourceDuration * 100}%` }}>
              <button type="button" className="reference-trim__handle" role="slider" aria-label="Selection start" aria-valuemin={Math.max(0, end - 15)} aria-valuemax={end - 2} aria-valuenow={start} aria-valuetext={referenceTime(start)}
                onPointerDown={(event) => beginDrag(event, "start")} onKeyDown={(event) => keyboard(event, "start", start, Math.max(0, end - 15), end - 2)} />
              <button type="button" className="reference-trim__move" role="slider" aria-label="Move selection" aria-valuemin={0} aria-valuemax={sourceDuration - length} aria-valuenow={start} aria-valuetext={referenceTime(start)}
                onPointerDown={(event) => beginDrag(event, "move")} onKeyDown={(event) => keyboard(event, "move", start, 0, sourceDuration - length)}>Drag</button>
              <button type="button" className="reference-trim__handle" role="slider" aria-label="Selection end" aria-valuemin={start + 2} aria-valuemax={Math.min(sourceDuration, start + 15)} aria-valuenow={end} aria-valuetext={referenceTime(end)}
                onPointerDown={(event) => beginDrag(event, "end")} onKeyDown={(event) => keyboard(event, "end", end, start + 2, Math.min(sourceDuration, start + 15))} />
            </div>
          </div>
          <div className="reference-trim__ticks"><span>0:00</span><span>{referenceTime(sourceDuration)}</span></div>
        </div>
      </div>
      <div className="reference-trim__actions">
        <button type="button" className="secondary-button" onClick={() => void playSelection()}>{previewing ? <Pause size={14} /> : <Play size={14} />}{previewing ? "Pause selection" : "Play selection"}</button>
      </div>
      <label><input type="checkbox" checked={reference.video?.includeAudio ?? true}
        onChange={(event) => onChange({ ...trim, includeAudio: event.target.checked })} /> Include sound</label>
    </div>}
  </>;
}
