import { describe, expect, it } from "vitest";
import { applyChromaKey, backdropKeyUniforms, keyAlpha, usesBackdropKey } from "./chromaKey";
import { clipChromaKeySchema, timelineClipSchema } from "./project";

describe("Chroma Key", () => {
  it("validates backdrop controls without changing legacy settings", () => {
    const base = { color: "#00ff00", tolerance: 20 };
    const key = { ...base, backdrop: "green" as const, screenGain: 110, screenBalance: 50, clipBlack: 5, clipWhite: 90,
      despill: 70, unmix: 80, softness: 1.5, choke: -.5, removeShadows: true, despeckle: true, fillHoles: true };
    expect(clipChromaKeySchema.parse(JSON.parse(JSON.stringify(key)))).toEqual(key);
    expect(usesBackdropKey(key)).toBe(true);
    expect(usesBackdropKey({ ...key, enabled: false })).toBe(false);
    expect(usesBackdropKey(base)).toBe(false);
    expect(backdropKeyUniforms(key)).toEqual([1, 1.1, .5, .7, .05, .9, .8, 1, 1.5, -.5, 1, 1]);
    expect(backdropKeyUniforms({ ...base, backdrop: "auto", screenGain: null })[1]).toBe(1);
    for (const patch of [{ backdrop: "red" }, { clipBlack: 95 }, { clipWhite: 3 }, { screenGain: 201 }, { despill: -1 },
      { softness: 5 }, { choke: -5 }, { unmix: NaN }]) {
      expect(clipChromaKeySchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
  });
  it("removes the chosen color, keeps other colors and preserves existing alpha", () => {
    const pixels = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 128, 0, 0, 255, 255]);
    applyChromaKey(pixels, { color: "#00ff00", tolerance: 0 });
    expect(Array.from(pixels)).toEqual([0, 255, 0, 0, 255, 0, 0, 128, 0, 0, 255, 255]);
  });
  it("widens the transparent range as tolerance increases and feathers its edge", () => {
    const narrow = new Uint8ClampedArray([30, 210, 30, 255]);
    const wide = narrow.slice();
    applyChromaKey(narrow, { color: "#00ff00", tolerance: 1 });
    applyChromaKey(wide, { color: "#00ff00", tolerance: 20 });
    expect(narrow[3]).toBe(255);
    expect(wide[3]).toBe(0);
    expect(keyAlpha(0.21, 20)).toBeCloseTo(0.5);
    expect(keyAlpha(1, 100)).toBe(0);
  });
  it("rejects malformed colors and out-of-range tolerances while accepting old clips", () => {
    for (const key of [{ color: "green", tolerance: 20 }, { color: "#12345g", tolerance: 20 }, { color: "#00ff00", tolerance: -1 }, { color: "#00ff00", tolerance: 101 }]) {
      expect(clipChromaKeySchema.safeParse(key).success).toBe(false);
    }
    const old = { id: "clip", assetId: "a", trackId: "t", label: "Clip", startMs: 0, durationMs: 1000 };
    expect(timelineClipSchema.parse(old).chromaKey).toBeUndefined();
    expect(timelineClipSchema.parse({ ...old, chromaKey: null }).chromaKey).toBeNull();
    const edited = { ...old, chromaKey: { color: "#12ABef", tolerance: 30 } };
    expect(timelineClipSchema.parse(JSON.parse(JSON.stringify(edited))).chromaKey).toEqual(edited.chromaKey);
  });
});
