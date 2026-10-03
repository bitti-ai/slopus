import { Add16, Cut16, Delete14, Pause14, Play14 } from "../ui/icons";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ContentDialog, SelectorBar } from "../ui";
import { ReferenceImage } from "./ReferenceImage";
import { captureReferenceVideoFrame } from "../../lib/referenceVideoFrame";
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
    {!open && (props.reference.video?.mode === "frames"
      ? <div className="reference-trim__summary"><strong>Frames</strong><span>{props.reference.video.frames?.length ?? 0} frames selected</span></div>
      : <div className="reference-trim__summary"><strong>{referenceTime(start)} – {referenceTime(start + length)}</strong><span>{Number(length.toFixed(2))} s selected</span></div>)}
    <button type="button" className="secondary-button" onClick={() => setOpen(true)}><Cut16 /> Edit video clip</button>
    {open && <ReferenceVideoDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

/** Clip settings in a ContentDialog: the preview is large, so it is a modal
 *  rather than something squeezed into the inspector. */
function ReferenceVideoDialog({ onClose, ...props }: ReferenceVideoProps & { onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  return <ContentDialog title={`${props.reference.name} — Video clip`} closeText="Done" closeDisabled={saving} disableEscape={saving} onClose={onClose} width={1100} className="reference-video-dialog">
    <div className="reference-video"><ReferenceVideoEditor {...props} onSavingChange={setSaving} /></div>
  </ContentDialog>;
}

function ReferenceVideoEditor({ folderPath, reference, onChange, onSavingChange }: ReferenceVideoProps & { onSavingChange: (saving: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [position, setPosition] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const capturePending = useRef(false);
  const mode = reference.video?.mode ?? "video";
  const frames = reference.video?.frames ?? [];
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
    setUrl(null); setError(null); setSourceDuration(null); setPreviewing(false); setFrameReady(false); setPosition(0);
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
    if (mode === "frames") return;
    const time = previewEdge.current === "end" ? end : start;
    if (video.current && sourceDuration !== null && video.current.currentTime !== time) video.current.currentTime = time;
  }, [start, length, mode]);

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
    onChange({ ...reference.video, ...next, includeAudio: reference.video?.includeAudio ?? true });
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

  const seekFrame = (time: number) => {
    if (!video.current || !sourceDuration || !Number.isFinite(time)) return;
    stop();
    const next = Math.max(0, Math.min(sourceDuration, time));
    setPosition(next);
    if (video.current.currentTime !== next) {
      setFrameReady(false);
      video.current.currentTime = next;
    }
  };
  const addFrame = async () => {
    if (!video.current || !reference.video || capturePending.current || frames.length >= 9) return;
    const time = video.current.currentTime;
    if (frames.some((frame) => Math.abs(frame.timeSeconds - time) < .001)) return;
    capturePending.current = true;
    setCapturing(true); onSavingChange(true); setError(null);
    try {
      stop();
      const frame = await captureReferenceVideoFrame(folderPath, reference.name, video.current);
      const current = latest.current.reference.video;
      if (current) latest.current.onChange({ ...current, frames: [...(current.frames ?? []), frame].sort((a, b) => a.timeSeconds - b.timeSeconds) });
    } catch (reason) { setError(`Could not save the frame: ${String(reason)}`); }
    finally { capturePending.current = false; setCapturing(false); onSavingChange(false); }
  };

  return <>
    <SelectorBar aria-label="Reference mode" value={mode} items={[
      { value: "video", label: "Video", disabled: capturing }, { value: "frames", label: "Frames", disabled: capturing },
    ]} onChange={(next) => {
      stop();
      onChange({ startSeconds: 0, durationSeconds: 15, includeAudio: true, ...reference.video, mode: next });
    }} />
    {error && <p role="alert">{error}</p>}
    {!url && !error && <p>Loading video preview…</p>}
    {url && <video ref={video} className="reference-video-preview" src={url} controls preload="metadata" aria-label={`${reference.name} video preview`}
      muted={mode === "frames" || reference.video?.includeAudio === false}
      onLoadedMetadata={(event) => {
        const duration = event.currentTarget.duration;
        try {
          const settings = latest.current.reference.video;
          const normalized = normalizeReferenceVideoTrim(settings ?? initialReferenceVideoTrim(duration), duration);
          setSourceDuration(duration);
          event.currentTarget.currentTime = normalized.startSeconds;
          setPosition(normalized.startSeconds);
          if (!settings || settings.startSeconds !== normalized.startSeconds || settings.durationSeconds !== normalized.durationSeconds) {
            latest.current.onChange({ ...settings, ...normalized, includeAudio: settings?.includeAudio ?? true });
          }
        } catch (reason) { setError(String(reason)); }
      }}
      onTimeUpdate={(event) => {
        setPosition(event.currentTarget.currentTime);
        if (selectionPlayback.current && event.currentTarget.currentTime >= end) { stop(); event.currentTarget.currentTime = end; }
      }}
      onSeeking={() => setFrameReady(false)}
      onSeeked={(event) => { setPosition(event.currentTarget.currentTime); setFrameReady(event.currentTarget.readyState >= 2); }}
      onLoadedData={() => setFrameReady(true)}
      onPause={() => { selectionPlayback.current = false; setPreviewing(false); }}
      onError={() => { setFrameReady(false); setError("This computer cannot preview this video codec."); }} />}
    {mode === "frames" && <section className="reference-frames" aria-label="Reference frames">
      <p>Scrub the video and add the frames you want to use as image references. Select up to 9 frames.</p>
      {sourceDuration !== null && <>
        <input type="range" min={0} max={sourceDuration} step={.001} value={position} aria-label="Frame position" disabled={capturing}
          onChange={(event) => seekFrame(Number(event.target.value))} />
        <div className="reference-frames__actions">
          <label>Time (seconds)<input type="number" className="text-field" aria-label="Frame time in seconds" min={0} max={sourceDuration} step={.001} value={Number(position.toFixed(3))} disabled={capturing}
            onChange={(event) => seekFrame(event.target.valueAsNumber)} /></label>
          <button type="button" className="secondary-button" disabled={!frameReady || capturing || frames.length >= 9 || frames.some((frame) => Math.abs(frame.timeSeconds - position) < .001)} onClick={() => void addFrame()}>
            <Add16 />{capturing ? "Saving frame…" : "Add current frame"}
          </button>
          <span aria-live="polite">{frames.length} / 9 selected</span>
        </div>
      </>}
      {frames.length > 0 && <ul className="reference-frames__list">
        {frames.map((frame) => <li key={frame.id}>
          <button type="button" className="reference-frames__preview" disabled={capturing || sourceDuration === null} onClick={() => seekFrame(frame.timeSeconds)} aria-label={`Go to frame at ${referenceTime(frame.timeSeconds)}`}>
            <ReferenceImage folderPath={folderPath} relativePath={frame.relativePath} alt={frame.name} />
            <span>{referenceTime(frame.timeSeconds)}</span>
          </button>
          <button type="button" className="icon-button" disabled={capturing} aria-label={`Remove frame at ${referenceTime(frame.timeSeconds)}`}
            onClick={() => onChange({ ...reference.video!, frames: frames.filter((item) => item.id !== frame.id) })}><Delete14 /></button>
        </li>)}
      </ul>}
    </section>}
    {mode === "video" && trim && sourceDuration !== null && <div className="reference-trim" aria-label="Reference segment editor">
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
        <button type="button" className="secondary-button" onClick={() => void playSelection()}>{previewing ? <Pause14 /> : <Play14 />}{previewing ? "Pause selection" : "Play selection"}</button>
      </div>
      <label><input type="checkbox" checked={reference.video?.includeAudio ?? true}
        onChange={(event) => onChange({ ...reference.video, ...trim, includeAudio: event.target.checked })} /> Include sound</label>
    </div>}
  </>;
}
