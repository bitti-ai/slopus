import { z } from "zod";

const boxSchema = z.object({ x: z.number().min(0).max(999), y: z.number().min(0).max(999), width: z.number().positive().max(1000), height: z.number().positive().max(1000) })
  .refine((box) => box.x + box.width <= 1000 && box.y + box.height <= 1000, "Placement must stay inside the image.");
export const imageNodeSchema = z.object({
  id: z.string().min(1), parentId: z.string().min(1).nullable(),
  kind: z.enum(["root", "group", "object", "text", "background"]),
  name: z.string().min(1).max(120), description: z.string(), text: z.string(),
  box: boxSchema.nullable(), colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(16),
});
export const imageSceneSchema = z.object({
  nodes: z.array(imageNodeSchema).min(1).max(500),
  background: z.string(),
  style: z.object({ mode: z.enum(["photo", "art"]), aesthetics: z.string(), lighting: z.string(), medium: z.string(), detail: z.string() }),
  steps: z.number().int().min(1).max(1000), seed: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  referenceIds: z.array(z.string().min(1)).max(100),
  outputAssetId: z.string().min(1).nullable(),
}).superRefine((scene, context) => {
  const ids = new Map(scene.nodes.map((node) => [node.id, node]));
  const roots = scene.nodes.filter((node) => node.kind === "root");
  const invalid = ids.size !== scene.nodes.length || roots.length !== 1 || roots[0]?.parentId !== null || scene.nodes.some((node) => {
    if (node.kind === "root") return false;
    const seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent) {
      if (seen.has(parent) || !ids.has(parent)) return true;
      seen.add(parent); parent = ids.get(parent)!.parentId;
    }
    return !seen.has(roots[0]?.id);
  });
  if (invalid) context.addIssue({ code: z.ZodIssueCode.custom, message: "Image nodes must form one connected tree with unique IDs." });
});
export type ImageScene = z.infer<typeof imageSceneSchema>;
export type ImageNode = z.infer<typeof imageNodeSchema>;
export type ImageBox = NonNullable<ImageNode["box"]>;

export function createImageScene(prompt = ""): ImageScene {
  return { nodes: [{ id: "image-root", parentId: null, kind: "root", name: "Image", description: prompt, text: "", box: null, colors: [] }],
    background: "", style: { mode: "photo", aesthetics: "", lighting: "", medium: "", detail: "" }, steps: 20, seed: -1, referenceIds: [], outputAssetId: null };
}
export function imageDescendants(scene: ImageScene, id: string): Set<string> {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of scene.nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true; }
  }
  return ids;
}
export function addImageNode(scene: ImageScene, parentId: string, kind: Exclude<ImageNode["kind"], "root">, box?: ImageBox): ImageScene {
  const node: ImageNode = { id: crypto.randomUUID(), parentId, kind, name: kind[0].toUpperCase() + kind.slice(1), description: "", text: "", colors: [], box: box ?? (kind === "background" ? null : { x: 250, y: 250, width: 500, height: 500 }) };
  return imageSceneSchema.parse({ ...scene, nodes: [...scene.nodes, node] });
}
export function removeImageNode(scene: ImageScene, id: string): ImageScene {
  if (scene.nodes.find((node) => node.id === id)?.kind === "root") return scene;
  const ids = imageDescendants(scene, id);
  return { ...scene, nodes: scene.nodes.filter((node) => !ids.has(node.id)) };
}
export function duplicateImageNode(scene: ImageScene, id: string): ImageScene {
  if (scene.nodes.find((node) => node.id === id)?.kind === "root") return scene;
  const ids = imageDescendants(scene, id);
  const replacements = new Map([...ids].map((old) => [old, crypto.randomUUID()]));
  return imageSceneSchema.parse({ ...scene, nodes: [...scene.nodes, ...scene.nodes.filter((node) => ids.has(node.id)).map((node) => ({ ...node, id: replacements.get(node.id)!, parentId: replacements.get(node.parentId!) ?? node.parentId, name: node.id === id ? `${node.name.slice(0, 115)} copy` : node.name }))] });
}
/** Moving or resizing a group transforms all its children's placement boxes. */
export function resizeImageNode(scene: ImageScene, id: string, box: ImageBox): ImageScene {
  const original = scene.nodes.find((node) => node.id === id)?.box;
  const descendants = imageDescendants(scene, id);
  return imageSceneSchema.parse({ ...scene, nodes: scene.nodes.map((node) => {
    if (node.id === id) return { ...node, box };
    if (!original || !node.box || !descendants.has(node.id)) return node;
    const x = Math.max(0, Math.min(999, Math.round(box.x + (node.box.x - original.x) * box.width / original.width)));
    const y = Math.max(0, Math.min(999, Math.round(box.y + (node.box.y - original.y) * box.height / original.height)));
    return { ...node, box: { x, y, width: Math.max(1, Math.min(1000 - x, Math.round(node.box.width * box.width / original.width))), height: Math.max(1, Math.min(1000 - y, Math.round(node.box.height * box.height / original.height))) } };
  }) });
}
/** H3 accepts prose, not ImgFab's Ideogram-specific caption JSON. Coordinates
 * are composition guidance in the prompt, not a guarantee of exact placement. */
export function imageScenePrompt(scene: ImageScene): string {
  const lines: string[] = [];
  const visit = (node: ImageNode, depth: number) => {
    const placement = node.box ? ` Placement: left ${node.box.x / 10}%, top ${node.box.y / 10}%, width ${node.box.width / 10}%, height ${node.box.height / 10}% of the image.` : "";
    const text = node.kind === "text" && node.text ? ` Render the exact text ${JSON.stringify(node.text)}.` : "";
    const colors = node.colors.length ? ` Colors: ${node.colors.join(", ")}.` : "";
    if (node.description.trim() || text || colors) lines.push(`${"  ".repeat(depth)}${node.kind}: ${node.description.trim()}${text}${placement}${colors}`);
    scene.nodes.filter((child) => child.parentId === node.id).forEach((child) => visit(child, depth + 1));
  };
  scene.nodes.filter((node) => node.kind === "root").forEach((node) => visit(node, 0));
  if (scene.background.trim()) lines.push(`Background: ${scene.background.trim()}`);
  const style = [scene.style.mode === "photo" ? "Photograph" : scene.style.medium || "Artwork", scene.style.aesthetics, scene.style.lighting, scene.style.detail].filter(Boolean).join(". ");
  return lines.length ? `Create a single still image.\n${lines.join("\n")}\nStyle: ${style}.` : "";
}
