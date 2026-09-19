import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import type { ProjectReference } from "../../lib/project";
import { editReferenceVideoTrim, initialReferenceVideoTrim, normalizeReferenceVideoTrim, referenceTime, type ReferenceVideoTrim, type TrimAction } from "../../lib/referenceVideoTrim";

type VideoOptions = NonNullable<ProjectReference["video"]>;

function SecondsInput({ label, value, min, max, onChange }: {
  label: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(Math.round(value * 1000) / 1000)), [value]);
  return <label>{label}<input type="number" min={min} max={max} step="0.1" value={draft}
    onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
    onBlur={() => {
      const parsed = Number(draft);
      const next = draft.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : value;
      setDraft(String(next)); onChange(next);
    }} /></label>;
}

export function ReferenceVideo({ folderPath, reference, onChange }: {
  folderPath: string; reference: ProjectReference; onChange: (video: VideoOptions) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const latest = useRef({ reference, onChange });
  latest.current = { reference, onChange };
  const bar = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; action: TrimAction; x: number; width: number; trim: ReferenceVideoTrim; windowStart: number; windowDuration: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const selectionPlayback = useRef(false);
  const frameCallback = useRef<number | null>(null);
  const previewEdge = useRef<"start" | "end">("start");
  useEffect(() => {
    let disposed = false;
    let owned: string | null = null;
    setUrl(null); setError(null); setSourceDuration(null); setPreviewing(false);
    selectionPlayback.current = false;
    previewEdge.current = "start";
    gesture.current = null; setDragging(false);
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
  // A local ruler keeps handles usable even for hour-long sources; the
  // overview slider moves this window anywhere in the source.
  const windowDuration = dragging && gesture.current ? gesture.current.windowDuration : Math.min(sourceDuration ?? 30, 30);
  const windowStart = dragging && gesture.current ? gesture.current.windowStart : Math.max(0, Math.min((sourceDuration ?? 30) - windowDuration, start - (windowDuration - length) / 2));

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
    gesture.current = { pointerId: event.pointerId, action, x: event.clientX, width: box.width, trim, windowStart, windowDuration };
    bar.current.setPointerCapture(event.pointerId);
    setDragging(true);
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
      <label className="reference-trim__overview">Position in full video
        <input aria-label="Clip position" type="range" min="0" max={sourceDuration - length} step="any" value={start}
          disabled={sourceDuration === length} onChange={(event) => change("move", Number(event.target.value))} />
      </label>
      <div className="reference-trim__ticks"><span>0:00</span><span>Source {referenceTime(sourceDuration)}</span></div>
      <div ref={bar} className="reference-trim__bar" aria-label="Drag the selection or its edges"
        onPointerDown={(event) => {
          if (event.target !== event.currentTarget || event.button !== 0) return;
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width) change("move", windowStart + (event.clientX - box.left) / box.width * windowDuration - length / 2);
        }}
        onPointerMove={(event) => {
          const drag = gesture.current;
          if (!drag || event.pointerId !== drag.pointerId) return;
          const delta = (event.clientX - drag.x) / drag.width * drag.windowDuration;
          const original = drag.action === "end" ? drag.trim.startSeconds + drag.trim.durationSeconds : drag.trim.startSeconds;
          const maximum = drag.windowStart + drag.windowDuration - (drag.action === "move" ? drag.trim.durationSeconds : 0);
          const value = Math.max(drag.windowStart, Math.min(maximum, original + delta));
          change(drag.action, Math.round(value * 1000) / 1000, drag.trim);
        }}
        onPointerUp={() => { gesture.current = null; setDragging(false); }}
        onPointerCancel={() => { gesture.current = null; setDragging(false); }}
        onLostPointerCapture={() => { gesture.current = null; setDragging(false); }}>
        <div className="reference-trim__selection" style={{ left: `${(start - windowStart) / windowDuration * 100}%`, width: `${length / windowDuration * 100}%` }}>
          <button type="button" className="reference-trim__handle" role="slider" aria-label="Selection start" aria-valuemin={Math.max(0, end - 15)} aria-valuemax={end - 2} aria-valuenow={start} aria-valuetext={referenceTime(start)}
            onPointerDown={(event) => beginDrag(event, "start")} onKeyDown={(event) => keyboard(event, "start", start, Math.max(0, end - 15), end - 2)} />
          <button type="button" className="reference-trim__move" role="slider" aria-label="Move selection" aria-valuemin={0} aria-valuemax={sourceDuration - length} aria-valuenow={start} aria-valuetext={referenceTime(start)}
            onPointerDown={(event) => beginDrag(event, "move")} onKeyDown={(event) => keyboard(event, "move", start, 0, sourceDuration - length)}>Drag</button>
          <button type="button" className="reference-trim__handle" role="slider" aria-label="Selection end" aria-valuemin={start + 2} aria-valuemax={Math.min(sourceDuration, start + 15)} aria-valuenow={end} aria-valuetext={referenceTime(end)}
            onPointerDown={(event) => beginDrag(event, "end")} onKeyDown={(event) => keyboard(event, "end", end, start + 2, Math.min(sourceDuration, start + 15))} />
        </div>
      </div>
      <div className="reference-trim__ticks"><span>{referenceTime(windowStart)}</span><span>{referenceTime(windowStart + windowDuration)}</span></div>
      <p>Move the selection or drag its edges. Use the position slider to find a part anywhere in the video.</p>
      <div className="reference-trim__numbers">
        <SecondsInput label="Clip start (seconds)" value={start} min={0} max={sourceDuration - length} onChange={(value) => change("move", value)} />
        <SecondsInput label="Clip duration (seconds)" value={length} min={2} max={Math.min(15, sourceDuration - start)} onChange={(value) => change("duration", value)} />
      </div>
      <div className="reference-trim__actions">
        <button type="button" className="secondary-button" onClick={() => void playSelection()}>{previewing ? <Pause size={14} /> : <Play size={14} />}{previewing ? "Pause selection" : "Play selection"}</button>
        <button type="button" className="secondary-button" onClick={() => change("move", video.current?.currentTime ?? start)}>Start at playhead</button>
      </div>
      <label><input type="checkbox" checked={reference.video?.includeAudio ?? true}
        onChange={(event) => onChange({ ...trim, includeAudio: event.target.checked })} /> Include sound</label>
    </div>}
  </>;
}
