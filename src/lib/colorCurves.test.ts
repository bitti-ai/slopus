import { describe, expect, it } from "vitest";
import { compileCurves, curveEvaluator, CURVE_SAMPLES } from "./colorCurves";
import { CREATIVE_LOOKS, DEFAULT_CREATIVE, DEFAULT_WHEELS, activeVideoEffects, curveSchema, effectSchemas, type CurvePoint } from "./effectSettings";
import { timelineClipSchema } from "./project";
import { clipVisualSettings } from "./export";

describe("shape-preserving curves", () => {
  it.each<CurvePoint[][]>([
    [[[0, 0], [.1, .8], [.8, .81], [1, 1]]],
    [[[0, 1], [.25, .8], [.4, .1], [1, 0]]],
    [[[0, .2], [.2, .9], [.5, .9], [.8, .1], [1, .5]]],
    [[[0, 0], [.002, .9], [.99, .91], [1, 1]]],
  ])("passes through control points without overshooting any segment", (points) => {
    const evaluate = curveEvaluator(points);
    points.forEach(([x, y]) => expect(evaluate(x)).toBeCloseTo(y, 10));
    for (let i = 0; i < points.length - 1; i++) {
      const [x, y] = points[i], [endX, endY] = points[i + 1];
      for (let step = 0; step <= 100; step++) {
        const value = evaluate(x + (endX - x) * step / 100);
        expect(value).toBeGreaterThanOrEqual(Math.min(y, endY) - 1e-10);
        expect(value).toBeLessThanOrEqual(Math.max(y, endY) + 1e-10);
      }
    }
  });
  it("keeps the hue seam continuous with matching endpoint tangents", () => {
    const f = curveEvaluator([[0, .6], [.2, .9], [.8, .1], [1, .6]], true);
    expect(f(0)).toBe(f(1));
    expect((f(.000001) - f(0)) / .000001).toBeCloseTo(0, 3);
    expect((f(1) - f(.999999)) / .000001).toBeCloseTo(0, 3);
  });
  it("keeps neutral curves inactive and compiles only changed channel flags", () => {
    expect(compileCurves({}).mask).toBe(0);
    const compiled = compileCurves({ red: [[0, .1], [1, .9]], hueVsSat: [[0, .3], [1, .3]] });
    expect(compiled.mask).toBe((1 << 1) | (1 << 4));
    expect(compiled.values.length).toBe(9 * CURVE_SAMPLES);
    expect(compiled.values[CURVE_SAMPLES]).toBeCloseTo(.1);
    expect(compiled.values[2 * CURVE_SAMPLES - 1]).toBeCloseTo(.9);
    expect(compiled.values[4 * CURVE_SAMPLES + 500]).toBeCloseTo(.3);
  });
  it.each([[], [[0, 0]], [[0, 0], [0, 1]], [[0, 0], [.5, 1], [.4, 0], [1, 1]], [[0, 0], [1, NaN]], [[.1, 0], [1, 1]], [[0, 0], [1, 1.1]]].map((points) => ({ points })))("rejects malformed curve data", ({ points }) => {
    expect(curveSchema.safeParse(points).success).toBe(false);
    expect(effectSchemas.curves.safeParse({ hueVsSat: points }).success).toBe(false);
  });
});

describe("grading persistence and export", () => {
  const base = { id: "clip", assetId: "asset", trackId: "video", label: "Graded", startMs: 0, durationMs: 1000 };
  it("round trips every new setting into the shared export plan", () => {
    const settings = {
      colorCorrection: { exposure: 1, contrast: 20, saturation: 80, temperature: 25, tint: -15, highlights: -20, shadows: 30, whites: 10, blacks: -10 },
      creative: { ...DEFAULT_CREATIVE, look: "Warm Film", intensity: 65, fadedFilm: 10, sharpen: 35, vibrance: -15 },
      curves: { rgb: [[0, 0], [.5, .7], [1, 1]], hueVsHue: [[0, .5], [.2, .8], [1, .5]] },
      colorWheels: { ...DEFAULT_WHEELS, midtones: { x: .3, y: -.4, lightness: 10 } },
      vignette: { amount: -30, midpoint: 20, roundness: -15, feather: 65 },
    };
    const clip = timelineClipSchema.parse(JSON.parse(JSON.stringify({ ...base, ...settings })));
    expect(clipVisualSettings(clip)).toMatchObject(settings);
    expect(CREATIVE_LOOKS.filter((look) => look !== "None")).toHaveLength(8);
    for (const key of ["creative", "curves", "colorWheels"] as const) {
      const off = { ...clip, [key]: { ...clip[key], enabled: false } };
      expect(activeVideoEffects(off)[key]).toBeNull();
      expect(off[key]).toMatchObject(settings[key]);
    }
  });
  it("validates new controls including hue seams and wheel radius", () => {
    expect(effectSchemas.creative.safeParse({ ...DEFAULT_CREATIVE, look: "unknown" }).success).toBe(false);
    expect(effectSchemas.colorWheels.safeParse({ ...DEFAULT_WHEELS, shadows: { x: 1, y: 1, lightness: 0 } }).success).toBe(false);
    expect(effectSchemas.curves.safeParse({ hueVsHue: [[0, .1], [1, .9]] }).success).toBe(false);
    for (const field of ["temperature", "tint", "highlights", "shadows", "whites", "blacks"]) {
      expect(effectSchemas.colorCorrection.safeParse({ exposure: 0, contrast: 0, saturation: 100, [field]: 101 }).success).toBe(false);
    }
    expect(effectSchemas.vignette.safeParse({ amount: 0, feather: -1 }).success).toBe(false);
  });
});
