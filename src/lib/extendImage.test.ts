import { expect, it } from "vitest";
import { extendRegions, initialExtendBounds } from "./extendImage";

it("partitions only new pixels for every combination of extension directions and crops", () => {
  for (const x of [-3, 0, 2]) for (const y of [-2, 0, 1]) for (const width of [5, 10]) for (const height of [4, 8]) {
    if (x >= 0 && y >= 0 && x + width <= 7 && y + height <= 5) continue;
    const { preserved, regions } = extendRegions({ width: 7, height: 5 }, { x, y, width, height });
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const inside = px + x >= 0 && px + x < 7 && py + y >= 0 && py + y < 5;
      const contains = (r: typeof preserved) => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height;
      expect(contains(preserved)).toBe(inside);
      expect(regions.filter(contains)).toHaveLength(inside ? 0 : 1);
    }
  }
});

it("rejects boxes with no original context, no extension, fractional or excessive dimensions", () => {
  for (const bounds of [
    { x: 100, y: 0, width: 20, height: 20 }, { x: -20, y: 0, width: 20, height: 20 },
    { x: 0, y: 0, width: 20, height: 20 }, { x: -1.5, y: 0, width: 20, height: 20 },
    { x: -20, y: 0, width: 8193, height: 20 }, { x: NaN, y: 0, width: 20, height: 20 },
  ]) expect(() => extendRegions({ width: 100, height: 100 }, bounds)).toThrow();
  expect(initialExtendBounds(8192, 400)).toEqual({ x: -0, y: -100, width: 8192, height: 600 });
});
