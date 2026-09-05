/**
 * Stage-aware generation timing.
 *
 * slopfab reports elapsed wall time and completed denoising steps while a run
 * is active, then returns the measured duration of each expensive stage. The
 * live samples give an honest seconds-per-step rate; successful runs supply a
 * small machine-local calibration for the work before and after denoising.
 * Nothing here is project data, so none of it belongs in polstudio.json.
 */

const STORAGE_KEY = "polstudio.generation-timing.v1";
const MAX_PROFILES = 32;
const MAX_REMAINING_SECONDS = 24 * 60 * 60;

export interface GenerationTimingProgress {
  jobId: string;
  stage: string;
  step: number;
  totalSteps: number;
  plannedSteps: number;
  elapsedSeconds: number;
  frames: number;
  canvasWidth: number;
  canvasHeight: number;
  referenceCount: number;
  timingProfile: string;
}

export interface CompletedGenerationTiming {
  frames: number;
  width: number;
  height: number;
  referenceCount: number;
  timingProfile: string;
  secondsConditioning: number;
  secondsDenoise: number;
  secondsVideoDecode: number;
  secondsAudioDecode: number;
  secondsTotal: number;
  stepsComputed: number;
  stepsSkipped: number;
}

interface TimingProfile {
  samples: number;
  updatedAt: number;
  secondsConditioning: number;
  secondsPerDenoiseStep: number;
  secondsVideoDecode: number;
  secondsAudioDecode: number;
  /** Loading, references, delivery, and other time not itemized by the ABI. */
  secondsOther: number;
}

interface JobTiming {
  key: string;
  previousDenoise: { completedSteps: number; elapsedSeconds: number } | null;
  secondsPerDenoiseStep: number | null;
}

type ProfileStore = Record<string, TimingProfile>;
type TimingStorage = Pick<Storage, "getItem" | "setItem">;

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;

/** The frame alignment used by slopfab's resolved plan: 17*k + 5. */
export function alignedGenerationFrames(frames: number): number {
  return Math.ceil((Math.max(5, Math.round(frames)) - 5) / 17) * 17 + 5;
}

function profileKey(profile: string, width: number, height: number, frames: number, references: number): string {
  return [profile || "unknown", `${Math.round(width)}x${Math.round(height)}`, alignedGenerationFrames(frames), `refs=${Math.max(0, Math.round(references))}`].join("|");
}

function readProfiles(storage: TimingStorage | null): ProfileStore {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Partial<TimingProfile>;
      return finiteNonNegative(candidate.samples ?? Number.NaN)
        && finiteNonNegative(candidate.updatedAt ?? Number.NaN)
        && finiteNonNegative(candidate.secondsConditioning ?? Number.NaN)
        && finiteNonNegative(candidate.secondsPerDenoiseStep ?? Number.NaN)
        && finiteNonNegative(candidate.secondsVideoDecode ?? Number.NaN)
        && finiteNonNegative(candidate.secondsAudioDecode ?? Number.NaN)
        && finiteNonNegative(candidate.secondsOther ?? Number.NaN);
    })) as ProfileStore;
  } catch {
    return {};
  }
}

function browserStorage(): TimingStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function blend(previous: number, sample: number, hasPrevious: boolean): number {
  return hasPrevious ? previous * 0.75 + sample * 0.25 : sample;
}

export class GenerationTimingEstimator {
  private readonly jobs = new Map<string, JobTiming>();
  private profiles: ProfileStore;

  constructor(private readonly storage: TimingStorage | null = browserStorage()) {
    this.profiles = readProfiles(storage);
  }

  /** Returns an absolute completion timestamp, or null until the estimate has
   * enough real data to be worth showing. */
  update(progress: GenerationTimingProgress, nowMs = Date.now()): number | null {
    if (!finiteNonNegative(progress.elapsedSeconds) || progress.totalSteps < 0 || progress.plannedSteps < 0) return null;
    const totalSteps = progress.totalSteps > 0 ? progress.totalSteps : progress.plannedSteps;
    const key = profileKey(
      progress.timingProfile,
      progress.canvasWidth,
      progress.canvasHeight,
      progress.frames,
      progress.referenceCount,
    );
    let state = this.jobs.get(progress.jobId);
    if (!state || state.key !== key) {
      state = { key, previousDenoise: null, secondsPerDenoiseStep: null };
      this.jobs.set(progress.jobId, state);
    }
    const profile = this.profiles[key];
    let remainingSeconds: number | null = null;

    if (progress.stage === "denoising" && totalSteps > 0 && progress.step >= 0) {
      const completedSteps = Math.min(totalSteps, progress.step + 1);
      const previous = state.previousDenoise;
      if (previous && completedSteps > previous.completedSteps && progress.elapsedSeconds > previous.elapsedSeconds) {
        const measured = (progress.elapsedSeconds - previous.elapsedSeconds)
          / (completedSteps - previous.completedSteps);
        if (measured > 0 && measured < MAX_REMAINING_SECONDS) {
          state.secondsPerDenoiseStep = state.secondsPerDenoiseStep === null
            ? measured
            : state.secondsPerDenoiseStep * 0.7 + measured * 0.3;
        }
      }
      state.previousDenoise = { completedSteps, elapsedSeconds: progress.elapsedSeconds };
      const secondsPerStep = state.secondsPerDenoiseStep ?? profile?.secondsPerDenoiseStep ?? null;
      if (secondsPerStep !== null) {
        const decodeTail = profile ? profile.secondsVideoDecode + profile.secondsAudioDecode : 0;
        remainingSeconds = secondsPerStep * (totalSteps - completedSteps) + decodeTail;
      }
    } else if (progress.stage === "videoDecode") {
      if (profile) remainingSeconds = profile.secondsVideoDecode + profile.secondsAudioDecode;
    } else if (progress.stage === "audioDecode") {
      if (profile) remainingSeconds = profile.secondsAudioDecode;
    } else if (!["delivering", "finished"].includes(progress.stage) && profile && totalSteps > 0) {
      const expectedTotal = profile.secondsConditioning
        + profile.secondsOther
        + profile.secondsPerDenoiseStep * totalSteps
        + profile.secondsVideoDecode
        + profile.secondsAudioDecode;
      remainingSeconds = expectedTotal - progress.elapsedSeconds;
    }

    if (remainingSeconds === null || !Number.isFinite(remainingSeconds)
      || remainingSeconds <= 0 || remainingSeconds > MAX_REMAINING_SECONDS) return null;
    return nowMs + remainingSeconds * 1_000;
  }

  /** Adds one successful run to the profile for this exact engine/model,
   * geometry, aligned frame count, and reference count. */
  record(sample: CompletedGenerationTiming, nowMs = Date.now()): void {
    if (![sample.secondsConditioning, sample.secondsDenoise, sample.secondsVideoDecode,
      sample.secondsAudioDecode, sample.secondsTotal].every(finiteNonNegative)
      || sample.stepsComputed <= 0 || sample.secondsTotal <= 0) return;
    const key = profileKey(sample.timingProfile, sample.width, sample.height, sample.frames, sample.referenceCount);
    const previous = this.profiles[key];
    const hasPrevious = Boolean(previous);
    const itemized = sample.secondsConditioning + sample.secondsDenoise
      + sample.secondsVideoDecode + sample.secondsAudioDecode;
    const next: TimingProfile = {
      samples: Math.min(1_000_000, (previous?.samples ?? 0) + 1),
      updatedAt: nowMs,
      secondsConditioning: blend(previous?.secondsConditioning ?? 0, sample.secondsConditioning, hasPrevious),
      secondsPerDenoiseStep: blend(previous?.secondsPerDenoiseStep ?? 0, sample.secondsDenoise / sample.stepsComputed, hasPrevious),
      secondsVideoDecode: blend(previous?.secondsVideoDecode ?? 0, sample.secondsVideoDecode, hasPrevious),
      secondsAudioDecode: blend(previous?.secondsAudioDecode ?? 0, sample.secondsAudioDecode, hasPrevious),
      secondsOther: blend(previous?.secondsOther ?? 0, Math.max(0, sample.secondsTotal - itemized), hasPrevious),
    };
    this.profiles[key] = next;
    const ordered = Object.entries(this.profiles).sort((left, right) => right[1].updatedAt - left[1].updatedAt);
    this.profiles = Object.fromEntries(ordered.slice(0, MAX_PROFILES));
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.profiles));
    } catch {
      // Losing calibration only means the next launch starts with "Estimating".
    }
  }

  clear(jobId: string): void {
    this.jobs.delete(jobId);
  }
}
