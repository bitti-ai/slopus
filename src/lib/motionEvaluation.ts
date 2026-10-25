import { applyMotionOverrides, motionNodeSchema, type Motion, type MotionNode } from "./motion";

export interface MotionContext { time: number; duration: number; width: number; height: number; parameters: Record<string, string | number | boolean>; nodes: MotionNode[]; random: () => number }
export type MotionDraw = Record<MotionNode["kind"], (node: Partial<MotionNode>) => void>;
export type MotionUpdate = (context: MotionContext, draw: MotionDraw) => void;

/** Pure evaluation contract shared by the worker and tests. A fresh scene and
 * seeded RNG on every request make seeking independent of playback order. */
export function evaluateMotion(motion: Motion, seconds: number, update: MotionUpdate): MotionNode[] {
  const nodes = structuredClone(motion.nodes);
  let state = motion.seed >>> 0;
  const draw = Object.fromEntries((["rect", "ellipse", "text", "path"] as const).map((kind) => [kind, (node: Partial<MotionNode>) => {
    if (nodes.length >= 1024) throw new Error("Motion exceeds 1024 drawing elements.");
    nodes.push(motionNodeSchema.parse({ id: `draw-${nodes.length}`, name: kind, ...node, kind }));
  }])) as MotionDraw;
  const result = update({ time: Math.max(0, Math.min(motion.duration, seconds)), duration: motion.duration,
    width: motion.width, height: motion.height, nodes,
    parameters: Object.fromEntries(motion.parameters.map((p) => [p.id, p.value])),
    random: () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; },
  }, draw);
  if (result !== undefined) throw new Error("Motion update must be synchronous and return nothing.");
  if (nodes.length > 1024) throw new Error("Motion exceeds 1024 drawing elements.");
  const checked = nodes.map((node) => motionNodeSchema.parse(node));
  if (new Set(checked.map((node) => node.id)).size !== checked.length) throw new Error("Motion drawing IDs must be unique.");
  return applyMotionOverrides(checked, motion);
}
