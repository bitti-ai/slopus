import { imageDescendants, imageSceneSchema, type ImageNode, type ImageScene } from "./imageScene";

// Like ImgFab, node copying uses an in-app clipboard, separate from text copying.
let clipboard: ImageNode[] | null = null;
const listeners = new Set<() => void>();
export const getImageNodeClipboard = () => clipboard;
export function subscribeImageNodeClipboard(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function copyImageNode(scene: ImageScene, id: string) {
  const node = scene.nodes.find((item) => item.id === id);
  if (!node || node.kind === "root") return;
  const descendants = imageDescendants(scene, id);
  clipboard = structuredClone([node, ...scene.nodes.filter((item) => item.id !== id && descendants.has(item.id))]);
  listeners.forEach((listener) => listener());
}
export function pasteImageNode(scene: ImageScene, parentId: string) {
  if (!clipboard) return null;
  const ids = new Map(clipboard.map((node) => [node.id, crypto.randomUUID()]));
  const nodes = structuredClone(clipboard).map((node, index) => ({ ...node, id: ids.get(node.id)!, parentId: index === 0 ? parentId : ids.get(node.parentId!)! }));
  return { scene: imageSceneSchema.parse({ ...scene, nodes: [...scene.nodes, ...nodes] }), id: nodes[0].id };
}
