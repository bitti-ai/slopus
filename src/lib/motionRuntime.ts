import { motionNodeSchema, type Motion, type MotionNode } from "./motion";

/** Scripts run off the UI thread. This is a responsiveness boundary, not an
 * OS security sandbox. No interpreter, compiler or external renderer. */
export class MotionRuntime {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, { resolve: (nodes: MotionNode[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  evaluate(motion: Motion, time: number): Promise<MotionNode[]> {
    if (!this.worker) {
      this.worker = new Worker(new URL("./motion.worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = ({ data }) => {
        const task = this.pending.get(data.id);
        if (!task) return;
        this.pending.delete(data.id); clearTimeout(task.timer);
        try {
          if (data.error) throw new Error(data.error);
          if (!Array.isArray(data.nodes) || data.nodes.length > 1024) throw new Error("Invalid Motion drawing output.");
          task.resolve(data.nodes.map((node: unknown) => motionNodeSchema.parse(node)));
        } catch (reason) { task.reject(reason instanceof Error ? reason : new Error(String(reason))); }
      };
      this.worker.onerror = (event) => this.dispose(new Error(event.message || "Motion script failed."));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error("Motion took too long. Simplify its script and try again.")), 3000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker!.postMessage({ id, motion, time }); }
      catch (reason) { this.pending.delete(id); clearTimeout(timer); reject(reason); }
    });
  }
  dispose(error = new Error("Motion closed.")) {
    this.worker?.terminate(); this.worker = null;
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
  }
}

export interface MotionRenderer { render(nodes: MotionNode[], width: number, height: number): void }
/** Portable 2D renderer. The resulting transparent surface is composited by
 * Slopus's WebGPU path, or Canvas 2D when WebGPU is unavailable. A future 3D
 * renderer can consume an extended scene without changing script scheduling. */
export class CanvasMotionRenderer implements MotionRenderer {
  constructor(private canvas: HTMLCanvasElement | OffscreenCanvas) {}
  render(nodes: MotionNode[], width: number, height: number) {
    const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error("Canvas rendering is unavailable for this Motion.");
    ctx.resetTransform(); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save(); ctx.scale(this.canvas.width / width, this.canvas.height / height);
    try { for (const node of nodes) {
      if (!node.visible) continue;
      ctx.save();
      try {
        ctx.translate(node.position[0], node.position[1]); ctx.rotate(node.rotation[2] * Math.PI / 180); ctx.scale(node.scale[0], node.scale[1]);
        ctx.globalAlpha = node.opacity; ctx.fillStyle = "#ffffff"; ctx.fillStyle = node.fill;
        ctx.strokeStyle = "transparent"; ctx.strokeStyle = node.stroke; ctx.lineWidth = node.strokeWidth;
        if (node.kind === "text") {
          ctx.font = `${node.fontSize}px ${node.fontFamily}`; ctx.textBaseline = "top";
          ctx.fillText(node.text, 0, 0, Math.max(1, Math.abs(node.width)));
        } else {
          const path = new Path2D(node.kind === "path" ? node.path : undefined);
          if (node.kind === "rect") path.rect(0, 0, node.width, node.height);
          if (node.kind === "ellipse") path.ellipse(node.width / 2, node.height / 2, Math.abs(node.width / 2), Math.abs(node.height / 2), 0, 0, 2 * Math.PI);
          ctx.fill(path); if (node.strokeWidth > 0) ctx.stroke(path);
        }
      } finally { ctx.restore(); }
    } } finally { ctx.restore(); }
  }
}

export function motionFrameReader(motion: Motion, check: () => void) {
  const runtime = new MotionRuntime();
  const canvas = new OffscreenCanvas(motion.width, motion.height);
  const renderer = new CanvasMotionRenderer(canvas);
  let frame: VideoFrame | null = null;
  return {
    async frameAt(timeUs: number) {
      check(); const nodes = await runtime.evaluate(motion, timeUs / 1e6); check();
      renderer.render(nodes, motion.width, motion.height);
      frame?.close(); frame = new VideoFrame(canvas, { timestamp: Math.round(timeUs), alpha: "keep" });
      return frame;
    },
    dispose() { runtime.dispose(); frame?.close(); frame = null; },
  };
}
