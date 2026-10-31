import { expect, it } from "vitest";
import { parseProjectConfig } from "./project";
import { addImageNode, createImageEditScene } from "./imageScene";
import { compileImageEdits, editGeneratedImage, imageEditSize, imageEditCanvasSize, imageEditRegionSize, limitImageEditScene } from "./imageEditing";
import fixture from "../../fixtures/project-v1-image.json";

it.each([
  [1001, 809, 1024, 832], [809, 1001, 832, 1024], [640, 480, 640, 480], [17, 31, 32, 32],
])("aligns a %i × %i source to %i × %i", (width, height, expectedWidth, expectedHeight) => {
  expect(imageEditSize({ width, height })).toEqual({ width: expectedWidth, height: expectedHeight });
});

it("keeps local edits in original pixels when the target is smaller and validates saved dimensions", () => {
  const config = parseProjectConfig(fixture);
  config.imageScene = addImageNode(createImageEditScene({ relativePath: "media/source.png", name: "Source", width: 1001, height: 809 }), "image-root", "object", { x: 750, y: 750, width: 250, height: 250 });
  config.imageScene.nodes[1].description = "Add a balloon";
  config.imageScene.outputSize = { width: 672, height: 544 };
  expect(compileImageEdits(config).edits[0]).toMatchObject({ x: 750, y: 606, width: 251, height: 203 });
  expect(imageEditCanvasSize(config.imageScene)).toEqual({ width: 1001, height: 809 });
  expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).imageScene).toEqual(config.imageScene);
  config.imageScene.outputSize.width = 673;
  expect(() => parseProjectConfig(config)).toThrow();
});

it.each([undefined, { width: 4352, height: 6560 }])("always crops local edits on a 4352 by 6529 source with target %j", (outputSize) => {
  const config = parseProjectConfig(fixture);
  config.imageScene = addImageNode(createImageEditScene({ relativePath: "source.png", name: "Large", width: 4352, height: 6529 }), "image-root", "object", { x: 900, y: 900, width: 100, height: 100 });
  config.imageScene.outputSize = outputSize;
  config.imageScene.nodes[1].description = "Change the flower";
  expect(imageEditCanvasSize(config.imageScene)).toEqual({ width: 4352, height: 6529 });
  expect(imageEditRegionSize(config.imageScene)).toEqual({ width: 4352, height: 6560 });
  expect(compileImageEdits(config).edits[0]).toMatchObject({ x: 3916, y: 5876, width: 436, height: 653 });
});

it("uses hierarchy order, skips empty groups, and converts boxes to original pixel dimensions", () => {
  const config = parseProjectConfig(fixture);
  let scene = createImageEditScene({ relativePath: "media/imported/source.png", name: "Source", width: 101, height: 77 });
  scene = addImageNode(scene, "image-root", "group");
  const group = scene.nodes[1].id;
  scene = addImageNode(scene, "image-root", "object");
  scene.nodes[2].description = "A blue boat";
  scene = addImageNode(scene, group, "object", { x: 900, y: 900, width: 100, height: 100 });
  scene.nodes[3].description = "A red balloon";
  scene.nodes[3].colors = ["#FF0000"];
  config.imageScene = scene;
  config.settings.defaultLook = "watercolor";
  const { edits } = compileImageEdits(config);
  expect(edits).toHaveLength(2);
  expect(edits[0]).toMatchObject({ x: 90, y: 69, width: 11, height: 8 });
  expect(edits[0].prompt).toContain("A red balloon");
  expect(edits[0].prompt).not.toMatch(/Use these colors|#FF0000/);
  expect(edits[1]).toMatchObject({ x: 25, y: 19, width: 51, height: 39 });
  expect(edits[1].prompt).toContain("A blue boat");
  expect(edits[0].prompt).not.toContain("watercolor");
  expect(edits[0].prompt).toContain("[Shot 1]");
  expect(edits[0].prompt.match(/^\w+:/gm)).toEqual(["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]);
  expect(edits[0].prompt).toContain("<Picture 1> is the original source image");
  expect(edits[0].prompt).toContain("[keyframe completion]");
  expect(edits[0].prompt).toContain("<Picture 1> ([Shot 1] edited keyframe): partially_preserved");
  expect(edits[0].prompt).toContain("[Shot 1] The edited keyframe corresponds to <Picture 1>");
  expect(edits[0].prompt).not.toMatch(/<Subject|video editing|A still photograph/);
  for (const edit of edits) expect(edit.prompt).not.toMatch(/\b(box|mask\w*|rectangle|region|boundary|border|pixels?)\b/i);
  scene.nodes[3].box = null;
  expect(() => compileImageEdits(config)).toThrow("placement box");
});

it("reserves Picture 1 for the source and counts it toward H3's nine-picture limit", () => {
  const config = parseProjectConfig(fixture);
  config.imageScene = addImageNode(createImageEditScene({ relativePath: "media/imported/source.png", name: "Source", width: 101, height: 77 }), "image-root", "object");
  config.imageScene.nodes[1].description = "A red balloon";
  config.references = Array.from({ length: 9 }, (_, index) => ({ id: `ref-${index}`, kind: "image" as const, name: `Reference ${index}`, description: "Red satin", relativePath: `references/${index}.png`, intendedUse: [], createdAt: config.createdAt }));
  const mention = (count: number) => `A red balloon ${config.references.slice(0, count).map((reference) => `@[ref:${reference.id}]`).join(" ")}`;
  config.imageScene.nodes[1].description = mention(8);
  const prompt = compileImageEdits(config).edits[0].prompt;
  expect(prompt).toContain("<Subject 1> is Reference 0, providing appearance from <Picture 2>");
  expect(prompt).toContain("<Subject 8> is Reference 7, providing appearance from <Picture 9>");
  expect(prompt).toContain("[keyframe completion + reference generation]");
  expect(prompt).not.toMatch(/\b(box|mask\w*|rectangle|region|boundary|border|pixels?)\b/i);
  config.imageScene.nodes[1].description = mention(9);
  expect(() => compileImageEdits(config)).toThrow("at most nine reference images");
});

it("starts with a clean image root and requires described edits before submission", () => {
  const config = parseProjectConfig(fixture);
  config.assets.push({ id: "source", name: "Source", relativePath: "media/generated/source.jpg", mimeType: "image/jpeg", width: 101, height: 77, kind: "image", createdAt: config.createdAt });
  const edited = editGeneratedImage(config, "source");
  expect(edited.imageScene).toMatchObject({ rootType: "image", sourceImage: { width: 101, height: 77 }, outputAssetId: null });
  expect(edited.imageScene!.nodes).toHaveLength(1);
  expect(edited.imageScene!.nodes[0].description).toBe("");
  expect(() => compileImageEdits(edited)).toThrow("Enter a whole-image edit prompt");
  edited.imageScene = addImageNode(edited.imageScene!, "image-root", "object");
  edited.imageScene.nodes[1].colors = ["#FF0000"];
  expect(() => compileImageEdits(edited)).toThrow("Describe the edit");
  expect(config.imageScene!.nodes.length).toBeGreaterThan(1);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(edited))).imageScene).toEqual(edited.imageScene);
});

it("applies whole-image actions first and compiles only the references each edit cites", () => {
  const config = parseProjectConfig(fixture);
  config.imageScene = createImageEditScene({ relativePath: "media/source.png", name: "Source", width: 101, height: 77 });
  config.references = ["Lighting", "Balloon", "Unused"].map((name) => ({ id: name, name, kind: "image", description: name, relativePath: `references/${name}.png`, intendedUse: [], createdAt: config.createdAt }));
  const root = config.imageScene.nodes[0];
  root.description = "Warm up the entire image like @[ref:Lighting]";
  // Stored ids no longer choose anything: only citations do.
  root.referenceIds = ["Unused"];
  expect(compileImageEdits(config).edits).toHaveLength(1);
  config.imageScene = addImageNode(config.imageScene, root.id, "object");
  Object.assign(config.imageScene.nodes[1], { description: "Add a @[ref:Balloon]" });
  let edits = compileImageEdits(config).edits;
  expect(edits[0]).toMatchObject({ x: 0, y: 0, width: 101, height: 77, feather: 0 });
  expect(edits[1].feather).toBeUndefined();
  expect(edits[0].prompt).toContain("Warm up the entire image like <Subject 1>");
  expect(edits[0].prompt).toContain("<Subject 1> is Lighting, providing appearance from <Picture 2>");
  expect(edits[0].prompt).not.toContain("Balloon");
  expect(edits[1].prompt).toContain("<Subject 1> is Balloon, providing appearance from <Picture 2>");
  expect(edits[1].prompt).not.toContain("Lighting");
  expect(edits.map((edit) => edit.references.map((reference) => reference.id))).toEqual([["Lighting"], ["Balloon"]]);
  config.imageScene.referenceIds = ["Unused"];
  config.imageScene.nodes[1].description = "Add a balloon";
  edits = compileImageEdits(config).edits;
  expect(edits[1].references).toEqual([]);
  config.imageScene.nodes[1].description = "Add a @[ref:missing]";
  expect(() => compileImageEdits(config)).toThrow("The prompt cites a reference that no longer exists.");
});

it("caps a local box at the target while keeping feathering against the larger original", () => {
  const config = parseProjectConfig(fixture);
  config.imageScene = addImageNode(createImageEditScene({ relativePath: "media/source.png", name: "Source", width: 1001, height: 809 }), "image-root", "object", { x: 0, y: 0, width: 1000, height: 1000 });
  config.imageScene.outputSize = { width: 672, height: 544 };
  config.imageScene.nodes[1].description = "Warm up the lighting";
  expect(compileImageEdits(config).edits[0]).toMatchObject({ x: 0, y: 0, width: 672, height: 544 });
  expect(compileImageEdits(config).edits[0].feather).toBeUndefined();
  // A local edit touching the canvas edge still blends with the rest of the image.
  config.imageScene.nodes[1].box!.width = 500;
  expect(compileImageEdits(config).edits[0].feather).toBeUndefined();
});

it("bounds lasso outlines and multiple local edits without moving their source positions", () => {
  const config = parseProjectConfig(fixture);
  let scene = createImageEditScene({ relativePath: "source.png", name: "Large", width: 4096, height: 3072 });
  scene.outputSize = { width: 1024, height: 768 };
  scene = addImageNode(scene, "image-root", "object", { x: 500, y: 500, width: 500, height: 500 });
  Object.assign(scene.nodes[1], { description: "A flower", lasso: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 1000 }] });
  scene = addImageNode(scene, "image-root", "object", { x: 100, y: 100, width: 50, height: 50 });
  scene.nodes[2].description = "A bee";
  config.imageScene = limitImageEditScene(scene);
  expect(config.imageScene.nodes[1].box).toEqual({ x: 500, y: 500, width: 250, height: 250 });
  const edits = compileImageEdits(config).edits;
  expect(edits[0]).toMatchObject({ x: 2048, y: 1536, width: 1024, height: 768,
    maskPolygon: [{ x: 2048, y: 1536 }, { x: 3072, y: 1536 }, { x: 2048, y: 2304 }] });
  expect(edits[1]).toMatchObject({ x: 409, y: 307, width: 206, height: 154 });
});

it("uses plain Fibo edit instructions, preserves structured JSON and rejects extra pictures", () => {
  const config = parseProjectConfig(fixture);
  config.imageScene = createImageEditScene({ name: "Source", relativePath: "media/source.png", width: 512, height: 512 });
  const compile = () => compileImageEdits(config, { modelType: "fibo2" });
  config.imageScene.nodes[0].description = "Make the sky blue";
  expect(compile().edits[0]).toMatchObject({ prompt: "Make the sky blue.", references: [], feather: 0 });
  const json = '{"edit_instruction":"Make the sky blue","structured_caption":{"sky":"Blue"}}';
  config.imageScene.nodes[0].description = json;
  expect(compile().edits[0].prompt).toBe(json);
  config.references = [{ id: "extra", kind: "image", name: "Extra", relativePath: "references/extra.png", description: "", intendedUse: [], createdAt: config.createdAt }];
  config.imageScene.nodes[0].description = "Use @[ref:extra]";
  expect(compile).toThrow(/source image only/);
});
