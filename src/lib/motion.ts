import { z } from "zod";

const finite = z.number().finite().min(-1e6).max(1e6);
const vector = z.tuple([finite, finite, finite]);
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const motionNodeSchema = z.object({
  id, name: z.string().min(1).max(200),
  kind: z.enum(["rect", "ellipse", "text", "path"]),
  position: vector.default([0, 0, 0]), rotation: vector.default([0, 0, 0]), scale: vector.default([1, 1, 1]),
  width: finite.default(100), height: finite.default(100), opacity: z.number().min(0).max(1).default(1),
  visible: z.boolean().default(true), fill: z.string().max(100).default("#ffffff"),
  stroke: z.string().max(100).default("transparent"), strokeWidth: z.number().min(0).max(1000).default(0),
  text: z.string().max(10000).default(""), fontSize: z.number().min(1).max(1000).default(48),
  fontFamily: z.enum(["sans-serif", "serif", "monospace"]).default("sans-serif"),
  path: z.string().max(50000).default(""),
});
export type MotionNode = z.infer<typeof motionNodeSchema>;
export const motionOverrideSchema = z.object({
  offset: vector.default([0, 0, 0]), scale: vector.default([1, 1, 1]), rotation: vector.default([0, 0, 0]),
  fill: z.string().max(100).optional(), text: z.string().max(10000).optional(),
});
export type MotionOverride = z.infer<typeof motionOverrideSchema>;
const parameterSchema = z.object({
  id, label: z.string().min(1).max(200), type: z.enum(["number", "string", "color", "boolean"]),
  value: z.union([finite, z.string().max(10000), z.boolean()]),
  min: finite.optional(), max: finite.optional(), step: z.number().positive().max(1e6).optional(),
}).superRefine((p, ctx) => {
  if (typeof p.value !== (p.type === "number" ? "number" : p.type === "boolean" ? "boolean" : "string")
    || p.min !== undefined && p.max !== undefined && p.min > p.max
    || typeof p.value === "number" && (p.min !== undefined && p.value < p.min || p.max !== undefined && p.value > p.max))
    ctx.addIssue({ code: "custom", message: "Motion parameter value must match its type and range." });
});
/** Versioned scene description, independent of Canvas/WebGPU. Three-component
 * transforms leave a migration path to mesh/camera primitives; v1 is 2D. */
export const motionSchema = z.object({
  version: z.literal(1), space: z.literal("2d"),
  width: z.number().int().min(32).max(4096), height: z.number().int().min(32).max(4096),
  duration: z.number().finite().min(0.1).max(600), seed: z.number().int().min(0).max(0xffffffff).default(1),
  source: z.string().max(200000), nodes: z.array(motionNodeSchema).max(512),
  parameters: z.array(parameterSchema).max(100),
  overrides: z.record(motionOverrideSchema).default({}),
}).superRefine((motion, ctx) => {
  for (const entries of [motion.nodes, motion.parameters]) {
    if (new Set(entries.map(({ id }) => id)).size !== entries.length) ctx.addIssue({ code: "custom", message: "Motion IDs must be unique." });
  }
  if (Object.keys(motion.overrides).some((id) => !motion.nodes.some((node) => node.id === id)))
    ctx.addIssue({ code: "custom", message: "Motion overrides must refer to scene elements." });
});
export type Motion = z.infer<typeof motionSchema>;
export const MOTION_MIME = "application/x-slopus-motion";
export function emptyMotion(width = 1280, height = 720): Motion {
  return motionSchema.parse({ version: 1, space: "2d", width, height, duration: 5, nodes: [], parameters: [],
    source: "// Ask the agent to create this Motion.\n// Time is in seconds. Modify named nodes or add primitives with draw.\nexport function update({ time, duration, parameters, nodes }, draw) {\n}\n" });
}
export const motionOverride = (motion: Motion, id: string): MotionOverride => motion.overrides[id] ?? motionOverrideSchema.parse({});
export function applyMotionOverrides(nodes: MotionNode[], motion: Motion): MotionNode[] {
  return nodes.map((node) => {
    const edit = motion.overrides[node.id];
    if (!edit) return node;
    return { ...node, position: node.position.map((v, i) => v + edit.offset[i]) as MotionNode["position"],
      rotation: node.rotation.map((v, i) => v + edit.rotation[i]) as MotionNode["rotation"],
      scale: node.scale.map((v, i) => v * edit.scale[i]) as MotionNode["scale"],
      ...(edit.fill !== undefined ? { fill: edit.fill } : {}), ...(edit.text !== undefined ? { text: edit.text } : {}) };
  });
}
