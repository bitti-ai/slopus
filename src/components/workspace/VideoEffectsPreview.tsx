import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { createVideoEffectsPreview, type GpuEffects } from "../../lib/videoEffectsGpu";

export function VideoEffectsPreview({ source, sourceUrl, effects, playing, style, onError }: {
  source: RefObject<HTMLVideoElement | HTMLImageElement>;
  sourceUrl: string;
  effects: GpuEffects;
  playing: boolean;
  style?: CSSProperties;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settings = useRef(effects);
  const errorHandler = useRef(onError);
  const redraw = useRef<(() => void) | null>(null);
  settings.current = effects;
  errorHandler.current = onError;
  useEffect(() => {
    const media = source.current;
    if (!canvas.current || !media) return;
    let live = true, failed = false, animation = 0, videoFrame = 0;
    let renderer: Awaited<ReturnType<typeof createVideoEffectsPreview>> | undefined;
    const video = media instanceof HTMLVideoElement ? media : null;
    const draw = () => {
      if (!live || failed) return;
      try { renderer?.draw(media, settings.current); }
      catch (reason) { failed = true; errorHandler.current(String(reason)); }
    };
    const schedule = () => {
      if (!live || failed || !playing) return;
      if (video?.requestVideoFrameCallback) videoFrame = video.requestVideoFrameCallback(() => { draw(); schedule(); });
      else animation = requestAnimationFrame(() => { draw(); schedule(); });
    };
    redraw.current = draw;
    const events = ["loadeddata", "seeked", "load"];
    events.forEach((event) => media.addEventListener(event, draw));
    void createVideoEffectsPreview(canvas.current).then((created) => {
      if (!live) { created.dispose(); return; }
      renderer = created;
      draw(); schedule();
    }, (reason) => { if (live) errorHandler.current(String(reason)); });
    return () => {
      live = false;
      cancelAnimationFrame(animation);
      if (videoFrame) video?.cancelVideoFrameCallback(videoFrame);
      redraw.current = null;
      events.forEach((event) => media.removeEventListener(event, draw));
      renderer?.dispose();
    };
  }, [source, sourceUrl, playing]);
  useEffect(() => redraw.current?.(), [effects]);
  return <canvas ref={canvas} className="program-keyed-picture" style={style} aria-label="Video effects preview" />;
}
