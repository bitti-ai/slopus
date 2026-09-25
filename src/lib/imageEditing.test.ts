import { expect, it } from "vitest";
import { parseProjectConfig } from "./project";
import { addImageNode, createImageEditScene } from "./imageScene";
import { compileImageEdits, editGeneratedImage } from "./imageEditing";
import fixture from "../../fixtures/project-v1-image.json";

it("uses hierarchy order, skips empty groups, and converts boxes to original pixels", () => {
  const config = parseProjectConfig(fixture);
  let scene = createImageEditScene({ relativePath: "media/imported/source.png", name: "Source", width: 101, height: 77 });
  scene = addImageNode(scene, "image-root", "group");
  const group = scene.nodes[1].id;
  scene = addImageNode(scene, "image-root", "object");
  scene.nodes[2].description = "A blue boat";
  scene = addImageNode(scene, group, "object", { x: 900, y: 900, width: 100, height: 100 });
  scene.nodes[3].description = "A red balloon";
  config.imageScene = scene;
  config.settings.defaultLook = "watercolor";
  const { edits } = compileImageEdits(config);
  expect(edits).toHaveLength(2);
  expect(edits[0]).toMatchObject({ x: 90, y: 69, width: 11, height: 8 });
  expect(edits[0].prompt).toContain("A red balloon");
  expect(edits[1]).toMatchObject({ x: 25, y: 19, width: 51, height: 39 });
  expect(edits[1].prompt).toContain("A blue boat");
  expect(edits[0].prompt).not.toContain("watercolor");
  expect(edits[0].prompt).toContain("[Shot 1]");
  scene.nodes[3].box = null;
  expect(() => compileImageEdits(config)).toThrow("placement box");
});

it("starts with a clean image root and requires described edits before submission", () => {
  const config = parseProjectConfig(fixture);
  config.assets.push({ id: "source", name: "Source", relativePath: "media/generated/source.jpg", mimeType: "image/jpeg", width: 101, height: 77, kind: "image", createdAt: config.createdAt });
  const edited = editGeneratedImage(config, "source");
  expect(edited.imageScene).toMatchObject({ rootType: "image", sourceImage: { width: 101, height: 77 }, outputAssetId: null });
  expect(edited.imageScene!.nodes).toHaveLength(1);
  expect(edited.imageScene!.nodes[0].description).toBe("");
  expect(() => compileImageEdits(edited)).toThrow("Add an Object");
  edited.imageScene = addImageNode(edited.imageScene!, "image-root", "object");
  expect(() => compileImageEdits(edited)).toThrow("Describe the edit");
  expect(config.imageScene!.nodes.length).toBeGreaterThan(1);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(edited))).imageScene).toEqual(edited.imageScene);
});
