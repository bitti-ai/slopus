import { motionSchema } from "./motion";
import { evaluateMotion, type MotionUpdate } from "./motionEvaluation";

let source: string | undefined;
let update: MotionUpdate | undefined;
self.onmessage = async ({ data }) => {
  try {
    const motion = motionSchema.parse(data.motion);
    if (!Number.isFinite(data.time)) throw new Error("Invalid Motion time.");
    if (source !== motion.source) {
      const url = URL.createObjectURL(new Blob([motion.source], { type: "text/javascript" }));
      try {
        const module = await import(/* @vite-ignore */ url);
        if (typeof module.update !== "function") throw new Error("Export a synchronous update(context, draw) function.");
        update = module.update;
        source = motion.source;
      } finally { URL.revokeObjectURL(url); }
    }
    self.postMessage({ id: data.id, nodes: evaluateMotion(motion, data.time, update!) });
  } catch (reason) { self.postMessage({ id: data.id, error: reason instanceof Error ? reason.message : String(reason) }); }
};
