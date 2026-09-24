import { describe, expect, it } from "vitest";
import imageFixture from "../../fixtures/project-v1-image.json";
import oldFixture from "../../fixtures/project-v1-created.json";
import { addImageNode, createImageScene, duplicateImageNode, imageScenePrompt, imageSceneSchema, removeImageNode, resizeImageNode } from "./imageScene";
import { createProjectConfig, parseProjectConfig } from "./project";

describe("image documents", () => {
  it("opens old projects as video and round-trips image authoring without creating video jobs", () => {
    expect(parseProjectConfig(oldFixture).generationType).toBe("video");
    const project = createProjectConfig({ name: "Poster", prompt: "A still life", generationType: "image", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 });
    expect(project.generationJobs).toEqual([]);
    expect(project.imageScene?.nodes[0].description).toBe("A still life");
    expect(parseProjectConfig(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(parseProjectConfig(imageFixture).imageScene).toEqual(imageFixture.imageScene);
  });
  it("rejects duplicate IDs, cycles, disconnected nodes and invalid placement", () => {
    const scene = imageSceneSchema.parse(imageFixture.imageScene);
    const bad = (change: (copy: typeof scene) => void) => { const copy = structuredClone(scene); change(copy); expect(imageSceneSchema.safeParse(copy).success).toBe(false); };
    bad((copy) => { copy.nodes[1].id = copy.nodes[0].id; });
    bad((copy) => { copy.nodes[1].parentId = copy.nodes[2].id; });
    bad((copy) => { copy.nodes[1].parentId = null; });
    bad((copy) => { copy.nodes[1].box!.width = 1000; });
    bad((copy) => { copy.nodes[1].parentId = "missing"; });
  });
  it("duplicates and removes entire subtrees without breaking relationships", () => {
    const scene = imageSceneSchema.parse(imageFixture.imageScene);
    const duplicate = duplicateImageNode(scene, "group-rocket");
    expect(duplicate.nodes).toHaveLength(5);
    expect(duplicate.nodes[4].parentId).toBe(duplicate.nodes[3].id);
    const removed = removeImageNode(duplicate, "group-rocket");
    expect(removed.nodes).toHaveLength(3);
    expect(imageSceneSchema.safeParse(removed).success).toBe(true);
    expect(removeImageNode(scene, "image-root")).toBe(scene);
  });
  it("transforms child boxes with their group and compiles nested descriptions and exact text", () => {
    const scene = imageSceneSchema.parse(imageFixture.imageScene);
    const resized = resizeImageNode(scene, "group-rocket", { x: 100, y: 100, width: 200, height: 400 });
    expect(resized.nodes[2].box).toEqual({ x: 125, y: 125, width: 150, height: 50 });
    const prompt = imageScenePrompt(resized);
    expect(prompt).toContain('Render the exact text "LIFT OFF"');
    expect(prompt).toContain("white rocket surrounded by glowing vapor");
    expect(prompt).toContain("left 12.5%");
    expect(prompt).toContain("Screen print");
    expect(prompt).toContain("#FF0000");
    expect(imageScenePrompt(createImageScene())).toBe("");
    expect(addImageNode(createImageScene(), "image-root", "object").nodes).toHaveLength(2);
  });
});
