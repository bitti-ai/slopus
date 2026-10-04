import { z } from "zod";

const domainValue = z.number().finite().min(-65504).max(65504);
const triple = z.tuple([domainValue, domainValue, domainValue]);
export const lutTableSchema = z.object({
  name: z.string().min(1).max(256),
  size: z.number().int().min(2).max(65),
  domainMin: triple,
  domainMax: triple,
  values: z.array(z.number().finite().min(-65504).max(65504)).max(65 ** 3 * 3),
}).superRefine((table, context) => {
  if (table.values.length !== table.size ** 3 * 3) context.addIssue({ code: "custom", message: "LUT row count does not match its size." });
  if (table.domainMin.some((min, i) => Math.fround(min) >= Math.fround(table.domainMax[i]))) context.addIssue({ code: "custom", message: "LUT domain maximum must exceed minimum at GPU precision." });
});

/* Bypass. `enabled: false` switches an effect off without losing its
   settings (the checkbox in the effect's header). Absent — every project
   written before bypass existed — or true means on, so old files load and
   save byte for byte. Nullish rather than optional for the reason given on
   projectAssetSchema.durationMs; Rust skips it when None. */
export const effectEnabledSchema = z.boolean().nullish();

/** True when the effect is present and not bypassed. */
export const isEffectOn = <T extends { enabled?: boolean | null }>(effect: T | null | undefined): effect is T =>
  effect !== null && effect !== undefined && effect.enabled !== false;

const percent = z.number().finite().min(0).max(100);
const signedPercent = z.number().finite().min(-100).max(100);
const unit = z.number().finite().min(0).max(1);
export const curveSchema = z.array(z.tuple([unit, unit])).min(2).max(32).superRefine((points, context) => {
  if (points.length < 2 || points[0][0] !== 0 || points[points.length - 1][0] !== 1 || points.some((p, i) => i > 0 && p[0] - points[i - 1][0] < 0.001)) {
    context.addIssue({ code: "custom", message: "Curves need endpoints at 0 and 1 and increasing inputs at least 0.001 apart." });
  }
});
const hueCurveSchema = curveSchema.refine((p) => p.length >= 2 && p[0][1] === p[p.length - 1][1], "Hue curve endpoints must match.");
export const CREATIVE_LOOKS = ["None", "Teal & Orange", "Warm Film", "Cool Blue", "Bleach Bypass", "Faded Matte", "Monochrome", "Golden Hour", "Night"] as const;
export const CURVE_CHANNELS = ["rgb", "red", "green", "blue", "hueVsSat", "hueVsHue", "hueVsLuma", "lumaVsSat", "satVsSat"] as const;
export type CurveChannel = typeof CURVE_CHANNELS[number];
export type CurvePoint = [number, number];
export const defaultCurve = (channel: CurveChannel): CurvePoint[] => channel === "rgb" || channel === "red" || channel === "green" || channel === "blue" ? [[0, 0], [1, 1]] : [[0, 0.5], [1, 0.5]];
const wheelSchema = z.object({ x: z.number().finite().min(-1).max(1), y: z.number().finite().min(-1).max(1), lightness: signedPercent })
  .refine((v) => Math.hypot(v.x, v.y) <= 1.000001, "Wheel position must be inside the wheel.");
export const DEFAULT_CREATIVE = { look: "None", intensity: 100, fadedFilm: 0, sharpen: 0, vibrance: 0 } as const;
export const DEFAULT_WHEELS = { shadows: { x: 0, y: 0, lightness: 0 }, midtones: { x: 0, y: 0, lightness: 0 }, highlights: { x: 0, y: 0, lightness: 0 } };

export const effectSchemas = {
  sharpen: z.object({ amount: z.number().finite().min(0).max(200), enabled: effectEnabledSchema }).nullish(),
  blur: z.object({ radius: z.number().finite().min(0).max(24), enabled: effectEnabledSchema }).nullish(),
  colorCorrection: z.object({
    temperature: signedPercent.nullish(), tint: signedPercent.nullish(),
    highlights: signedPercent.nullish(), shadows: signedPercent.nullish(), whites: signedPercent.nullish(), blacks: signedPercent.nullish(),
    exposure: z.number().finite().min(-4).max(4),
    brightness: z.number().finite().min(-100).max(100).nullish(),
    contrast: z.number().finite().min(-100).max(100),
    saturation: z.number().finite().min(0).max(200),
    enabled: effectEnabledSchema,
  }).nullish(),
  creative: z.object({ look: z.enum(CREATIVE_LOOKS), intensity: percent, fadedFilm: percent, sharpen: z.number().finite().min(0).max(200), vibrance: signedPercent, enabled: effectEnabledSchema }).nullish(),
  curves: z.object({
    rgb: curveSchema.nullish(), red: curveSchema.nullish(), green: curveSchema.nullish(), blue: curveSchema.nullish(),
    hueVsSat: hueCurveSchema.nullish(), hueVsHue: hueCurveSchema.nullish(), hueVsLuma: hueCurveSchema.nullish(),
    lumaVsSat: curveSchema.nullish(), satVsSat: curveSchema.nullish(), enabled: effectEnabledSchema,
  }).nullish(),
  colorWheels: z.object({ shadows: wheelSchema, midtones: wheelSchema, highlights: wheelSchema, enabled: effectEnabledSchema }).nullish(),
  vignette: z.object({ amount: signedPercent, midpoint: percent.nullish(), roundness: signedPercent.nullish(), feather: percent.nullish(), enabled: effectEnabledSchema }).nullish(),
  lut: z.object({ intensity: z.number().finite().min(0).max(100), table: lutTableSchema.nullish(), enabled: effectEnabledSchema }).nullish(),
};
export type VideoEffects = z.infer<z.ZodObject<typeof effectSchemas>>;
export type LutTable = z.infer<typeof lutTableSchema>;

/** The effects that render: bypassed ones are dropped, as if absent. Every
 *  render path (program monitor, export) reads effects through this. */
export const activeVideoEffects = (effects: VideoEffects): VideoEffects => ({
  sharpen: isEffectOn(effects.sharpen) ? effects.sharpen : null,
  blur: isEffectOn(effects.blur) ? effects.blur : null,
  colorCorrection: isEffectOn(effects.colorCorrection) ? effects.colorCorrection : null,
  creative: isEffectOn(effects.creative) ? effects.creative : null,
  curves: isEffectOn(effects.curves) ? effects.curves : null,
  colorWheels: isEffectOn(effects.colorWheels) ? effects.colorWheels : null,
  vignette: isEffectOn(effects.vignette) ? effects.vignette : null,
  lut: isEffectOn(effects.lut) ? effects.lut : null,
});

export const hasVideoEffects = (effects: VideoEffects): boolean =>
  Object.keys(effectSchemas).some((key) => isEffectOn(effects[key as keyof VideoEffects]));

export const MAX_LUT_FILE_BYTES = 16 * 1024 * 1024;

/** Adobe/Resolve 3D .cube, red index varying fastest. Reject shapers explicitly. */
export function parseCube(text: string, filename: string): LutTable {
  if (text.length > MAX_LUT_FILE_BYTES) throw new Error("LUT files must be smaller than 16 MB.");
  let name = filename.slice(0, 256) || "Imported LUT";
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = (raw.match(/^(?:"[^"]*"|[^"#])*/)?.[0] ?? "").trim();
    if (!line) continue;
    const [tag, ...args] = line.split(/\s+/);
    const fail = (message: string): never => { throw new Error(`Line ${index + 1}: ${message}`); };
    if (/^[A-Za-z_]/.test(tag)) {
      if (values.length) fail("LUT headers must come before color rows.");
      if (seen.has(tag)) fail(`Duplicate ${tag} header.`);
      seen.add(tag);
      if (tag === "TITLE") {
        const title = /^TITLE\s+"([^"]+)"$/.exec(line);
        if (!title) fail("Expected a quoted LUT title.");
        name = title![1].slice(0, 256);
      } else if (tag === "LUT_3D_SIZE") {
        size = Number(args[0]);
        if (args.length !== 1 || !Number.isInteger(size) || size < 2 || size > 65) fail("Supported 3D LUT sizes are 2–65.");
      } else if (tag === "DOMAIN_MIN" || tag === "DOMAIN_MAX") {
        const numbers = args.map(Number);
        if (numbers.length !== 3 || !numbers.every(Number.isFinite)) fail("Expected three finite domain values.");
        if (tag === "DOMAIN_MIN") domainMin = numbers as typeof domainMin;
        else domainMax = numbers as typeof domainMax;
      } else if (tag === "LUT_3D_INPUT_RANGE") {
        const numbers = args.map(Number);
        if (numbers.length !== 2 || !numbers.every(Number.isFinite)) fail("Expected two finite input range values.");
        domainMin = [numbers[0], numbers[0], numbers[0]];
        domainMax = [numbers[1], numbers[1], numbers[1]];
      } else fail(`${tag} is unsupported. Choose a 3D .cube LUT without a 1D shaper.`);
      continue;
    }
    if (!size) fail("LUT_3D_SIZE must precede color rows.");
    const row = [tag, ...args].map(Number);
    if (row.length !== 3 || !row.every((value) => Number.isFinite(value) && Math.abs(value) <= 65504)) fail("Expected three finite color values within ±65504.");
    values.push(...row);
    if (values.length > size ** 3 * 3) fail("Too many color rows for this LUT size.");
  }
  if (seen.has("LUT_3D_INPUT_RANGE") && (seen.has("DOMAIN_MIN") || seen.has("DOMAIN_MAX"))) throw new Error("Use either DOMAIN_MIN/MAX or LUT_3D_INPUT_RANGE, not both.");
  const parsed = lutTableSchema.safeParse({ name, size, domainMin, domainMax, values });
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  return parsed.data;
}
