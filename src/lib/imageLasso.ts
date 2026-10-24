import ClipperLib from "clipper-lib";
import { imageLassoContours, imageSceneSchema, type ImageNode, type ImagePoint, type ImageScene } from "./imageScene";

// Integer clipping retains subpixel accuracy even at the largest output size.
const SCALE = 10000;
function clip(subject: ImagePoint[][], operand: ImagePoint[][], operation: ClipperLib.ClipType): ImagePoint[][] {
  const paths = (contours: ImagePoint[][]) => contours.map((points) => points.map(({ x, y }) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  const engine = new ClipperLib.Clipper();
  engine.StrictlySimple = true;
  engine.AddPaths(paths(subject), ClipperLib.PolyType.ptSubject, true);
  engine.AddPaths(paths(operand), ClipperLib.PolyType.ptClip, true);
  const result: ClipperLib.Paths = [];
  if (!engine.Execute(operation, result, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd)) throw new Error("Could not combine these lasso areas.");
  return result.map((points) => points.map(({ X, Y }) => ({ x: X / SCALE, y: Y / SCALE })));
}

function shape(contours: ImagePoint[][]): Pick<ImageNode, "box" | "lasso" | "lassoContours"> {
  const points = contours.flat();
  const x = Math.min(...points.map((point) => point.x)), y = Math.min(...points.map((point) => point.y));
  const width = Math.max(...points.map((point) => point.x)) - x, height = Math.max(...points.map((point) => point.y)) - y;
  const normalized = contours.map((ring) => ring.map((point) => ({ x: Math.max(0, Math.min(1000, (point.x - x) / width * 1000)), y: Math.max(0, Math.min(1000, (point.y - y) / height * 1000)) })));
  return { box: { x, y, width, height }, lasso: normalized[0], lassoContours: normalized.length > 1 ? normalized.slice(1) : undefined };
}

/** One atomic scene edit, including holes/splits and preservation of authored prompts. */
export function applyLassoStroke(scene: ImageScene, points: ImagePoint[], mode: "new" | "add" | "subtract", selectedId: string): { scene: ImageScene; id: string } {
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const stroke = clip([points], [], ClipperLib.ClipType.ctUnion);
  if (!stroke.length) return { scene, id: selectedId };
  const overlaps = mode === "new" ? [] : scene.nodes.filter((node) => node.lasso && clip(imageLassoContours(node), stroke, ClipperLib.ClipType.ctIntersection).length);
  if (!overlaps.length) {
    if (mode === "subtract") return { scene, id: selectedId };
    const node: ImageNode = { id: crypto.randomUUID(), parentId: root.id, kind: "object", name: "Lasso", description: "", text: "", colors: [], ...shape(mode === "new" ? [points] : stroke) };
    return { scene: imageSceneSchema.parse({ ...scene, nodes: [...scene.nodes, node] }), id: node.id };
  }
  const removed = new Map<string, string>();
  const replacements = new Map<string, ImageNode>();
  let id = selectedId;
  if (mode === "add") {
    const target = overlaps.find((node) => node.id === selectedId) ?? overlaps[0];
    let combined = stroke;
    for (const node of overlaps) combined = clip(combined, imageLassoContours(node), ClipperLib.ClipType.ctUnion);
    const ordered = [target, ...overlaps.filter((node) => node !== target)];
    replacements.set(target.id, { ...target, ...shape(combined), description: [...new Set(ordered.map((node) => node.description.trim()).filter(Boolean))].join("\n"),
      referenceIds: [...new Set(ordered.flatMap((node) => node.referenceIds ?? []))] });
    for (const node of overlaps) if (node !== target) removed.set(node.id, target.id);
    id = target.id;
  } else {
    for (const node of overlaps) {
      const remaining = clip(imageLassoContours(node), stroke, ClipperLib.ClipType.ctDifference);
      if (remaining.length) replacements.set(node.id, { ...node, ...shape(remaining) });
      else removed.set(node.id, node.parentId ?? root.id);
    }
    id = replacements.has(selectedId) ? selectedId : replacements.keys().next().value ?? root.id;
  }
  const nodes = scene.nodes.filter((node) => !removed.has(node.id)).map((node) => {
    const updated = replacements.get(node.id) ?? node;
    let parentId = updated.parentId;
    const visited = new Set<string>();
    while (parentId && removed.has(parentId) && !visited.has(parentId)) { visited.add(parentId); parentId = removed.get(parentId)!; }
    return parentId === updated.parentId ? updated : { ...updated, parentId };
  });
  return { scene: imageSceneSchema.parse({ ...scene, nodes }), id };
}
