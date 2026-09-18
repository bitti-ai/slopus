import { z } from "zod";

const triple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const lutTableSchema = z.object({
  name: z.string().min(1).max(256),
  size: z.number().int().min(2).max(65),
  domainMin: triple,
  domainMax: triple,
  values: z.array(z.number().finite().min(-65504).max(65504)).max(65 ** 3 * 3),
}).superRefine((table, context) => {
  if (table.values.length !== table.size ** 3 * 3) context.addIssue({ code: "custom", message: "LUT row count does not match its size." });
  if (table.domainMin.some((min, i) => min >= table.domainMax[i])) context.addIssue({ code: "custom", message: "LUT domain maximum must exceed minimum." });
});

export const effectSchemas = {
  sharpen: z.object({ amount: z.number().finite().min(0).max(200) }).nullish(),
  blur: z.object({ radius: z.number().finite().min(0).max(24) }).nullish(),
  colorCorrection: z.object({
    exposure: z.number().finite().min(-4).max(4),
    contrast: z.number().finite().min(-100).max(100),
    saturation: z.number().finite().min(0).max(200),
  }).nullish(),
  vignette: z.object({ amount: z.number().finite().min(0).max(100) }).nullish(),
  lut: z.object({ intensity: z.number().finite().min(0).max(100), table: lutTableSchema.nullish() }).nullish(),
};
export type VideoEffects = z.infer<z.ZodObject<typeof effectSchemas>>;
export type LutTable = z.infer<typeof lutTableSchema>;
export const hasVideoEffects = (effects: VideoEffects): boolean => Boolean(
  effects.sharpen || effects.blur || effects.colorCorrection || effects.vignette || effects.lut,
);

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
    const line = raw.replace(/#.*$/, "").trim();
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
