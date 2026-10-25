import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CanvasMotionRenderer, MotionRuntime } from "../../lib/motionRuntime";
import type { Motion, MotionNode } from "../../lib/motion";
import type { PreviewMedia } from "../../lib/previewPresentation";

/** One in-flight evaluation per player. Rapid seeks coalesce to the latest
 * request, and obsolete frames never replace the current timeline position. */
export function MotionCanvas({ motion, time, style, media, playerKey, onFrame }: {
  motion: Motion; time: number; style?: CSSProperties; media?: PreviewMedia; playerKey?: string;
  onFrame?: (nodes: MotionNode[]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ motion, time, onFrame }); latest.current = { motion, time, onFrame };
  const lastFrame = useRef<MotionNode[] | null>(null);
  const request = useRef<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const runtime = new MotionRuntime();
    let live = true, busy = false, revision = 0;
    const draw = async () => {
      if (busy || !live || !canvas.current) return;
      busy = true;
      const version = revision, state = latest.current;
      try {
        const nodes = await runtime.evaluate(state.motion, state.time);
        if (!live || !canvas.current || (version !== revision && (state.motion !== latest.current.motion || Math.abs(state.time - latest.current.time) > 0.1))) return;
        const scale = Math.min(1, 1280 / Math.max(state.motion.width, state.motion.height));
        const width = Math.max(1, Math.round(state.motion.width * scale)), height = Math.max(1, Math.round(state.motion.height * scale));
        if (canvas.current.width !== width) canvas.current.width = width;
        if (canvas.current.height !== height) canvas.current.height = height;
        new CanvasMotionRenderer(canvas.current).render(nodes, state.motion.width, state.motion.height);
        if (playerKey) { media?.set(playerKey, canvas.current); media?.setMotionTime(playerKey, state.time); }
        media?.invalidate();
        lastFrame.current = nodes; latest.current.onFrame?.(nodes); setError(null);
      } catch (reason) { if (live && version === revision) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { busy = false; if (live && version !== revision) void draw(); }
    };
    request.current = () => { revision++; void draw(); };
    request.current();
    return () => { live = false; request.current = null; runtime.dispose(); if (playerKey) media?.set(playerKey, null); };
  }, [media, playerKey]);
  useEffect(() => request.current?.(), [motion, time]);
  useEffect(() => { if (lastFrame.current) onFrame?.(lastFrame.current); }, [onFrame]);
  return <><canvas ref={canvas} style={style} className="motion-canvas" aria-label="Motion preview" />
    {error && <div className="program-note program-note--error" role="alert">{error}</div>}</>;
}
