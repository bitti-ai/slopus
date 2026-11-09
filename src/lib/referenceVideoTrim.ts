export const MIN_REFERENCE_SECONDS = 2;
export const MAX_REFERENCE_SECONDS = 15;
type TrimLimits = { min: number; max: number };
const AUDIO_TRIM_LIMITS: TrimLimits = { min: MIN_REFERENCE_SECONDS, max: MAX_REFERENCE_SECONDS };
// Saved video selections may cover a short shot or an entire joined video.
// Generation-specific limits are checked when the reference is used.
export const VIDEO_TRIM_LIMITS: TrimLimits = { min: 0.001, max: Infinity };
export type ReferenceVideoTrim = { startSeconds: number; durationSeconds: number };
export type TrimAction = "move" | "start" | "end" | "duration";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function initialReferenceVideoTrim(sourceDuration: number, limits = AUDIO_TRIM_LIMITS): ReferenceVideoTrim {
  if (!Number.isFinite(sourceDuration) || sourceDuration < limits.min) {
    throw new Error(`Choose a source video lasting at least ${limits.min} seconds.`);
  }
  return { startSeconds: 0, durationSeconds: Math.min(MAX_REFERENCE_SECONDS, sourceDuration) };
}

export function normalizeReferenceVideoTrim(trim: ReferenceVideoTrim, sourceDuration: number, limits = AUDIO_TRIM_LIMITS): ReferenceVideoTrim {
  const initial = initialReferenceVideoTrim(sourceDuration, limits);
  const durationSeconds = clamp(Number.isFinite(trim.durationSeconds) ? trim.durationSeconds : initial.durationSeconds, limits.min, Math.min(limits.max, sourceDuration));
  return { startSeconds: clamp(Number.isFinite(trim.startSeconds) ? trim.startSeconds : 0, 0, sourceDuration - durationSeconds), durationSeconds };
}

/** Moving preserves length; dragging an edge preserves the opposite edge. */
export function editReferenceVideoTrim(trim: ReferenceVideoTrim, sourceDuration: number, action: TrimAction, value: number, limits = AUDIO_TRIM_LIMITS): ReferenceVideoTrim {
  const current = normalizeReferenceVideoTrim(trim, sourceDuration, limits);
  if (!Number.isFinite(value)) return current;
  const end = current.startSeconds + current.durationSeconds;
  if (action === "move") return { ...current, startSeconds: clamp(value, 0, sourceDuration - current.durationSeconds) };
  if (action === "start") {
    const startSeconds = clamp(value, Math.max(0, end - limits.max), end - limits.min);
    return { startSeconds, durationSeconds: clamp(end - startSeconds, limits.min, limits.max) };
  }
  const durationSeconds = clamp(action === "end" ? value - current.startSeconds : value,
    limits.min, Math.min(limits.max, sourceDuration - current.startSeconds));
  return { ...current, durationSeconds };
}

export function referenceTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}
