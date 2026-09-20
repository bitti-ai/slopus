import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPreviewCompositor, type Compositor } from "../../lib/exportPipeline";
import { presentPreviewFrame, type PreviewMedia } from "../../lib/previewPresentation";
import type { TimelineClip } from "../../lib/project";

/** A persistent presentation surface: media elements may come and go, but a
 * cut never removes the canvas containing the last complete picture. */
export function ProgramPicture({ media, layers, playheadMs, width, height, background, onAvailable }: {
  media: PreviewMedia;
  layers: TimelineClip[];
  playheadMs: number;
  width: number;
  height: number;
  background: string;
  onAvailable: (available: boolean) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef({ layers, playheadMs, onAvailable });
  current.current = { layers, playheadMs, onAvailable };
  const redraw = useRef<(() => void) | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    let live = true;
    let compositor: Compositor | null = null;
    const draw = () => {
      if (!live || !compositor) return;
      try { presentPreviewFrame(compositor, media, current.current.layers, current.current.playheadMs); }
      catch (reason) { setError(String(reason)); }
    };
    const unsubscribe = media.subscribe(draw);
    redraw.current = draw;
    setError(null);
    void createPreviewCompositor(canvas.current, width, height, background).then((created) => {
      if (!live) { created?.dispose(); return; }
      compositor = created;
      draw();
      setAvailable(Boolean(created));
      current.current.onAvailable(Boolean(created));
    }, () => {
      // Preserve the existing native-media preview on machines without WebGPU.
      if (live) { setAvailable(false); current.current.onAvailable(false); }
    });
    return () => {
      live = false;
      redraw.current = null;
      unsubscribe();
      compositor?.dispose();
    };
  }, [media, width, height, background]);
  useLayoutEffect(() => redraw.current?.(), [layers, playheadMs]);
  return <>
    <canvas ref={canvas} className="program-composited-picture" aria-label="Video preview" style={{ visibility: available ? "visible" : "hidden" }} />
    {available && error && <div className="program-note program-note--error" role="alert">{error}</div>}
  </>;
}
