// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import projectFixture from "../../fixtures/project-v1-image.json";
import cases from "../../fixtures/image-commands.json";
import { applyImageCommand, imageCommandSchema, type ImageCommand } from "./imageCommands";
import { createImageScene } from "./imageScene";
import { parseProjectConfig } from "./project";
import { executeAgentCommands } from "./runtime";

describe("image agent commands", () => {
  it("edits, orders, reparents and duplicates subtrees while preserving generated output and unrelated fields", async () => {
    const original = parseProjectConfig(projectFixture);
    original.imageScene!.outputAssetId = "saved-result";
    const untouched = structuredClone(original);
    const result = await executeAgentCommands(original, cases.commands.map((command) => imageCommandSchema.parse(command)));
    const scene = result.imageScene!;
    expect(scene.outputAssetId).toBe("saved-result");
    expect(scene.nodes.find((node) => node.kind === "root")!.description).toBe("Balloons over the sea");
    expect(scene.style).toEqual({ ...original.imageScene!.style, lighting: "Soft morning light" });
    expect(scene.nodes.filter((node) => node.parentId === "image-root").map((node) => node.id)).toEqual(["caption", "sky-copy", "group-rocket"]);
    expect(scene.nodes.find((node) => node.id === "sky-copy--balloon")).toMatchObject({ parentId: "caption", description: "A red balloon", box: { x: 250, y: 250, width: 50, height: 50 } });
    expect(scene.nodes.find((node) => node.id === "caption")).toMatchObject({ text: "Float", colors: ["#FF0000"], box: null });
    expect(scene.nodes.some((node) => ["sky", "balloon"].includes(node.id))).toBe(false);
    expect(scene.nodes.find((node) => node.id === "title")).toEqual(original.imageScene!.nodes[2]);
    expect(original).toEqual(untouched);
  });

  it.each(cases.invalid)("rejects invalid commands transactionally: %j", async (invalid) => {
    const original = parseProjectConfig(projectFixture);
    const before = structuredClone(original);
    await expect(executeAgentCommands(original, [{ op: "image.configure", background: "Must not stick" }, invalid as ImageCommand])).rejects.toThrow();
    expect(original).toEqual(before);
  });

  it("distinguishes unchanged boxes from cleared boxes and preserves descendants when only a parent placement is cleared", () => {
    const scene = parseProjectConfig(projectFixture).imageScene!;
    const renamed = applyImageCommand(scene, { op: "image.node.set", id: "group-rocket", name: "Vehicle" });
    expect(renamed.nodes[1].box).toEqual(scene.nodes[1].box);
    const cleared = applyImageCommand(renamed, { op: "image.node.set", id: "group-rocket", box: null });
    expect(cleared.nodes[1].box).toBeNull();
    expect(cleared.nodes[2].box).toEqual(scene.nodes[2].box);
  });

  it("initializes an older image project without imageScene and rejects image edits in video projects", async () => {
    const project = parseProjectConfig(projectFixture);
    project.imageScene = undefined;
    const updated = await executeAgentCommands(project, [{ op: "image.node.add", id: "subject", parent: "image-root", kind: "object", name: "Subject" }]);
    expect(updated.imageScene?.nodes[0]).toEqual(createImageScene(project.brief.prompt).nodes[0]);
    for (const command of cases.commands) await expect(executeAgentCommands({ ...project, generationType: "video" }, [imageCommandSchema.parse(command)])).rejects.toThrow("image project");
  });
});
