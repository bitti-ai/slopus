import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { clipFrameStyle, clipVisualSettings, type ClipFrameStyle } from "../../lib/export";
import { PreviewSources } from "../../lib/exportPipeline";
import type { ProjectAsset, TimelineClip } from "../../lib/project";
import { ChromaKeyPreview } from "./ChromaKeyPreview";
import { VideoEffectsPreview } from "./VideoEffectsPreview";
import { hasVideoEffects } from "../../lib/effectSettings";
import { isTauri } from "../../lib/persistence";

export function previewMediaStyle(frame: ClipFrameStyle): CSSProperties {
  const { transform, look, opacity, revealStart, revealEnd } = frame;
  const warmth = look.temperature / 100;
  return {
    transform: `translate(${transform.positionX}%, ${transform.positionY}%) scale(${transform.scale / 100}) rotate(${transform.rotation}deg)`,
    opacity,
    filter: warmth === 0 || hasVideoEffects(frame) ? "none" : `sepia(${Math.abs(warmth) * 0.22}) saturate(${1 + Math.abs(warmth) * 0.3}) hue-rotate(${warmth > 0 ? -8 : 172}deg)`,
    clipPath: `inset(0 ${(1 - revealEnd) * 100}% 0 ${revealStart * 100}%)`,
  };
}

/** Prepared clips keep their decoder and effect renderer when made visible. */
export function ProgramLayer({ clip, asset, sources, playheadMs, playing, active, foreground, muted, externalSeek, depth }: {
  clip: TimelineClip;
  asset: ProjectAsset | undefined;
  sources: PreviewSources;
  playheadMs: number;
  playing: boolean;
  active: boolean;
  foreground: boolean;
  muted: boolean;
  externalSeek: boolean;
  depth: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const position = useRef({ clip, playheadMs, playing, active, externalSeek });
  position.current = { clip, playheadMs, playing, active, externalSeek };
  const isImage = asset?.kind === "image" || asset?.mimeType.startsWith("image/");
  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    setReady(false);
    if (asset && (asset.relativePath || asset.sourcePath)) {
      void sources.url(asset).then((value) => { if (live) setUrl(value); }, (reason) => { if (live) setError(String(reason)); });
    } else setError(`Media for ${clip.label} is unavailable.`);
    return () => { live = false; };
  }, [asset, sources]);
  useEffect(() => {
    const element = video.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [url]);
  const sync = () => {
    const element = video.current;
    if (!element) return;
    const state = position.current;
    const run = state.playing && state.active;
    if (!run) element.pause();
    if (element.readyState < 1) return;
    const target = Math.max(0, (state.clip.sourceStartMs + state.playheadMs - state.clip.startMs) / 1000);
    // Upcoming players seek while paused. At a normal cut they can start
    // immediately without seeking again for a fraction of a display frame.
    // Explicit jumps still seek precisely, including during playback.
    const tolerance = run && !state.externalSeek ? 0.25 : 0.033;
    if (!element.seeking && Math.abs(element.currentTime - target) > tolerance) element.currentTime = target;
    if (run && element.paused) void element.play().catch(() => undefined);
  };
  useLayoutEffect(sync, [playheadMs, playing, active, externalSeek, clip, url]);
  const loaded = () => {
    sync();
    if (video.current) setReady(video.current.readyState >= 2 && !video.current.seeking);
  };
  const style = previewMediaStyle(clipFrameStyle(clipVisualSettings(clip), playheadMs - clip.startMs));
  const effects = hasVideoEffects(clip);
  const sourceStyle: CSSProperties = clip.chromaKey || effects ? { ...style, visibility: "hidden", position: "absolute" } : style;
  const showStatus = active && foreground && isTauri() && Boolean(asset?.relativePath || asset?.sourcePath);
  return <div className="program-layer" data-clip-id={clip.id} data-active={active} aria-hidden={!active}
    aria-label={`${foreground ? "Foreground" : "Background"} clip: ${clip.label}`}
    style={{ visibility: active ? "visible" : "hidden", zIndex: depth }}>
    {url && (isImage
      ? <img ref={image} src={url} alt={clip.label} style={sourceStyle} onError={() => setError(`Could not decode ${clip.label}.`)} />
      : <video key={url} ref={video} src={url} style={sourceStyle} muted={!active || muted} playsInline preload="auto"
        onLoadedMetadata={loaded} onLoadedData={loaded} onCanPlay={loaded} onSeeked={loaded}
        onError={() => setError(`Could not decode ${clip.label}.`)} />)}
    {url && effects && <VideoEffectsPreview source={isImage ? image : video} sourceUrl={url} effects={clip} playing={playing && active && !isImage} style={style} onError={setError} />}
    {url && !effects && clip.chromaKey && <ChromaKeyPreview source={isImage ? image : video} sourceUrl={url} effect={clip.chromaKey} playing={playing && active && !isImage} style={style} onError={setError} />}
    {showStatus && (error
      ? <div className="program-note program-note--error" role="alert">{error}</div>
      : (!url || (!ready && !isImage)) && <div className="program-note"><span>Loading {clip.label}…</span></div>)}
  </div>;
}
