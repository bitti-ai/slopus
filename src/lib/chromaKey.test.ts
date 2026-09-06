import { describe, expect, it } from "vitest";
import { applyChromaKey, keyAlpha } from "./chromaKey";
import { clipChromaKeySchema, timelineClipSchema } from "./project";

describe("Chroma Key", () => {
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
