import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { createChromaKeyRenderer } from "../../lib/chromaKeyPreview";
import type { ClipChromaKey } from "../../lib/project";

export function ChromaKeyPreview({ source, sourceUrl, effect, playing, style, onError }: {
  source: RefObject<HTMLVideoElement | HTMLImageElement>;
  sourceUrl: string;
  effect: ClipChromaKey;
  playing: boolean;
  style?: CSSProperties;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const settings = useRef(effect);
  const running = useRef(playing);
  const updatePlayback = useRef<(() => void) | null>(null);
  running.current = playing;
  const errorHandler = useRef(onError);
  const redraw = useRef<(() => void) | null>(null);
  settings.current = effect;
  errorHandler.current = onError;
  useEffect(() => {
    const media = source.current;
    if (!canvas.current || !media) return;
    let frame = 0;
    let failed = false;
    let renderer: ReturnType<typeof createChromaKeyRenderer>;
    try { renderer = createChromaKeyRenderer(canvas.current); }
    catch (reason) { errorHandler.current(String(reason)); return; }
    const draw = () => {
      if (failed) return;
      try { renderer.draw(media, settings.current); }
      catch (reason) { failed = true; errorHandler.current(String(reason)); }
    };
    const animate = () => { draw(); if (!failed && running.current) frame = requestAnimationFrame(animate); };
    updatePlayback.current = () => {
      cancelAnimationFrame(frame);
      draw();
      if (running.current) frame = requestAnimationFrame(animate);
    };
    redraw.current = draw;
    ["loadeddata", "seeked", "load"].forEach((event) => media.addEventListener(event, draw));
    draw();
    if (running.current) frame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(frame);
      updatePlayback.current = null;
      redraw.current = null;
      ["loadeddata", "seeked", "load"].forEach((event) => media.removeEventListener(event, draw));
      renderer.dispose();
    };
  }, [source, sourceUrl]);
  useEffect(() => updatePlayback.current?.(), [playing]);
  useEffect(() => redraw.current?.(), [effect]);
  return <canvas ref={canvas} className="program-keyed-picture" style={style} aria-label="Chroma Key preview" />;
}
