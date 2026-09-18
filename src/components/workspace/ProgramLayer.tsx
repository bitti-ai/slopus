import { useEffect, useRef, useState, type CSSProperties } from "react";
import { clipFrameStyle, clipVisualSettings, type ClipFrameStyle } from "../../lib/export";
import { PreviewSources } from "../../lib/exportPipeline";
import type { ProjectAsset, TimelineClip } from "../../lib/project";
import { ChromaKeyPreview } from "./ChromaKeyPreview";
import { VideoEffectsPreview } from "./VideoEffectsPreview";
import { hasVideoEffects } from "../../lib/effectSettings";

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

/** Lower picture tracks follow the monitor clock. Their audio is mixed by the
 * monitor's existing audio elements, so these video elements stay muted. */
export function ProgramLayer({ clip, asset, sources, playheadMs, playing }: {
  clip: TimelineClip;
  asset: ProjectAsset | undefined;
  sources: PreviewSources;
  playheadMs: number;
  playing: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const position = useRef({ clip, playheadMs, playing });
  position.current = { clip, playheadMs, playing };
  const isImage = asset?.mimeType.startsWith("image/");
  useEffect(() => {
    let live = true;
    setUrl(null);
    setError(null);
    if (asset && (asset.relativePath || asset.sourcePath)) {
      void sources.url(asset).then((value) => { if (live) setUrl(value); }, (reason) => { if (live) setError(String(reason)); });
    } else setError(`Media for ${clip.label} is unavailable.`);
    return () => { live = false; };
  }, [asset, sources, clip.label]);
  const sync = () => {
    const element = video.current;
    if (!element || element.readyState < 1) return;
    const state = position.current;
    const target = Math.max(0, (state.clip.sourceStartMs + state.playheadMs - state.clip.startMs) / 1000);
    if (Math.abs(element.currentTime - target) > (state.playing ? 0.25 : 0.033)) element.currentTime = target;
    if (state.playing) { if (element.paused) void element.play().catch(() => undefined); }
    else element.pause();
  };
  useEffect(sync, [playheadMs, playing, clip, url]);
  const style = previewMediaStyle(clipFrameStyle(clipVisualSettings(clip), playheadMs - clip.startMs));
  const effects = hasVideoEffects(clip);
  const sourceStyle: CSSProperties = clip.chromaKey || effects ? { ...style, visibility: "hidden", position: "absolute" } : style;
  return <div className="program-layer" aria-label={`Background clip: ${clip.label}`}>
    {url && (isImage
      ? <img ref={image} src={url} alt={clip.label} style={sourceStyle} onError={() => setError(`Could not decode ${clip.label}.`)} />
      : <video ref={video} src={url} style={sourceStyle} muted playsInline preload="auto" onLoadedMetadata={sync} onError={() => setError(`Could not decode ${clip.label}.`)} />)}
    {url && effects && <VideoEffectsPreview source={isImage ? image : video} sourceUrl={url} effects={clip} playing={playing && !isImage} style={style} onError={setError} />}
    {url && !effects && clip.chromaKey && <ChromaKeyPreview source={isImage ? image : video} sourceUrl={url} effect={clip.chromaKey} playing={playing && !isImage} style={style} onError={setError} />}
    {error && <div className="program-note program-note--error" role="alert">{error}</div>}
  </div>;
}
