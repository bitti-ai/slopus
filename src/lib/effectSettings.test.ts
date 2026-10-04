import { describe, expect, it } from "vitest";
import { activeVideoEffects, hasVideoEffects, isEffectOn, parseCube } from "./effectSettings";
import { timelineClipSchema } from "./project";
import { clipFrameStyle, clipVisualSettings } from "./export";

export const identityCube = `TITLE "Identity"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1`;

describe("3D cube import", () => {
  it("preserves red-fastest ordering, comments, title and nonstandard domains", () => {
    const table = parseCube(identityCube.replace("LUT_3D_SIZE 2", "# comment\r\nLUT_3D_SIZE 2\r\nDOMAIN_MIN -1 -2 -3\r\nDOMAIN_MAX 2 3 4"), "test.cube");
    expect(table).toMatchObject({ name: "Identity", size: 2, domainMin: [-1, -2, -3], domainMax: [2, 3, 4] });
    expect(table.values.slice(3, 9)).toEqual([1, 0, 0, 0, 1, 0]);
  });
  it("accepts Resolve input ranges", () => {
    expect(parseCube(identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 2"), "test.cube").domainMax).toEqual([2, 2, 2]);
  });
  it("keeps hash characters inside quoted titles", () => {
    expect(parseCube(identityCube.replace('"Identity"', '"Look #2" # comment'), "test.cube").name).toBe("Look #2");
  });
  it.each([
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 66"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_1D_SIZE 2"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MAX 0 1 1"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_3D_SIZE 2"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1.000000000001 1 1"),
    identityCube.replace("1 1 1", "1 NaN 1"),
    identityCube.replace("1 1 1", ""),
    identityCube + "\n1 1 1",
  ])("rejects malformed or unsupported tables", (text) => {
    expect(() => parseCube(text, "bad.cube")).toThrow();
  });
});

it("retains effects through project parsing and export frame planning", () => {
  const clip = timelineClipSchema.parse({
    id: "clip", assetId: "asset", trackId: "track", label: "Test", startMs: 0, durationMs: 1000,
    sharpen: { amount: 60 }, blur: { radius: 4 }, vignette: { amount: 30 },
    colorCorrection: { exposure: 1, brightness: -25, contrast: 20, saturation: 80 },
    lut: { intensity: 70, table: parseCube(identityCube, "identity.cube") },
  });
  const reopened = timelineClipSchema.parse(JSON.parse(JSON.stringify(clip)));
  expect(clipFrameStyle(clipVisualSettings(reopened), 500)).toMatchObject({
    sharpen: clip.sharpen, blur: clip.blur, vignette: clip.vignette, colorCorrection: clip.colorCorrection, lut: clip.lut,
  });
  expect(timelineClipSchema.safeParse({ ...clip, blur: { radius: 25 } }).success).toBe(false);
  for (const brightness of [-101, 101, NaN, Infinity]) {
    expect(timelineClipSchema.safeParse({ ...clip, colorCorrection: { ...clip.colorCorrection, brightness } }).success).toBe(false);
  }
  const legacyGrade = { exposure: 1, contrast: 20, saturation: 80 };
  expect(timelineClipSchema.parse({ ...clip, colorCorrection: legacyGrade }).colorCorrection).toEqual(legacyGrade);
  expect(timelineClipSchema.safeParse({ ...clip, lut: { ...clip.lut, table: { ...clip.lut!.table, values: [] } } }).success).toBe(false);
});

describe("effect bypass", () => {
  const base = { id: "clip", assetId: "asset", trackId: "video", label: "Clip", startMs: 0, durationMs: 2000 };

  it("loads projects written before bypass unchanged and keeps an explicit flag", () => {
    const legacy = timelineClipSchema.parse({ ...base, sharpen: { amount: 40 }, look: { opacity: 70, temperature: 5 } });
    expect(JSON.parse(JSON.stringify(legacy)).sharpen).toEqual({ amount: 40 });
    expect(JSON.parse(JSON.stringify(legacy)).look).toEqual({ opacity: 70, temperature: 5 });
    const off = timelineClipSchema.parse({ ...base, sharpen: { amount: 40, enabled: false }, chromaKey: { color: "#00ff00", tolerance: 20, enabled: false } });
    expect(off.sharpen?.enabled).toBe(false);
    expect(off.chromaKey?.enabled).toBe(false);
    expect(timelineClipSchema.safeParse({ ...base, blur: { radius: 2, enabled: "no" } }).success).toBe(false);
  });

  it("treats absent, null and true as on and only false as off", () => {
    type Amount = { amount: number; enabled?: boolean | null };
    const isEffectOnAmount = (effect: Amount | null | undefined) => isEffectOn(effect);
    expect(isEffectOnAmount({ amount: 1 })).toBe(true);
    expect(isEffectOnAmount({ amount: 1, enabled: null })).toBe(true);
    expect(isEffectOnAmount({ amount: 1, enabled: true })).toBe(true);
    expect(isEffectOnAmount({ amount: 1, enabled: false })).toBe(false);
    expect(isEffectOnAmount(null)).toBe(false);
    expect(isEffectOnAmount(undefined)).toBe(false);
  });

  it("drops bypassed effects from what renders", () => {
    const effects = { sharpen: { amount: 40, enabled: false }, blur: { radius: 3 }, lut: { intensity: 50, enabled: false } };
    expect(activeVideoEffects(effects)).toEqual({ sharpen: null, blur: { radius: 3 }, colorCorrection: null, creative: null, curves: null, colorWheels: null, vignette: null, lut: null });
    expect(hasVideoEffects(effects)).toBe(true);
    expect(hasVideoEffects({ sharpen: { amount: 40, enabled: false } })).toBe(false);
  });

  it("renders a clip with every effect bypassed like a clip without effects, in preview and export alike", () => {
    const plain = timelineClipSchema.parse(base);
    const bypassed = timelineClipSchema.parse({
      ...base,
      look: { opacity: 40, temperature: 50, enabled: false },
      chromaKey: { color: "#00ff00", tolerance: 20, enabled: false },
      transition: { type: "fade", durationMs: 500, enabled: false },
      sharpen: { amount: 40, enabled: false },
      blur: { radius: 3, enabled: false },
      colorCorrection: { exposure: 1, brightness: 40, contrast: 0, saturation: 100, enabled: false },
      vignette: { amount: 30, enabled: false },
      lut: { intensity: 50, enabled: false },
    });
    expect(clipVisualSettings(bypassed)).toEqual(clipVisualSettings(plain));
    expect(clipFrameStyle(clipVisualSettings(bypassed), 0).opacity).toBe(1);
    expect(hasVideoEffects(clipVisualSettings(bypassed))).toBe(false);
  });
});
