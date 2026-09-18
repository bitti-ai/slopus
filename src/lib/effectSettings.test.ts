import { describe, expect, it } from "vitest";
import { parseCube } from "./effectSettings";
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
  it.each([
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 66"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_1D_SIZE 2"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nDOMAIN_MAX 0 1 1"),
    identityCube.replace("LUT_3D_SIZE 2", "LUT_3D_SIZE 2\nLUT_3D_SIZE 2"),
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
    colorCorrection: { exposure: 1, contrast: 20, saturation: 80 },
    lut: { intensity: 70, table: parseCube(identityCube, "identity.cube") },
  });
  const reopened = timelineClipSchema.parse(JSON.parse(JSON.stringify(clip)));
  expect(clipFrameStyle(clipVisualSettings(reopened), 500)).toMatchObject({
    sharpen: clip.sharpen, blur: clip.blur, vignette: clip.vignette, colorCorrection: clip.colorCorrection, lut: clip.lut,
  });
  expect(timelineClipSchema.safeParse({ ...clip, blur: { radius: 25 } }).success).toBe(false);
  expect(timelineClipSchema.safeParse({ ...clip, lut: { ...clip.lut, table: { ...clip.lut!.table, values: [] } } }).success).toBe(false);
});
