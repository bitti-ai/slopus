export const MIN_REFERENCE_SECONDS = 2;
export const MAX_REFERENCE_SECONDS = 15;
export type ReferenceVideoTrim = { startSeconds: number; durationSeconds: number };
export type TrimAction = "move" | "start" | "end" | "duration";
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function initialReferenceVideoTrim(sourceDuration: number): ReferenceVideoTrim {
  if (!Number.isFinite(sourceDuration) || sourceDuration < MIN_REFERENCE_SECONDS) {
    throw new Error("Choose a source video lasting at least 2 seconds.");
  }
  return { startSeconds: 0, durationSeconds: Math.min(MAX_REFERENCE_SECONDS, sourceDuration) };
}

export function normalizeReferenceVideoTrim(trim: ReferenceVideoTrim, sourceDuration: number): ReferenceVideoTrim {
  const initial = initialReferenceVideoTrim(sourceDuration);
  const durationSeconds = clamp(Number.isFinite(trim.durationSeconds) ? trim.durationSeconds : initial.durationSeconds, MIN_REFERENCE_SECONDS, initial.durationSeconds);
  return { startSeconds: clamp(Number.isFinite(trim.startSeconds) ? trim.startSeconds : 0, 0, sourceDuration - durationSeconds), durationSeconds };
}

/** Moving preserves length; dragging an edge preserves the opposite edge. */
export function editReferenceVideoTrim(trim: ReferenceVideoTrim, sourceDuration: number, action: TrimAction, value: number): ReferenceVideoTrim {
  const current = normalizeReferenceVideoTrim(trim, sourceDuration);
  if (!Number.isFinite(value)) return current;
  const end = current.startSeconds + current.durationSeconds;
  if (action === "move") return { ...current, startSeconds: clamp(value, 0, sourceDuration - current.durationSeconds) };
  if (action === "start") {
    const startSeconds = clamp(value, Math.max(0, end - MAX_REFERENCE_SECONDS), end - MIN_REFERENCE_SECONDS);
    return { startSeconds, durationSeconds: clamp(end - startSeconds, MIN_REFERENCE_SECONDS, MAX_REFERENCE_SECONDS) };
  }
  const durationSeconds = clamp(action === "end" ? value - current.startSeconds : value,
    MIN_REFERENCE_SECONDS, Math.min(MAX_REFERENCE_SECONDS, sourceDuration - current.startSeconds));
  return { ...current, durationSeconds };
}

export function referenceTime(seconds: number): string {
  const tenths = Math.round(seconds * 10);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}
