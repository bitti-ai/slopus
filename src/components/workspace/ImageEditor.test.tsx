// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import { imageGenerationSnapshotSchema, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { imageGenerationSnapshot } from "../../lib/imageHistory";
import { defaultGeneratorTemplate, saveGeneratorTemplateSettings } from "../../lib/settings";
import { imageScenePrompt } from "../../lib/imageScene";
import fixture from "../../../fixtures/project-v1-image.json";
import snapshotFixture from "../../../fixtures/image-generation-snapshot.json";

afterEach(() => { cleanup(); localStorage.clear(); });
function setup(initial = parseProjectConfig(fixture)) {
  let latest: ProjectConfig = initial;
  function Harness() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return <ImageEditor config={config} folderPath="D:/Images" onChange={setConfig} onGenerate={vi.fn()} onCancel={vi.fn()} />;
  }
  render(<Harness />);
  return () => latest;
}

it("starts an image root from the thumbnail Edit menu and hides root text controls", () => {
  const initial = parseProjectConfig(fixture);
  initial.assets = [{ id: "saved", name: "Saved", kind: "image", relativePath: "media/generated/saved.jpg", mimeType: "image/jpeg", width: 101, height: 77, createdAt: initial.createdAt }];
  const current = setup(initial);
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Saved" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(current().imageScene).toMatchObject({ rootType: "image", sourceImage: { relativePath: "media/generated/saved.jpg", width: 101, height: 77 }, outputAssetId: expect.stringMatching(/^image-draft-/) });
  expect(current().imageScene!.nodes).toHaveLength(1);
  expect(screen.queryByLabelText("Prompt (high-level description)")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open image" })).toBeInTheDocument();
  const draft = screen.getByRole("button", { name: "View Editing Saved" });
  expect(draft).toHaveAttribute("aria-pressed", "true");
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Object" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A red balloon" } });
  fireEvent.click(screen.getByRole("button", { name: "View Saved" }));
  expect(draft).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(draft);
  expect(current().imageScene!.nodes[1].description).toBe("A red balloon");
  expect(current().assets.filter((asset) => asset.imageDraft)).toHaveLength(1);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).assets).toEqual(current().assets);
  expect(screen.getByLabelText("Image placement canvas").parentElement!.style.getPropertyValue("--image-ratio")).toBe(String(101 / 77));
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "prompt" } });
  expect(screen.getByLabelText("Prompt (high-level description)")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Type"), { target: { value: "image" } });
  expect(current().imageScene!.sourceImage).toBeNull();
});

it("restores the hierarchy, prompts, settings and generator when selecting a saved result", () => {
  const initial = parseProjectConfig(fixture);
  const original = imageGenerationSnapshot(initial, "Original prompt", defaultGeneratorTemplate().id);
  const saved = imageGenerationSnapshotSchema.parse(snapshotFixture);
  saveGeneratorTemplateSettings({ defaultTemplateId: original.generatorTemplateId, templates: [defaultGeneratorTemplate(), { ...defaultGeneratorTemplate(), id: saved.generatorTemplateId, name: "Lantern generator" }] });
  initial.assets = [original, saved].map((snapshot, index) => ({ id: `result-${index}`, name: `Result ${index}`, kind: "image", relativePath: `media/generated/result-${index}.jpg`, mimeType: "image/jpeg", createdAt: initial.createdAt, imageGeneration: snapshot }));
  initial.imageScene!.outputAssetId = "result-0";
  const current = setup(initial);
  fireEvent.change(screen.getByLabelText("Prompt (high-level description)"), { target: { value: "Unsaved edit" } });
  expect(screen.getByRole("button", { name: "Undo image edit" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "View Result 1" }));
  expect(screen.getByLabelText("Prompt (high-level description)")).toHaveValue(saved.scene.nodes[0].description);
  expect(screen.getByLabelText("Steps")).toHaveValue(30);
  expect(screen.getByLabelText("Generator")).toHaveValue(saved.generatorTemplateId);
  expect(screen.getByRole("button", { name: "Lantern" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Lettering" })).toBeInTheDocument();
  expect(current().references).toEqual(saved.references);
  expect(current().settings).toMatchObject({ resolution: "1088p", aspectRatio: "4:5" });
  expect(screen.getByRole("button", { name: "Undo image edit" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Prompt (high-level description)"), { target: { value: "Another edit" } });
  fireEvent.click(screen.getByRole("button", { name: "View Result 0" }));
  expect(current().imageScene).toEqual({ ...original.scene, outputAssetId: "result-0" });
  expect(screen.getByLabelText("Generator")).toHaveValue(original.generatorTemplateId);
  fireEvent.click(screen.getByRole("button", { name: "View Result 1" }));
  expect(current().imageScene).toEqual({ ...saved.scene, outputAssetId: "result-1" });
  expect(current().assets[1].imageGeneration).toEqual(saved);
});

it("displays each generated image at its saved aspect ratio independently of future generation settings", () => {
  const initial = parseProjectConfig(fixture);
  initial.assets = [
    { id: "wide", name: "Wide", kind: "image", relativePath: "media/generated/wide.jpg", mimeType: "image/jpeg", width: 1376, height: 768, createdAt: initial.createdAt },
    { id: "tall", name: "Tall", kind: "image", relativePath: "media/generated/tall.jpg", mimeType: "image/jpeg", width: 1088, height: 1920, createdAt: initial.createdAt },
  ];
  initial.imageScene!.outputAssetId = "wide";
  const current = setup(initial);
  const frame = screen.getByLabelText("Image placement canvas").parentElement!;
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1376 / 768));
  fireEvent.change(screen.getByLabelText("Resolution"), { target: { value: "1344p" } });
  fireEvent.change(screen.getByLabelText("Aspect ratio"), { target: { value: "1:1" } });
  expect(current().settings).toMatchObject({ resolution: "1344p", aspectRatio: "1:1" });
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1376 / 768));
  fireEvent.click(screen.getByRole("button", { name: "View Tall" }));
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1088 / 1920));
  fireEvent.click(screen.getByRole("button", { name: "View Wide" }));
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1376 / 768));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(current())));
  expect(reopened.assets).toEqual(initial.assets);
  expect(reopened.settings).toMatchObject({ resolution: "1344p", aspectRatio: "1:1" });
});

it("removes generated images through their context menu and keeps the preview and thumbnail valid", () => {
  const initial = parseProjectConfig(fixture);
  initial.assets = ["First", "Second", "Third"].map((name) => ({ id: name, name, kind: "image", relativePath: `media/generated/${name}.jpg`, mimeType: "image/jpeg", createdAt: initial.createdAt }));
  initial.imageScene!.outputAssetId = "Second";
  initial.thumbnail = "media/generated/Second.jpg";
  const current = setup(initial);
  const first = screen.getByRole("button", { name: "View First" });
  fireEvent.contextMenu(first, { clientX: 80, clientY: 90 });
  expect(screen.getByRole("menu", { name: "Generated image actions" })).toBeInTheDocument();
  expect(current().imageScene!.outputAssetId).toBe("Second");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(first).toHaveFocus();
  expect(current().assets).toHaveLength(3);
  fireEvent.keyDown(first, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  expect(screen.queryByRole("button", { name: "View First" })).not.toBeInTheDocument();
  expect(current().imageScene!.outputAssetId).toBe("Second");
  expect(current().thumbnail).toBe("media/generated/Second.jpg");
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Second" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  expect(current().imageScene!.outputAssetId).toBe("Third");
  expect(current().thumbnail).toBe("media/generated/Third.jpg");
  expect(screen.getByRole("button", { name: "View Third" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Third" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
  expect(current().assets).toHaveLength(0);
  expect(current().imageScene!.outputAssetId).toBeNull();
  expect(current().thumbnail).toBeNull();
  expect(screen.queryByLabelText("Generated images")).not.toBeInTheDocument();
  expect(screen.getByText("Compose your image")).toBeInTheDocument();
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).imageScene).toEqual(current().imageScene);
});

it("edits ordered style chips with suggestions, custom tags, removal, undo, and mode-specific choices", () => {
  const current = setup();
  expect(screen.getByRole("button", { name: "Aesthetics tag: Minimal poster" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Add Aesthetics tag" }));
  const popup = within(screen.getByRole("dialog", { name: "Add Aesthetics tag" }));
  expect(popup.getByRole("button", { name: "whimsical" })).toBeInTheDocument();
  fireEvent.click(popup.getByRole("button", { name: "vibrant" }));
  expect(popup.queryByRole("button", { name: "vibrant" })).not.toBeInTheDocument();
  const custom = popup.getByRole("textbox", { name: "Custom Aesthetics tags" });
  fireEvent.change(custom, { target: { value: " VIBRANT, intricate, custom finish, , " } });
  fireEvent.keyDown(custom, { key: "Enter" });
  expect(current().imageScene!.style.aesthetics).toBe("Minimal poster, vibrant, intricate, custom finish");
  expect(custom).toHaveValue("");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Add Aesthetics tag" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Remove vibrant from Aesthetics" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Aesthetics tag: intricate" }), { key: "ArrowLeft", altKey: true });
  expect(current().imageScene!.style.aesthetics).toBe("intricate, Minimal poster, custom finish");
  fireEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(current().imageScene!.style.aesthetics).toBe("Minimal poster, intricate, custom finish");
  fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "photo" } });
  fireEvent.click(screen.getByRole("button", { name: "Add Lighting tag" }));
  fireEvent.click(screen.getByRole("button", { name: "golden hour" }));
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Add Camera / lens tag" }));
  fireEvent.click(screen.getByRole("button", { name: "35mm" }));
  expect(imageScenePrompt(current().imageScene!)).toContain("A still photograph with Minimal poster, intricate, custom finish aesthetics, Sunrise, golden hour lighting, Screen print, 35mm camera and lens characteristics.");
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Add Aesthetics tag" }));
  expect(screen.getByRole("button", { name: "photorealistic" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "whimsical" })).not.toBeInTheDocument();
  fireEvent.pointerDown(screen.getByLabelText("Mode"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).imageScene).toEqual(current().imageScene);
});

it("drags whole hierarchy branches to nest or reorder, preserves placement, and rejects cycles", () => {
  const initial = parseProjectConfig(fixture);
  const scene = initial.imageScene!;
  scene.nodes.push({ ...scene.nodes[1], id: "cloud", name: "Cloud", parentId: "image-root" });
  scene.nodes.push({ ...scene.nodes[2], id: "cloud-detail", name: "Cloud detail", parentId: "cloud" });
  const current = setup(initial);
  const row = (name: string) => screen.getByRole("button", { name }).closest<HTMLDivElement>(".image-tree__row")!;
  const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
  const drop = (source: string, target: string, y = 50) => {
    fireEvent.dragStart(row(source), { dataTransfer: transfer });
    const destination = row(target);
    vi.spyOn(destination, "getBoundingClientRect").mockReturnValue({ top: 0, height: 100 } as DOMRect);
    for (const type of ["dragOver", "drop"] as const) {
      const event = createEvent[type](destination, { dataTransfer: transfer });
      Object.defineProperty(event, "clientY", { value: y });
      fireEvent(destination, event);
    }
  };
  fireEvent.click(screen.getByRole("button", { name: "Collapse Cloud" }));
  drop("Rocket", "Cloud");
  expect(current().imageScene!.nodes.find((node) => node.id === "group-rocket")?.parentId).toBe("cloud");
  expect(current().imageScene!.nodes.find((node) => node.id === "title")).toEqual(scene.nodes[2]);
  expect(screen.getByRole("button", { name: "Collapse Cloud" })).toBeInTheDocument();
  expect(screen.queryByLabelText("Parent")).not.toBeInTheDocument();
  const nested = current().imageScene;
  drop("Cloud", "Title");
  expect(current().imageScene).toBe(nested);
  drop("Rocket", "Rocket");
  expect(current().imageScene).toBe(nested);
  fireEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(current().imageScene).toEqual(scene);
  drop("Rocket", "Cloud", 99);
  expect(current().imageScene!.nodes.filter((node) => node.parentId === "image-root").map((node) => node.id)).toEqual(["cloud", "group-rocket"]);
  drop("Rocket", "Cloud", 1);
  expect(current().imageScene!.nodes.filter((node) => node.parentId === "image-root").map((node) => node.id)).toEqual(["group-rocket", "cloud"]);
  expect(row("Image")).toHaveAttribute("draggable", "false");
  expect(current().imageScene!.nodes.find((node) => node.id === "group-rocket")?.box).toEqual(scene.nodes[1].box);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).imageScene).toEqual(current().imageScene);
});

it("uses the context menu for creation, inline rename, and independent subtree copy/paste", () => {
  const current = setup();
  const open = (name: string) => fireEvent.contextMenu(screen.getByRole("button", { name }));
  const action = (name: string) => fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${name}(?:$| )`) }));
  const panel = within(screen.getByRole("complementary", { name: "Image hierarchy" }));
  expect(panel.queryByRole("button", { name: "Object" })).not.toBeInTheDocument();
  expect(panel.queryByRole("button", { name: "Duplicate" })).not.toBeInTheDocument();
  open("Image");
  expect(screen.getByRole("menuitem", { name: /^Copy/ })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: /^Delete/ })).toBeDisabled();
  expect(screen.getByRole("menuitem", { name: /^Paste/ })).toBeDisabled();
  fireEvent.keyDown(window, { key: "Escape" });
  open("Rocket");
  expect(screen.getByLabelText("Name")).toHaveValue("Rocket");
  action("Copy");
  actionAfterOpen("Rocket", "Rename");
  const rename = screen.getByRole("textbox", { name: "Rename image node" });
  expect(rename).toHaveFocus();
  fireEvent.change(rename, { target: { value: "Launch vehicle" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(current().imageScene!.nodes.find((node) => node.id === "group-rocket")?.name).toBe("Launch vehicle");
  actionAfterOpen("Image", "Paste");
  const pasted = current().imageScene!.nodes.find((node) => node.name === "Rocket")!;
  expect(pasted.id).not.toBe("group-rocket");
  expect(pasted.parentId).toBe("image-root");
  const child = current().imageScene!.nodes.find((node) => node.parentId === pasted.id)!;
  expect(child.id).not.toBe("title");
  expect(child.text).toBe("LIFT OFF");
  expect(child.box).toEqual(fixture.imageScene.nodes[2].box);
  actionAfterOpen("Rocket", "Delete");
  expect(current().imageScene!.nodes.some((node) => node.id === child.id)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Undo image edit" }));
  expect(current().imageScene!.nodes.some((node) => node.id === child.id)).toBe(true);
  actionAfterOpen("Launch vehicle", "New Text");
  const text = current().imageScene!.nodes.at(-1)!;
  expect(text.parentId).toBe("group-rocket");
  actionAfterOpen("Text", "New Object");
  expect(current().imageScene!.nodes.at(-1)?.parentId).toBe("group-rocket");
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).imageScene).toEqual(current().imageScene);
  function actionAfterOpen(node: string, name: string) { open(node); action(name); }
});

it("supports menu keyboard navigation and tree shortcuts without intercepting name editing", () => {
  const current = setup();
  const rocket = screen.getByRole("button", { name: "Rocket" });
  fireEvent.click(rocket);
  fireEvent.keyDown(rocket, { key: "F10", shiftKey: true });
  const first = screen.getByRole("menuitem", { name: "New Object" });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: "End" });
  expect(screen.getByRole("menuitem", { name: /^Delete/ })).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(rocket).toHaveFocus();
  fireEvent.keyDown(rocket, { key: "c", ctrlKey: true });
  fireEvent.keyDown(rocket, { key: "F2" });
  const rename = screen.getByRole("textbox", { name: "Rename image node" });
  fireEvent.change(rename, { target: { value: "Discard this" } });
  fireEvent.keyDown(rename, { key: "Delete" });
  expect(current().imageScene!.nodes).toHaveLength(3);
  fireEvent.keyDown(rename, { key: "Escape" });
  expect(current().imageScene!.nodes[1].name).toBe("Rocket");
  fireEvent.click(screen.getByRole("button", { name: "Title" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Title" }), { key: "v", ctrlKey: true });
  const pasted = current().imageScene!.nodes.at(-2)!;
  expect(pasted.parentId).toBe("group-rocket");
  expect(current().imageScene!.nodes).toHaveLength(5);
  fireEvent.contextMenu(screen.getByRole("tree", { name: "Image nodes" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Group" }));
  expect(current().imageScene!.nodes.at(-1)).toMatchObject({ kind: "group", parentId: "image-root" });
});
