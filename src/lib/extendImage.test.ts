import { expect, it } from "vitest";
import { alignExtendBounds, compileExtendImage, extendLayout, extendRegions, extendSourceDimensions, EXTEND_MAX_EDGE, EXTEND_MAX_PIXELS, initialExtendBounds } from "./extendImage";
import { createProjectConfig } from "./project";

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
  const large = initialExtendBounds(8192, 400);
  expect(large.width).toBe(EXTEND_MAX_EDGE);
  expect(large.width % 32).toBe(0);
  expect(large.height % 32).toBe(0);
  expect(large.x).toBeLessThan(0);
});

it("regenerates every new pixel to the outer edge in all directions", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "416p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt };
  for (const x of [-64, 0, 32]) for (const y of [-32, 0, 32]) {
    const { layout, edits } = compileExtendImage(config, source, "cache/canvas.png", { bounds: { x, y, width: 192, height: 128 }, prompt: "Forest", steps: 20, seed: 0 });
    const contains = (r: { x: number; y: number; width: number; height: number }, px: number, py: number) => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height;
    for (let py = 0; py < layout.output.height; py++) for (let px = 0; px < layout.output.width; px++) {
      if (!contains(layout.preserved, px, py)) expect(edits.some((edit) => edit.feather === 0 && contains(edit, px, py))).toBe(true);
    }
  }
});

it("keeps selection and output on the generation grid without increasing the source pixel count", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "16:9", resolution: "2048p", targetDurationSeconds: 15 });
  for (const source of [{ width: 400, height: 300 }, { width: 3648, height: 2048 }, { width: 2048, height: 3648 }, { width: 8192, height: 8192 }]) {
    const bounds = initialExtendBounds(source.width, source.height);
    const layout = extendLayout(config, source, bounds);
    for (const size of [bounds, layout.output]) {
      expect(size.width % 32).toBe(0); expect(size.height % 32).toBe(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(EXTEND_MAX_EDGE);
      expect(size.width * size.height).toBeLessThanOrEqual(EXTEND_MAX_PIXELS);
    }
    expect(layout.output.width * layout.output.height).toBeLessThanOrEqual(source.width * source.height);
    expect(layout.source.width).toBeLessThan(source.width);
    expect(layout.source.height).toBeLessThan(source.height);
    expect(Math.abs(layout.source.width / source.width - layout.source.height / source.height)).toBeLessThan(1 / Math.min(source.width, source.height));
    expect(layout.regions).toHaveLength(4);
    const workspace = extendSourceDimensions(source.width, source.height);
    expect(bounds.x + bounds.width).toBeGreaterThan(workspace.width);
    expect(bounds.y + bounds.height).toBeGreaterThan(workspace.height);
  }
});

it("uses the selected resolution budget and the same scaled geometry for preservation and inpainting", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "416p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt };
  const options = { bounds: { x: -64, y: -32, width: 256, height: 160 }, prompt: "Forest", steps: 20, seed: 0 };
  const compiled = compileExtendImage(config, source, "cache/source.png", options);
  expect(compiled.layout).toMatchObject({ output: { width: 128, height: 64 }, source: { width: 51, height: 38 }, bounds: { x: -38, y: -13, width: 128, height: 64 }, preserved: { x: 38, y: 13, width: 51, height: 38 } });
  expect(compiled.scene.sourceImage).toMatchObject({ width: 128, height: 64 });
  for (const edit of compiled.edits) { expect(edit.x + edit.width).toBeLessThanOrEqual(128); expect(edit.y + edit.height).toBeLessThanOrEqual(64); }
  const large = { width: 2048, height: 2048 };
  const layout = extendLayout(config, large, initialExtendBounds(large.width, large.height));
  expect(layout.output.width * layout.output.height).toBeLessThanOrEqual(416 * 416);
  expect(() => compileExtendImage(config, source, "cache/source.png", { ...options, bounds: { ...options.bounds, width: 257 } })).toThrow("multiples of 32");
});

it("aligns resize dimensions while preserving the opposite corner and caps every sizing path", () => {
  expect(alignExtendBounds({ x: -10, y: -7, width: 610, height: 455 }, "nw")).toEqual({ x: -8, y: 0, width: 608, height: 448 });
  for (const mode of ["draw", "nw", "e", "s"]) {
    const bounds = alignExtendBounds({ x: 0, y: 0, width: 9999, height: 9999 }, mode);
    expect(bounds.width % 32).toBe(0); expect(bounds.height % 32).toBe(0);
    expect(bounds.width * bounds.height).toBeLessThanOrEqual(EXTEND_MAX_PIXELS);
    expect(Math.max(bounds.width,bounds.height)).toBeLessThanOrEqual(EXTEND_MAX_EDGE);
  }
});
