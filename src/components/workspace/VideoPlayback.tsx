import { useEffect, useRef, useState, type CSSProperties } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import { sceneDurationSeconds, type ProjectConfig, type ProjectVideo } from "../../lib/project";
import { scenePreviewAsset } from "../../lib/sceneHistory";
import { sceneMediaStartSeconds, sceneMediaDurationMs } from "../../lib/continuationMedia";
import { videoScenes } from "../../lib/videoLibrary";
import { Dismiss16, Pause20, Play20Filled } from "../ui/icons";

export function videoPlaylist(video: ProjectVideo, config: ProjectConfig) {
  return videoScenes(video, config).flatMap((scene) => {
    const asset = scenePreviewAsset(scene, config.assets);
    if (!asset?.relativePath) return [];
    const start = sceneMediaStartSeconds(asset);
    const duration = Math.min(sceneDurationSeconds(scene), (sceneMediaDurationMs(asset) ?? sceneDurationSeconds(scene) * 1000) / 1000);
    return [{ sceneId: scene.id, title: scene.title, asset, start, end: start + duration }];
  });
}

/** Plays each scene's own range, excluding retained continuation prefixes. */
export function VideoPlayback({ video: item, config, folderPath, popout, onClose }: {
  video: ProjectVideo; config: ProjectConfig; folderPath: string; popout: boolean; onClose: () => void;
}) {
  const playlist = videoPlaylist(item, config);
  const [index, setIndex] = useState(0), [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false), [ended, setEnded] = useState(false), [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const media = useRef<HTMLVideoElement>(null), frame = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const timer = useRef<number>(), moving = useRef(false), epoch = useRef(0);
  const current = playlist[index];
  const advance = () => {
    if (moving.current) return;
    moving.current = true; clearTimeout(timer.current); media.current?.pause();
    if (index + 1 < playlist.length) setIndex(index + 1);
    else { setEnded(true); setPlaying(false); }
  };
  const play = async (restart = false) => {
    const player = media.current;
    if (!player || !current || !url) return;
    if (restart || player.currentTime < current.start || player.currentTime >= current.end - 0.02) player.currentTime = current.start;
    moving.current = false; setEnded(false); setError(null); clearTimeout(timer.current);
    const token = ++epoch.current;
    try {
      await player.play();
      if (token !== epoch.current) return;
      setPlaying(true);
      timer.current = window.setTimeout(advance, Math.max(0, (Math.min(current.end, player.duration || current.end) - player.currentTime) * 1000));
    } catch { if (token === epoch.current) { setPlaying(false); setError("Could not play this scene. Try replaying it."); } }
  };
  useEffect(() => {
    let disposed = false, owned: string | null = null;
    epoch.current++; moving.current = false; setUrl(null); setError(null); setPlaying(false);
    const player = media.current; player?.pause(); clearTimeout(timer.current);
    if (current) void readMediaFileUrl(folderPath, current.asset, "video/mp4").then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value); if (!value) setError("This scene's video is unavailable.");
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; epoch.current++; clearTimeout(timer.current); player?.pause(); if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, current?.sceneId, current?.asset.relativePath]);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (popout) frame.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close.current(); } };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); if (popout && focused?.isConnected) focused.focus(); };
  }, [popout]);
  const player = <div className={popout ? "shot-popout__frame" : "video-card__player"} ref={frame} tabIndex={-1}
    role={popout ? "dialog" : "group"} aria-label={`${item.title} preview`} style={{ "--shot-aspect": aspect } as CSSProperties}>
    <video ref={media} src={url ?? undefined} playsInline onLoadedMetadata={(event) => { if (url) { setAspect(event.currentTarget.videoWidth / event.currentTarget.videoHeight || 16 / 9); void play(true); } }}
      onTimeUpdate={(event) => { if (playing && current && event.currentTarget.currentTime >= current.end - 0.02) advance(); }} onEnded={advance}
      onError={() => { if (url) { clearTimeout(timer.current); setPlaying(false); setError("This scene could not be played."); } }} />
    <button type="button" className="shot-popout__close" aria-label="Close video preview" onClick={onClose}><Dismiss16 /></button>
    <button type="button" className="shot-popout__play" aria-label={`${playing ? "Pause" : "Replay"} ${item.title}`} disabled={!url} onClick={() => {
      if (playing) { epoch.current++; clearTimeout(timer.current); media.current?.pause(); setPlaying(false); }
      else if (ended && index !== 0) { setEnded(false); setIndex(0); } else void play(ended);
    }}>{playing ? <Pause20 /> : <Play20Filled />}</button>
    {error && <p className="shot-popout__message" role="alert">{error}</p>}
    <span className="video-card__position">{index + 1} / {playlist.length} · {current?.title}</span>
  </div>;
  return popout ? <div className="shot-popout" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{player}</div> : player;
}
