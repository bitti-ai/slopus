import { z } from "zod";
import { imageDescendants, imageNodeSchema, imageSceneSchema, removeImageNode, resizeImageNode, type ImageScene } from "./imageScene";

const id = z.string().min(1);
const before = id.nullish();
const editableNode = imageNodeSchema.pick({ name: true, description: true, text: true, box: true, colors: true, referenceIds: true }).partial();
const authoredScene = imageSceneSchema.innerType().omit({ outputAssetId: true, rootType: true, sourceImage: true });
const configuration = authoredScene.omit({ nodes: true, style: true }).partial().extend({ prompt: z.string().optional(), style: authoredScene.shape.style.partial().strict().optional() });
export const imageCommandSchema = z.discriminatedUnion("op", [
  authoredScene.extend({ op: z.literal("image.set") }).strict(),
  configuration.extend({ op: z.literal("image.configure") }).strict(),
  editableNode.extend({ op: z.literal("image.node.add"), id, parent: id, name: imageNodeSchema.shape.name, kind: z.enum(["object", "text", "group", "background"]), before }).strict(),
  editableNode.extend({ op: z.literal("image.node.set"), id }).strict(),
  z.object({ op: z.literal("image.node.move"), id, parent: id, before }).strict(),
  z.object({ op: z.literal("image.node.duplicate"), id, newId: id, parent: id.optional(), before }).strict(),
  z.object({ op: z.literal("image.node.remove"), id }).strict(),
]);
export type ImageCommand = z.infer<typeof imageCommandSchema>;

/** Apply one authored operation to a private copy. Generated output never
 * enters the command vocabulary and cannot be overwritten by an agent. */
export function applyImageCommand(current: ImageScene, command: ImageCommand): ImageScene {
  command = imageCommandSchema.parse(command);
  let scene = structuredClone(current);
  const node = (id: string) => {
    const found = scene.nodes.find((item) => item.id === id);
    if (!found) throw new Error(`Image node '${id}' was not found.`);
    return found;
  };
  const nonRoot = (id: string) => {
    const found = node(id);
    if (found.kind === "root") throw new Error("The image root cannot be moved, duplicated or removed.");
    return found;
  };
  const insert = (nodes: ImageScene["nodes"], parent: string, before?: string | null) => {
    node(parent);
    const index = before ? scene.nodes.findIndex((item) => item.id === before && item.parentId === parent) : scene.nodes.length;
    if (index < 0) throw new Error("The before node must be a child of the destination parent.");
    scene.nodes.splice(index, 0, ...nodes);
  };
  switch (command.op) {
    case "image.set": {
      const { op: _op, ...authored } = command;
      scene = { ...current, ...authored, outputAssetId: current.outputAssetId };
      break;
    }
    case "image.configure": {
      const { op: _op, prompt, style, ...settings } = command;
      if (prompt === undefined && !Object.values(settings).some((value) => value !== undefined) && !Object.values(style ?? {}).some((value) => value !== undefined)) throw new Error("Image settings have no fields to change.");
      scene = { ...scene, ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)), style: { ...scene.style, ...style } };
      if (prompt !== undefined) scene.nodes.find((item) => item.kind === "root")!.description = prompt;
      break;
    }
    case "image.node.add":
      insert([{ id: command.id, parentId: command.parent, kind: command.kind, name: command.name, description: command.description ?? "", text: command.text ?? "", box: command.box ?? null, colors: command.colors ?? [], ...(command.referenceIds ? { referenceIds: command.referenceIds } : {}) }], command.parent, command.before);
      break;
    case "image.node.set": {
      node(command.id);
      const { op: _op, id, box, ...patch } = command;
      const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (!Object.keys(fields).length && box === undefined) throw new Error("Image node update has no fields to change.");
      if (box) scene = resizeImageNode(scene, id, box);
      scene.nodes = scene.nodes.map((item) => item.id === id ? { ...item, ...fields, ...(box === null ? { box: null } : {}) } : item);
      break;
    }
    case "image.node.move": {
      const source = nonRoot(command.id);
      if (imageDescendants(scene, source.id).has(command.parent)) throw new Error("An image node cannot move inside its own subtree.");
      if (command.before === source.id) throw new Error("An image node cannot be placed before itself.");
      scene.nodes = scene.nodes.filter((item) => item.id !== source.id);
      insert([{ ...source, parentId: command.parent }], command.parent, command.before);
      break;
    }
    case "image.node.duplicate": {
      const source = nonRoot(command.id);
      const ids = imageDescendants(scene, source.id);
      const renamed = (id: string) => id === source.id ? command.newId : `${command.newId}--${id}`;
      const parent = command.parent ?? source.parentId!;
      const copies = scene.nodes.filter((item) => ids.has(item.id)).map((item) => ({ ...item, id: renamed(item.id), parentId: item.id === source.id ? parent : renamed(item.parentId!) }));
      insert(copies, parent, command.before);
      break;
    }
    case "image.node.remove":
      nonRoot(command.id); scene = removeImageNode(scene, command.id); break;
  }
  return imageSceneSchema.parse(scene);
}
