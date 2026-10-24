import { expect, it } from "vitest";
import { applyLassoStroke } from "./imageLasso";
import { createImageEditScene, imageLassoContours, imageSceneSchema, resizeImageNode, type ImageNode, type ImagePoint } from "./imageScene";
import { compileImageEdits } from "./imageEditing";
import { parseProjectConfig } from "./project";
import fixture from "../../fixtures/project-v1-image.json";

const rect = (x: number, y: number, width: number, height: number): ImagePoint[] => [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
const empty = () => createImageEditScene({ name: "Source", relativePath: "media/source.png", width: 1000, height: 1000 });
const contains = (node: ImageNode, x: number, y: number) => imageLassoContours(node).reduce((inside, ring) => ring.reduce((hit, a, index) => {
  const b = ring[(index + 1) % ring.length];
  return (a.y > y) !== (b.y > y) && x < a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y) ? !hit : hit;
}, inside), false);

it("unions overlapping lassos, preserves prompts, and leaves a disjoint addition separate", () => {
  let result = applyLassoStroke(empty(), rect(100, 100, 300, 300), "new", "image-root");
  const firstId = result.id;
  result.scene.nodes[1].description = "Red flower";
  result = applyLassoStroke(result.scene, rect(500, 100, 200, 300), "add", firstId);
  expect(result.scene.nodes).toHaveLength(3);
  result.scene.nodes[2].description = "Green leaves";
  result = applyLassoStroke(result.scene, rect(300, 200, 300, 100), "add", firstId);
  expect(result.id).toBe(firstId);
  expect(result.scene.nodes).toHaveLength(2);
  expect(result.scene.nodes[1].description).toBe("Red flower\nGreen leaves");
  expect(contains(result.scene.nodes[1], 450, 250)).toBe(true);
  expect(contains(result.scene.nodes[1], 450, 150)).toBe(false);
});

it("subtracts holes, splits and full coverage, and ignores non-overlap including holes", () => {
  const original = applyLassoStroke(empty(), rect(100, 100, 600, 600), "new", "image-root");
  const hole = applyLassoStroke(original.scene, rect(200, 200, 100, 100), "subtract", original.id);
  expect(hole.scene.nodes[1].lassoContours).toHaveLength(1);
  expect(contains(hole.scene.nodes[1], 250, 250)).toBe(false);
  expect(contains(hole.scene.nodes[1], 150, 150)).toBe(true);
  const miss = applyLassoStroke(hole.scene, rect(220, 220, 10, 10), "subtract", hole.id);
  expect(miss.scene).toBe(hole.scene);
  const split = applyLassoStroke(hole.scene, rect(400, 0, 100, 800), "subtract", hole.id);
  expect(split.scene.nodes).toHaveLength(2);
  expect(contains(split.scene.nodes[1], 450, 150)).toBe(false);
  expect(contains(split.scene.nodes[1], 600, 150)).toBe(true);
  const gone = applyLassoStroke(split.scene, rect(0, 0, 1000, 1000), "subtract", split.id);
  expect(gone.scene.nodes).toHaveLength(1);
  expect(gone.id).toBe("image-root");
});

it("uses actual areas instead of bounding-box overlap and handles edge contact and self intersections", () => {
  const triangle = applyLassoStroke(empty(), [{ x: 100, y: 100 }, { x: 600, y: 100 }, { x: 100, y: 600 }], "new", "image-root");
  expect(applyLassoStroke(triangle.scene, rect(450, 450, 100, 100), "add", triangle.id).scene.nodes).toHaveLength(3);
  expect(applyLassoStroke(triangle.scene, rect(450, 450, 100, 100), "subtract", triangle.id).scene).toBe(triangle.scene);
  const box = applyLassoStroke(empty(), rect(100, 100, 100, 100), "new", "image-root");
  expect(applyLassoStroke(box.scene, rect(200, 100, 100, 100), "add", box.id).scene.nodes).toHaveLength(3);
  const crossed = applyLassoStroke(empty(), [{ x: 100, y: 100 }, { x: 500, y: 500 }, { x: 100, y: 500 }, { x: 500, y: 100 }], "new", "image-root");
  expect(applyLassoStroke(crossed.scene, rect(200, 80, 100, 80), "add", crossed.id).scene.nodes).toHaveLength(2);
});

it("moves, saves and compiles compound masks with their holes intact", () => {
  let result = applyLassoStroke(empty(), rect(100, 100, 400, 400), "new", "image-root");
  result = applyLassoStroke(result.scene, rect(200, 200, 100, 100), "subtract", result.id);
  result.scene.nodes[1].description = "Flower";
  const moved = resizeImageNode(result.scene, result.id, { x: 200, y: 300, width: 400, height: 400 });
  const restored = imageSceneSchema.parse(JSON.parse(JSON.stringify(moved)));
  expect(contains(restored.nodes[1], 350, 450)).toBe(false);
  expect(contains(restored.nodes[1], 250, 350)).toBe(true);
  const config = parseProjectConfig(fixture);
  config.imageScene = { ...restored, outputSize: { width: 512, height: 512 } };
  const edit = compileImageEdits(config).edits[0];
  expect(edit.maskContours).toHaveLength(2);
  expect(edit.maskPolygon).toBeUndefined();
  expect(edit.feather).toBe(0);
  expect(imageSceneSchema.safeParse({ ...moved, nodes: moved.nodes.map((node) => ({ ...node, lasso: undefined })) }).success).toBe(false);
});
