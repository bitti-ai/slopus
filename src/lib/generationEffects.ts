import { z } from "zod";

const enabled = z.boolean().optional();
const scalar = (min: number, max: number) => z.number().finite().min(min).max(max);
export const generationEffectsSchema = z.object({
  color: z.object({ enabled, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), strength: scalar(0, 2), mode: z.enum(["interpolated", "type_i", "type_ii"]) }).strict().optional(),
  tone: z.object({ enabled, contrast: scalar(0, 4), brightness: scalar(-1, 1), saturation: scalar(0, 4), temperature: scalar(-1, 1) }).strict().optional(),
  sharpness: z.object({ enabled, strength: scalar(-5, 5) }).strict().optional(),
  anchor: z.object({ enabled, mode: z.enum(["self", "smooth"]), strength: scalar(0, 1) }).strict().optional(),
  startStep: z.number().int().min(0).max(2147483647).optional(),
  endStep: z.number().int().min(0).max(2147483647).optional(),
  region: z.object({ x: scalar(0, 100), y: scalar(0, 100), width: scalar(0.1, 100), height: scalar(0.1, 100), invert: z.boolean() }).strict()
    .refine((r) => r.x + r.width <= 100 && r.y + r.height <= 100, "Effect region must stay inside the picture.").optional(),
}).strict().refine((effects) => (effects.endStep ?? 2147483647) >= (effects.startStep ?? 0), "The last effect step must follow the first.");
export type GenerationEffects = z.infer<typeof generationEffectsSchema>;
export const GENERATION_EFFECTS = [
  { id: "color", name: "Color steering", description: "Guide colors toward a target during generation." },
  { id: "tone", name: "Tone", description: "Adjust contrast, brightness, saturation and temperature during generation." },
  { id: "sharpness", name: "Sharpness", description: "Sharpen or soften during generation." },
  { id: "anchor", name: "Color stabilization", description: "Reduce color drift or smooth color boundaries during generation." },
] as const;
export type GenerationEffectId = typeof GENERATION_EFFECTS[number]["id"];
export const GENERATION_EFFECT_DEFAULTS: Required<Pick<GenerationEffects, GenerationEffectId>> = {
  color: { color: "#ff8000", strength: 0.35, mode: "interpolated" },
  tone: { contrast: 1, brightness: 0, saturation: 1, temperature: 0 },
  sharpness: { strength: 0.1 },
  anchor: { mode: "self", strength: 0.25 },
};

/** Only active, non-neutral controls are submitted or included in render fingerprints. */
export function activeGenerationEffects(value?: GenerationEffects | null): GenerationEffects | undefined {
  if (!value) return;
  const effects: GenerationEffects = {};
  if (value.color && value.color.enabled !== false && value.color.strength !== 0) effects.color = { color: value.color.color, strength: value.color.strength, mode: value.color.mode };
  if (value.tone && value.tone.enabled !== false && (value.tone.contrast !== 1 || value.tone.brightness !== 0 || value.tone.saturation !== 1 || value.tone.temperature !== 0)) {
    const { enabled: _enabled, ...tone } = value.tone; effects.tone = tone;
  }
  if (value.sharpness && value.sharpness.enabled !== false && value.sharpness.strength !== 0) effects.sharpness = { strength: value.sharpness.strength };
  if (value.anchor && value.anchor.enabled !== false && value.anchor.strength !== 0) effects.anchor = { mode: value.anchor.mode, strength: value.anchor.strength };
  if (!Object.keys(effects).length) return;
  return { ...effects, ...(value.startStep !== undefined ? { startStep: value.startStep } : {}), ...(value.endStep !== undefined ? { endStep: value.endStep } : {}), ...(value.region ? { region: { ...value.region } } : {}) };
}
