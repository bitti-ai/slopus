import { z } from "zod";

export const MAX_LCS_CALIBRATION_BYTES = 256 * 1024;

/** Fitted archives are small and travel with the scene, never as host-specific paths. */
export function validateLcsCalibration(bytes: Uint8Array): void {
  if (bytes.length < 8 || bytes.length > MAX_LCS_CALIBRATION_BYTES) throw new Error("Choose an LCS calibration archive smaller than 256 KB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Number(view.getBigUint64(0, true));
  if (!Number.isSafeInteger(length) || length < 2 || length > 65536 || length + 8 > bytes.length) throw new Error("Invalid LCS calibration header.");
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length)));
  if (header.__metadata__?.slopfab_lcs !== "1" || !/^[a-f0-9]{64}$/i.test(header.__metadata__?.vae_sha256 ?? "")) throw new Error("Choose a fitted SlopFab LCS calibration.");
  const read = (name: string, shape: number[]) => {
    const tensor = header[name], count = shape.reduce((a, b) => a * b, 1);
    const [start, end] = tensor?.data_offsets ?? [];
    if (tensor?.dtype !== "F32" || JSON.stringify(tensor.shape) !== JSON.stringify(shape)
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end - start !== count * 4 || end > bytes.length - 8 - length) {
      throw new Error(`Invalid or missing LCS ${name} tensor. Import a calibration fitted from early and late generations.`);
    }
    const values = Array.from({ length: count }, (_, i) => view.getFloat32(8 + length + start + i * 4, true));
    if (!values.every(Number.isFinite)) throw new Error(`Non-finite LCS ${name} values.`);
    return values;
  };
  const basis = read("basis", [96, 3]);
  read("mean", [96]); read("anchor_lcs", [8, 3]); read("latent_mean", [24]);
  if (read("latent_std", [24]).some((n) => n <= 0)) throw new Error("Invalid LCS latent scaling.");
  read("explained_variance", [1]);
  const direction = read("drift_direction", [96]), reference = read("drift_reference", [2]);
  const norm = direction.reduce((sum, n) => sum + n * n, 0);
  const projection = [0, 1, 2].map((axis) => direction.reduce((sum, n, i) => sum + n * basis[i * 3 + axis], 0));
  if (Math.abs(norm - 1) >= 0.0001 || Math.hypot(...projection) >= 0.0001 || reference[1] < 0) throw new Error("Invalid learned drift direction or tolerance.");
}

export const lcsCalibrationSchema = z.object({
  name: z.string().min(1).max(200),
  data: z.string().min(1).max(Math.ceil(MAX_LCS_CALIBRATION_BYTES / 3) * 4),
}).strict().superRefine((value, ctx) => {
  try { validateLcsCalibration(Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0))); }
  catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid LCS calibration." }); }
});
export type LcsCalibration = z.infer<typeof lcsCalibrationSchema>;

export function importLcsCalibration(name: string, bytes: Uint8Array): LcsCalibration {
  validateLcsCalibration(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return lcsCalibrationSchema.parse({ name: name.slice(0, 200), data: btoa(binary) });
}
