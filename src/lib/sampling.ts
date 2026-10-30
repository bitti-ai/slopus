/** SlopFab accepts finite, positive float32 sigma shifts. */
export const MIN_SIGMA_SHIFT = 1.401298464324817e-45;
export const MAX_SIGMA_SHIFT = 3.4028234663852886e38;
export const DEFAULT_VIDEO_SIGMA_SHIFT = 12;
export const DEFAULT_AUDIO_SIGMA_SHIFT = 3;

export interface SigmaShifts { videoSigmaShift?: number; audioSigmaShift?: number }

export const SAMPLERS = ["default", "euler", "ab2", "renoise", "er_sde"] as const;
export const SCHEDULERS = ["default", "beta"] as const;
export type Sampler = typeof SAMPLERS[number];
export type Scheduler = typeof SCHEDULERS[number];
export interface SamplingChoices { sampler?: Sampler; scheduler?: Scheduler }
export const SAMPLER_LABELS: Record<Sampler, string> = { default: "Model default", euler: "Euler", ab2: "AB2 (CUDA)", renoise: "Re-noising", er_sde: "ER-SDE" };
export const SCHEDULER_LABELS: Record<Scheduler, string> = { default: "Model default", beta: "Beta" };
export const isSampler = (value: unknown): value is Sampler => SAMPLERS.includes(value as Sampler);
export const isScheduler = (value: unknown): value is Scheduler => SCHEDULERS.includes(value as Scheduler);

export function isSigmaShift(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_SIGMA_SHIFT && value <= MAX_SIGMA_SHIFT;
}
