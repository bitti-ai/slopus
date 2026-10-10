import { expect, it } from "vitest";
import { alignExtendBounds, compileExtendImage, extendContext, extendLayout, extendRegions, extendSourceDimensions, EXTEND_MAX_EDGE, EXTEND_MAX_PIXELS, initialExtendBounds } from "./extendImage";
import { createProjectConfig } from "./project";

it("partitions only new pixels for every combination of extension directions and crops", () => {
  for (const x of [-3, 0, 2]) for (const y of [-2, 0, 1]) for (const width of [5, 10]) for (const height of [4, 8]) {
    const { preserved, regions } = extendRegions({ width: 7, height: 5 }, { x, y, width, height });
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const inside = px + x >= 0 && px + x < 7 && py + y >= 0 && py + y < 5;
      const contains = (r: typeof preserved) => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height;
      expect(contains(preserved)).toBe(inside);
      expect(regions.filter(contains)).toHaveLength(inside ? 0 : 1);
    }
  }
});

it("rejects boxes with no original context, fractional or excessive dimensions", () => {
  for (const bounds of [
    { x: 100, y: 0, width: 20, height: 20 }, { x: -20, y: 0, width: 20, height: 20 },
    { x: -1.5, y: 0, width: 20, height: 20 },
    { x: -20, y: 0, width: 8193, height: 20 }, { x: NaN, y: 0, width: 20, height: 20 },
  ]) expect(() => extendRegions({ width: 100, height: 100 }, bounds)).toThrow();
  const large = initialExtendBounds(8192, 400);
  expect(large.width).toBe(EXTEND_MAX_EDGE);
  expect(large.width % 32).toBe(0);
  expect(large.height % 32).toBe(0);
  expect(large.x).toBeLessThan(0);
});

it("generates the entire surround in one pass while preserving the original in all directions", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "416p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt };
  for (const x of [-64, 0, 32]) for (const y of [-32, 0, 32]) {
    const { layout, edits } = compileExtendImage(config, source, "cache/canvas.png", { bounds: { x, y, width: 192, height: 128 }, prompt: "Forest", steps: 20, seed: 0 });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ ...extendContext(layout.preserved, layout.output), invertMask: true, feather: 0 });
    const contains = (r: { x: number; y: number; width: number; height: number }, px: number, py: number) => px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height;
    let allNewPixelsGenerated = true;
    for (let py = 0; py < layout.output.height; py++) for (let px = 0; px < layout.output.width; px++) {
      const generated = edits[0].invertMask && !contains(edits[0], px, py);
      if (!contains(layout.preserved, px, py) && !generated) allNewPixelsGenerated = false;
    }
    expect(allNewPixelsGenerated).toBe(true);
  }
});

it("uses the positioned canvas as context and reserves picture labels only for cited references", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 768, height: 768, createdAt: config.createdAt };
  const options = { bounds: { x: 0, y: 0, width: 1152, height: 1152 }, prompt: "", steps: 20, seed: 0 };
  const compile = (prompt: string) => compileExtendImage(config, source, "cache/canvas.png", { ...options, prompt });
  const withoutReferences = compile("");
  expect(withoutReferences.prompt).toMatch(/^integrated_multimodal_description:/);
  expect(withoutReferences.prompt).not.toContain("<Picture");
  expect(withoutReferences.prompt).toContain("Source scene's setting");
  expect(withoutReferences.prompt).not.toMatch(/zoomed out|continues above|continues below/);
  expect(withoutReferences.edits.every((edit) => edit.prompt === withoutReferences.prompt)).toBe(true);
  config.references = [{ id: "mood", name: "Mood", kind: "text", content: "Misty woodland", description: "", intendedUse: [], createdAt: config.createdAt }];
  expect(compile("@[ref:mood]").prompt).not.toContain("<Picture");
  for (let index = 1; index <= 9; index++) config.references.push({
    id: `ref-${index}`, name: `Tree ${index}`, kind: "image", relativePath: `references/${index}.png`, description: "", intendedUse: [], createdAt: config.createdAt,
  });
  const withReferences = compile(config.references.map((reference) => `@[ref:${reference.id}]`).join(" "));
  expect(withReferences.references).toHaveLength(10);
  for (let index = 1; index <= 9; index++) {
    expect(withReferences.prompt).toContain(`<Subject ${index + 1}> is Tree ${index}, providing appearance from <Picture ${index}>`);
  }
  expect(withReferences.prompt).not.toContain("<Picture 10>");
});

it("rejects an extension with too little preserved image to condition the generation", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 128, height: 96, createdAt: config.createdAt };
  expect(() => compileExtendImage(config, source, "cache/canvas.png", {
    bounds: { x: 127, y: 0, width: 192, height: 192 }, prompt: "", steps: 20, seed: 0,
  })).toThrow("Keep a larger area");
});

it("uses the selected output budget independently of source size, within the generation grid", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "16:9", resolution: "2048p", targetDurationSeconds: 15 });
  for (const source of [{ width: 400, height: 300 }, { width: 3648, height: 2048 }, { width: 2048, height: 3648 }, { width: 8192, height: 8192 }]) {
    const bounds = initialExtendBounds(source.width, source.height);
    const layout = extendLayout(config, source, bounds);
    for (const size of [bounds, layout.output]) {
      expect(size.width % 32).toBe(0); expect(size.height % 32).toBe(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(EXTEND_MAX_EDGE);
      expect(size.width * size.height).toBeLessThanOrEqual(EXTEND_MAX_PIXELS);
    }
    expect(layout.output.width * layout.output.height).toBeGreaterThan(EXTEND_MAX_PIXELS * 0.96);
    expect(layout.source.width).toBeLessThan(layout.output.width);
    expect(layout.source.height).toBeLessThan(layout.output.height);
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
  expect(compiled.layout).toMatchObject({ output: { width: 512, height: 320 }, source: { width: 256, height: 192 }, bounds: { x: -128, y: -64, width: 512, height: 320 }, preserved: { x: 128, y: 64, width: 256, height: 192 } });
  expect(compiled.scene.sourceImage).toMatchObject({ width: 512, height: 320 });
  expect(compiled.edits[0]).toMatchObject({ x: 144, y: 80, width: 224, height: 160 });
  const large = { width: 2048, height: 2048 };
  const layout = extendLayout(config, large, initialExtendBounds(large.width, large.height));
  expect(layout.output.width * layout.output.height).toBeLessThanOrEqual(416 * 416);
  expect(() => compileExtendImage(config, source, "cache/source.png", { ...options, bounds: { ...options.bounds, width: 257 } })).toThrow("multiples of 32");
});

it("shrinks the source when the selection expands, and grows output when resolution increases", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 15 });
  const source = { width: 768, height: 768 };
  const small = extendLayout(config, source, { x: -192, y: -192, width: 1152, height: 1152 });
  const large = extendLayout(config, source, { x: -384, y: -384, width: 1536, height: 1536 });
  expect(small.output).toEqual({ width: 768, height: 768 });
  expect(large.output).toEqual(small.output);
  expect(small.source).toEqual({ width: 512, height: 512 });
  expect(large.source).toEqual({ width: 384, height: 384 });
  const higher = extendLayout({ ...config, imageSettings: { ...config.settings, resolution: "1088p" } }, source, { x: -384, y: -384, width: 1536, height: 1536 });
  expect(higher.output).toEqual({ width: 1088, height: 1088 });
  expect(higher.source).toEqual({ width: 544, height: 544 });
});

it("frees seam rows only on edges that face generated space", () => {
  expect(extendContext({ x: 0, y: 0, width: 256, height: 256 }, { width: 384, height: 256 }))
    .toEqual({ x: 0, y: 0, width: 240, height: 256 });
  expect(extendContext({ x: 64, y: 32, width: 256, height: 256 }, { width: 384, height: 320 }))
    .toEqual({ x: 80, y: 48, width: 224, height: 224 });
  expect(() => extendContext({ x: 16, y: 16, width: 32, height: 32 }, { width: 64, height: 64 })).toThrow("larger area");
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


it("regenerates contained crops and full-image boxes at the target budget", () => {
  const config = createProjectConfig({ name: "Crop", prompt: "", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 15 });
  const source = { id: "source", name: "Source", kind: "image" as const, mimeType: "image/png", width: 256, height: 256, createdAt: config.createdAt };
  for (const bounds of [{ x: 32, y: 64, width: 128, height: 96 }, { x: 0, y: 0, width: 256, height: 256 }]) {
    const compiled = compileExtendImage(config, source, "cache/crop.png", { bounds, prompt: "Fine fur", steps: 20, seed: 0 });
    expect(compiled.layout.mode).toBe("regenerate");
    expect(compiled.layout.regions).toEqual([]);
    expect(compiled.edits).toEqual([{ x: 0, y: 0, ...compiled.layout.output, strength: 0.65, invertMask: false, feather: 0, prompt: compiled.prompt }]);
    expect(compiled.layout.output.width * compiled.layout.output.height).toBeLessThanOrEqual(768 * 768);
    expect(compiled.layout.output.width).toBeGreaterThan(bounds.width);
    expect(compiled.prompt).toContain("Refine the selected crop in <Picture 1>");
    expect(compiled.prompt).toContain("Fine fur");
    expect(compiled.scene.sourceImage).toMatchObject(compiled.layout.output);
  }
  const small = extendLayout(config, { width: 8192, height: 8192 }, { x: 100, y: 100, width: 32, height: 32 });
  expect(small).toMatchObject({ mode: "regenerate", source: { width: 768, height: 768 }, bounds: { x: 0, y: 0, width: 768, height: 768 } });
  const crossing = extendLayout(config, source, { x: -1, y: 64, width: 128, height: 96 });
  expect(crossing.mode).toBe("outpaint");
});


it("rejects an extension that disappears when mapped to a lower resolution", () => {
  const config = createProjectConfig({ name: "Extend", prompt: "", aspectRatio: "1:1", resolution: "416p", targetDurationSeconds: 15 });
  expect(() => extendLayout(config, { width: 1024, height: 1024 }, { x: -1, y: 0, width: 1024, height: 1024 })).toThrow("Expand the box further");
});
