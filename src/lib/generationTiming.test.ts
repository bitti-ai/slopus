// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { alignedGenerationFrames, GenerationTimingEstimator, type CompletedGenerationTiming, type GenerationTimingProgress } from "./generationTiming";

const progress = (updates: Partial<GenerationTimingProgress> = {}): GenerationTimingProgress => ({
  jobId: "scene-1",
  stage: "denoising",
  step: 0,
  totalSteps: 4,
  plannedSteps: 4,
  elapsedSeconds: 20,
  frames: 360,
  canvasWidth: 416,
  canvasHeight: 416,
  referenceCount: 0,
  timingProfile: "vidfab=1.4.0|platform=CUDA 13|transformer=model.safetensors",
  ...updates,
});

const completed = (updates: Partial<CompletedGenerationTiming> = {}): CompletedGenerationTiming => ({
  frames: alignedGenerationFrames(360),
  width: 416,
  height: 416,
  referenceCount: 0,
  timingProfile: "vidfab=1.4.0|platform=CUDA 13|transformer=model.safetensors",
  secondsConditioning: 5,
  secondsDenoise: 40,
  secondsVideoDecode: 8,
  secondsAudioDecode: 2,
  secondsTotal: 60,
  stepsComputed: 4,
  stepsSkipped: 0,
  ...updates,
});

describe("vidfab generation timing", () => {
  beforeEach(() => localStorage.clear());

  it("matches vidfab frame alignment", () => {
    expect(alignedGenerationFrames(5)).toBe(5);
    expect(alignedGenerationFrames(360)).toBe(362);
  });

  it("waits for two live denoising samples, then uses actual seconds per step", () => {
    const estimator = new GenerationTimingEstimator(null);
    expect(estimator.update(progress(), 1_000)).toBeNull();
    // One completed step in ten seconds, with two steps still to run.
    expect(estimator.update(progress({ step: 1, elapsedSeconds: 30 }), 2_000)).toBe(22_000);
  });

  it("uses successful stage timings for decode overhead on later matching runs", () => {
    const first = new GenerationTimingEstimator();
    first.record(completed(), 100);

    const next = new GenerationTimingEstimator();
    // Historical 10 s/step plus the calibrated 10 s decode tail.
    expect(next.update(progress({ step: 0, elapsedSeconds: 12 }), 1_000)).toBe(41_000);
    expect(next.update(progress({ stage: "videoDecode", step: -1, totalSteps: 0 }), 2_000)).toBe(12_000);
  });

  it("uses planned evaluations and calibrated fixed stages before denoising starts", () => {
    const first = new GenerationTimingEstimator();
    first.record(completed(), 100);
    const next = new GenerationTimingEstimator();

    // The matching run historically took 60 s. Two seconds have elapsed.
    expect(next.update(progress({
      stage: "transformerLoad",
      step: -1,
      totalSteps: 0,
      plannedSteps: 4,
      elapsedSeconds: 2,
    }), 1_000)).toBe(59_000);
  });

  it("does not reuse calibration across a different model profile", () => {
    const estimator = new GenerationTimingEstimator();
    estimator.record(completed(), 100);
    expect(estimator.update(progress({ timingProfile: "another-model" }), 1_000)).toBeNull();
  });
});
