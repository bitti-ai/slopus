import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import { Dismiss16, Pause20, Play20Filled } from "../ui/icons";

export const SHOT_PLAY_EVENT = "slopus:play-generated-shot";

/** A persistent shot player: reaching the cut leaves the frame open for replay. */
export function ShotPopout({ folderPath, relativePath, start, end, poster, title, onClose }: {
  folderPath: string; relativePath: string; start: number; end: number; poster: string; title: string; onClose: () => void;
}) {
  const id = useId();
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const active = useRef(false);
  const epoch = useRef(0);
  const timer = useRef<number>();
  const finished = useRef(false);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const clearTimer = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  const pause = (ended = false) => {
    epoch.current++; clearTimer(); video.current?.pause(); finished.current = ended; setPlaying(false);
  };
  const play = async () => {
    const media = video.current;
    if (!media || !url || !active.current) return;
    const cut = Math.min(end, Number.isFinite(media.duration) ? media.duration : end);
    if (start >= cut) { setError("This shot is outside the available video."); return; }
    if (finished.current || media.currentTime < start || media.currentTime >= cut - 0.02) media.currentTime = start;
    finished.current = false; setError(null); clearTimer();
    const request = ++epoch.current;
    try {
      await media.play();
      if (!active.current || request !== epoch.current) return;
      setPlaying(true);
      timer.current = window.setTimeout(() => pause(true), Math.max(0, (cut - media.currentTime) * 1000 / (media.playbackRate || 1)));
    } catch {
      if (active.current && request === epoch.current) { setPlaying(false); setError("Could not play this shot. Try replaying it."); }
    }
  };
  useEffect(() => {
    active.current = true;
    let owned: string | null = null;
    let disposed = false;
    const focused = document.activeElement as HTMLElement | null;
    const board = frame.current?.closest(".generator-board-viewport")?.querySelector<HTMLElement>(".generator-board");
    const wasInert = board?.hasAttribute("inert");
    board?.setAttribute("inert", "");
    frame.current?.focus();
    window.dispatchEvent(new CustomEvent<string>(SHOT_PLAY_EVENT, { detail: id }));
    const outside = (event: PointerEvent) => { if (!frame.current?.contains(event.target as Node)) close.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); } };
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) close.current(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener(SHOT_PLAY_EVENT, other);
    void readMediaFileUrl(folderPath, { relativePath }, "video/mp4").then(value => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
      if (!value) setError("This shot's video file is unavailable.");
    }).catch(() => { if (!disposed) setError("Could not open this shot's video file."); });
    const media = video.current;
    return () => {
      disposed = true; active.current = false; epoch.current++; clearTimer();
      media?.pause();
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener(SHOT_PLAY_EVENT, other);
      if (board && !wasInert) board.removeAttribute("inert");
      if (owned) URL.revokeObjectURL(owned);
      if (focused?.isConnected) focused.focus();
    };
  }, [folderPath, relativePath, id]);
  return <div className="shot-popout" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <div ref={frame} className="shot-popout__frame" role="dialog" aria-label={`${title} preview`} tabIndex={-1}
      style={{ "--shot-aspect": aspect } as CSSProperties}>
      <video ref={video} src={url ?? undefined} poster={poster} playsInline
        onLoadedMetadata={event => {
          if (!url) return;
          const media = event.currentTarget;
          if (media.videoWidth > 0 && media.videoHeight > 0) setAspect(media.videoWidth / media.videoHeight);
          media.currentTime = start;
          void play();
        }}
        onTimeUpdate={event => { if (event.currentTarget.currentTime >= end - 0.02) pause(true); }}
        onEnded={() => pause(true)} onError={() => { if (url) { pause(); setError("This shot's video could not be played."); } }} />
      <button type="button" className="shot-popout__close" aria-label="Close shot preview" onClick={onClose}><Dismiss16 /></button>
      <button type="button" className="shot-popout__play" disabled={!url} aria-label={`${playing ? "Pause" : "Replay"} ${title}`}
        onClick={() => { if (playing) pause(); else void play(); }}>{playing ? <Pause20 /> : <Play20Filled />}</button>
      {error ? <p className="shot-popout__message" role="alert">{error}</p> : !url && <p className="shot-popout__message" role="status">Opening video…</p>}
    </div>
  </div>;
}
