import { z } from "zod";

const boxSchema = z.object({ x: z.number().min(0).max(999), y: z.number().min(0).max(999), width: z.number().positive().max(1000), height: z.number().positive().max(1000) })
  .refine((box) => box.x + box.width <= 1000 && box.y + box.height <= 1000, "Placement must stay inside the image.");
export const imageNodeSchema = z.object({
  id: z.string().min(1), parentId: z.string().min(1).nullable(),
  kind: z.enum(["root", "group", "object", "text", "background"]),
  name: z.string().min(1).max(120), description: z.string(), text: z.string(),
  referenceIds: z.array(z.string().min(1)).max(100).optional(),
  box: boxSchema.nullable(), colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(16),
});
export const imageSourceSchema = z.object({
  relativePath: z.string().min(1).refine((path) => !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !path.split("/").includes(".."), "Image source must be a project-relative path."),
  name: z.string().min(1), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192),
});
export type ImageSource = z.infer<typeof imageSourceSchema>;
export const imageSceneSchema = z.object({
  rootType: z.enum(["prompt", "image"]).optional(),
  sourceImage: imageSourceSchema.nullish(),
  nodes: z.array(imageNodeSchema).min(1).max(500),
  background: z.string(),
  style: z.object({ mode: z.enum(["none", "photo", "art"]), aesthetics: z.string(), lighting: z.string(), medium: z.string(), detail: z.string() }),
  steps: z.number().int().min(2).max(1000), seed: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
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

export const imageSceneReferenceIds = (scene: ImageScene): string[] =>
  [...new Set([...scene.referenceIds, ...scene.nodes.flatMap((node) => node.referenceIds ?? [])])];

/** Every authored line of the scene a reference can be cited in as @[ref:<id>]. */
export const imageScenePromptText = (scene: ImageScene): string =>
  [...scene.nodes.map((node) => node.description), scene.background].join("\n");

export function createImageScene(prompt = ""): ImageScene {
  return { nodes: [{ id: "image-root", parentId: null, kind: "root", name: "Image", description: prompt, text: "", box: null, colors: [] }],
    background: "", style: { mode: "none", aesthetics: "", lighting: "", medium: "", detail: "" }, steps: 20, seed: -1, referenceIds: [], outputAssetId: null };
}
export function createImageEditScene(sourceImage: ImageSource | null, previous?: ImageScene): ImageScene {
  return { ...createImageScene(), rootType: "image", sourceImage,
    steps: previous?.steps ?? 20, seed: previous?.seed ?? -1, referenceIds: previous?.referenceIds ?? [] };
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
const sentence = (text: string) => /[.!?。！？]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

/** Visual content only. The compiler places style before or after [Shot 1]
 * according to H3's reference or base format. Boxes and palettes are omitted. */
export function imageScenePromptParts(scene: ImageScene, look?: string): { style: string; composition: string } | null {
  const root = scene.nodes.find((node) => node.kind === "root")!;
  const hasContent = scene.background.trim() || scene.nodes.some((node) => node.description.trim() || (node.kind === "text" && node.text));
  if (!hasContent) return null;
  const treatment = [
    ...(look?.trim() ? [`${look.trim()} visual style`] : []),
    ...(scene.style.aesthetics.trim() ? [`${scene.style.aesthetics.trim()} aesthetics`] : []),
    ...(scene.style.lighting.trim() ? [`${scene.style.lighting.trim()} lighting`] : []),
    ...(scene.style.detail.trim() ? [`${scene.style.detail.trim()} ${scene.style.mode === "photo" ? "camera and lens characteristics" : "art style"}`] : []),
  ];
  const medium = scene.style.mode === "photo" ? "A still photograph" : `A still image in ${scene.style.medium.trim() || "an artistic medium"}`;
  const style = scene.style.mode === "none" ? "" : sentence(`${medium}${treatment.length ? ` with ${treatment.join(", ")}` : ""}`);
  const lines: string[] = [
    ...(root.description.trim() ? [sentence(root.description)] : []),
    ...(scene.background.trim() ? [`Background: ${sentence(scene.background)}`] : []),
  ];
  const visit = (node: ImageNode, depth: number) => {
    const children = scene.nodes.filter((child) => child.parentId === node.id);
    const description = node.description.trim() ? sentence(node.description) : "";
    // Quote visible lettering verbatim, including its language and line breaks.
    const text = node.kind === "text" && node.text ? `Render the exact text "${node.text}".` : "";
    const subject = node.kind === "group" ? "A grouped arrangement." : node.kind === "text" ? "Visible lettering." : node.kind === "background" ? "A background element." : "";
    const detail = [subject, description, text, ...(children.length ? ["Its composition includes:"] : [])].filter(Boolean).join(" ");
    if (detail) lines.push(`${"  ".repeat(depth)}${detail}`);
    children.forEach((child) => visit(child, depth + 1));
  };
  scene.nodes.filter((node) => node.parentId === root.id).forEach((node) => visit(node, 0));
  return { style, composition: lines.join("\n") };
}

export function imageScenePrompt(scene: ImageScene, look?: string): string {
  const parts = imageScenePromptParts(scene, look);
  return parts ? [parts.style, parts.composition].filter(Boolean).join("\n") : "";
}
