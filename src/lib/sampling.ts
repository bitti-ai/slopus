/** SlopFab accepts finite, positive float32 sigma shifts. */
export const MIN_SIGMA_SHIFT = 1.401298464324817e-45;
export const MAX_SIGMA_SHIFT = 3.4028234663852886e38;
export const DEFAULT_VIDEO_SIGMA_SHIFT = 12;
export const DEFAULT_AUDIO_SIGMA_SHIFT = 3;

export interface SigmaShifts { videoSigmaShift?: number; audioSigmaShift?: number }

export function isSigmaShift(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_SIGMA_SHIFT && value <= MAX_SIGMA_SHIFT;
}
