// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { promptValue, typePrompt } from "./promptTestUtils";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import { choose, comboValue } from "./comboTestUtils";
import { imageGenerationSnapshotSchema, parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { imageGenerationSnapshot } from "../../lib/imageHistory";
import { defaultGeneratorTemplate, saveGeneratorTemplateSettings } from "../../lib/settings";
import { imageScenePrompt } from "../../lib/imageScene";
import { compileImageEdits } from "../../lib/imageEditing";
import { invoke } from "@tauri-apps/api/core";
import * as persistence from "../../lib/persistence";
import fixture from "../../../fixtures/project-v1-image.json";
import snapshotFixture from "../../../fixtures/image-generation-snapshot.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
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

/* Undo lives in the title bar; inside the editor it is Ctrl+Z. */
const undoImageEdit = () => fireEvent.keyDown(screen.getByRole("tree", { name: "Image nodes" }), { key: "z", code: "KeyZ", ctrlKey: true });

it("adds image files in edit mode and saves whole-image and drawn edits with separate references", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const initial = parseProjectConfig(fixture);
  initial.references = ["Mood", "Balloon"].map((name) => ({ id: name, name, kind: "text", description: name, intendedUse: [], createdAt: initial.createdAt }));
  const current = setup(initial);
  const addFile = () => {
    fireEvent.contextMenu(screen.getByLabelText("Generated images"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add image file" }));
  };
  vi.mocked(invoke).mockResolvedValueOnce(null);
  addFile();
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_image_source", { folderPath: "D:/Images" }));
  expect(current().imageScene).toEqual(initial.imageScene);
  const source = { name: "Imported", relativePath: "media/imported/source.png", width: 1000, height: 800 };
  vi.mocked(invoke).mockResolvedValueOnce(source);
  addFile();
  await waitFor(() => expect(current().imageScene?.sourceImage).toEqual(source));
  expect(screen.queryByRole("combobox", { name: "Type" })).not.toBeInTheDocument();
  // References come from what each prompt cites; there is no list to tick.
  expect(screen.queryByRole("checkbox", { name: "Mood" })).not.toBeInTheDocument();
  typePrompt(screen.getByLabelText("Edit prompt"), "Make the lighting warmer like @[ref:Mood]");
  expect(compileImageEdits(current()).edits[0]).toMatchObject({ x: 0, y: 0, width: 1000, height: 800 });
  const canvas = screen.getByLabelText("Image placement canvas");
  Object.defineProperty(canvas, "setPointerCapture", { value: vi.fn() });
  Object.defineProperty(canvas, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 1000, height: 800 }) });
  const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) => {
    const event = createEvent[type](canvas);
    Object.defineProperties(event, { button: { value: 0 }, buttons: { value: type === "pointerUp" ? 0 : 1 }, pointerId: { value: 1 }, clientX: { value: x }, clientY: { value: y } });
    fireEvent(canvas, event);
  };
  for (const key of ["o", "t", "g"]) fireEvent.keyDown(canvas, { key });
  expect(screen.getByRole("radio", { name: "Select" })).toHaveAttribute("aria-checked", "true");
  fireEvent.keyDown(canvas, { key: "e" });
  expect(screen.getByRole("radio", { name: "Draw edit" })).toHaveAttribute("aria-checked", "true");
  pointer("pointerDown", 100, 80); pointer("pointerMove", 400, 320); pointer("pointerUp", 400, 320);
  expect(current().imageScene!.nodes[1]).toMatchObject({ name: "Edit", box: { x: 100, y: 100, width: 300, height: 300 } });
  expect(promptValue(screen.getByLabelText("Edit prompt"))).toBe("");
  typePrompt(screen.getByLabelText("Edit prompt"), "Add a red @[ref:Balloon]");
  const edits = compileImageEdits(current()).edits;
  expect(edits.map((edit) => edit.references.map((reference) => reference.id))).toEqual([["Mood"], ["Balloon"]]);
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(current())));
  expect(reopened.imageScene).toEqual(current().imageScene);
  expect(reopened.assets.at(-1)!.imageGeneration!.references.map((reference) => reference.id)).toEqual(["Mood", "Balloon"]);
  fireEvent.contextMenu(screen.getByLabelText("Generated images"));
  fireEvent.click(screen.getByRole("menuitem", { name: "New empty image" }));
  fireEvent.click(screen.getByRole("button", { name: "View Editing Imported" }));
  expect(promptValue(screen.getByLabelText("Edit prompt"))).toBe("Make the lighting warmer like @[ref:Mood]");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(promptValue(screen.getByLabelText("Edit prompt"))).toBe("Add a red @[ref:Balloon]");
  expect(screen.getByRole("button", { name: "Reference Balloon" })).toHaveClass("prompt-chip");
  const beforeFailure = current();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Image file is unreadable"));
  addFile();
  expect(await screen.findByText(/Image file is unreadable/)).toBeInTheDocument();
  expect(current()).toEqual(beforeFailure);
});

it("starts an image root from the thumbnail Edit menu with edit tools and no type selector", () => {
  const initial = parseProjectConfig(fixture);
  initial.assets = [{ id: "saved", name: "Saved", kind: "image", relativePath: "media/generated/saved.jpg", mimeType: "image/jpeg", width: 101, height: 77, createdAt: initial.createdAt }];
  const current = setup(initial);
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Saved" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(current().imageScene).toMatchObject({ rootType: "image", sourceImage: { relativePath: "media/generated/saved.jpg", width: 101, height: 77 }, outputAssetId: expect.stringMatching(/^image-draft-/) });
  expect(current().imageScene!.nodes).toHaveLength(1);
  expect(screen.queryByLabelText("Prompt (high-level description)")).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Type" })).not.toBeInTheDocument();
  expect(promptValue(screen.getByLabelText("Edit prompt"))).toBe("");
  expect(within(screen.getByRole("radiogroup", { name: "Canvas tool" })).getAllByRole("radio").map((tool) => tool.getAttribute("aria-label"))).toEqual(["Select", "Draw edit"]);
  const draft = screen.getByRole("button", { name: "View Editing Saved" });
  expect(draft).toHaveAttribute("aria-pressed", "true");
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  expect(screen.getAllByRole("menuitem").filter((item) => item.textContent?.startsWith("New ")).map((item) => item.textContent)).toEqual(["New Edit"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "New Edit" }));
  typePrompt(screen.getByLabelText("Edit prompt"), "A red balloon");
  fireEvent.click(screen.getByRole("button", { name: "View Saved" }));
  expect(draft).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(draft);
  expect(current().imageScene!.nodes[1].description).toBe("A red balloon");
  expect(current().assets.filter((asset) => asset.imageDraft)).toHaveLength(1);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).assets).toEqual(current().assets);
  expect(screen.getByLabelText("Image placement canvas").parentElement!.style.getPropertyValue("--image-ratio")).toBe(String(101 / 77));
  fireEvent.contextMenu(screen.getByLabelText("Generated images"));
  fireEvent.click(screen.getByRole("menuitem", { name: "New empty image" }));
  expect(screen.getByLabelText("Prompt (high-level description)")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Draw object" })).toBeInTheDocument();
  // The edit is in Saved's family, which the bar opens from Saved.
  expect(screen.queryByRole("button", { name: "Back to all images" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View Saved, 2 versions" }));
  fireEvent.click(screen.getByRole("button", { name: "View Editing Saved" }));
  expect(current().imageScene!.sourceImage?.name).toBe("Saved");
});

it("restores the hierarchy, prompts, settings and generator when selecting a saved result", () => {
  const initial = parseProjectConfig(fixture);
  const original = imageGenerationSnapshot(initial, "Original prompt", defaultGeneratorTemplate().id);
  const saved = imageGenerationSnapshotSchema.parse(snapshotFixture);
  saveGeneratorTemplateSettings({ defaultTemplateId: original.generatorTemplateId, templates: [defaultGeneratorTemplate(), { ...defaultGeneratorTemplate(), id: saved.generatorTemplateId, name: "Lantern generator" }] });
  initial.assets = [original, saved].map((snapshot, index) => ({ id: `result-${index}`, name: `Result ${index}`, kind: "image", relativePath: `media/generated/result-${index}.jpg`, mimeType: "image/jpeg", createdAt: initial.createdAt, imageGeneration: snapshot }));
  initial.imageScene!.outputAssetId = "result-0";
  const current = setup(initial);
  typePrompt(screen.getByLabelText("Prompt (high-level description)"), "Unsaved edit");
  fireEvent.click(screen.getByRole("button", { name: "View Result 1" }));
  expect(promptValue(screen.getByLabelText("Prompt (high-level description)"))).toBe(saved.scene.nodes[0].description);
  expect(screen.getByLabelText("Steps")).toHaveValue(30);
  expect(comboValue(screen.getByRole("combobox", { name: "Generator" }))).toBe(saved.generatorTemplateId);
  expect(screen.getByRole("button", { name: "Lantern" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Lettering" })).toBeInTheDocument();
  expect(current().references).toEqual(saved.references);
  expect(current().settings).toMatchObject({ resolution: "1088p", aspectRatio: "4:5" });
  // Viewing a result starts a fresh history: Ctrl+Z has nothing to undo.
  undoImageEdit();
  expect(promptValue(screen.getByLabelText("Prompt (high-level description)"))).toBe(saved.scene.nodes[0].description);
  typePrompt(screen.getByLabelText("Prompt (high-level description)"), "Another edit");
  fireEvent.click(screen.getByRole("button", { name: "View Result 0" }));
  expect(current().imageScene).toEqual({ ...original.scene, outputAssetId: "result-0" });
  expect(comboValue(screen.getByRole("combobox", { name: "Generator" }))).toBe(original.generatorTemplateId);
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
  choose("Resolution", "2720 × 1536");
  expect(current().settings.resolution).toBe("1536p");
  choose("Resolution", "3648 × 2048");
  choose("Aspect ratio", "1:1");
  expect(current().settings).toMatchObject({ resolution: "2048p", aspectRatio: "1:1" });
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1376 / 768));
  fireEvent.click(screen.getByRole("button", { name: "View Tall" }));
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1088 / 1920));
  fireEvent.click(screen.getByRole("button", { name: "View Wide" }));
  expect(frame.style.getPropertyValue("--image-ratio")).toBe(String(1376 / 768));
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(current())));
  expect(reopened.assets).toEqual(initial.assets);
  expect(reopened.settings).toMatchObject({ resolution: "2048p", aspectRatio: "1:1" });
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
  expect(within(screen.getByLabelText("Generated images")).queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByText("Compose your image")).toBeInTheDocument();
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).imageScene).toEqual(current().imageScene);
});

it("creates a blank draft from the image bar and preserves it while browsing", () => {
  const initial = parseProjectConfig(fixture);
  initial.assets = [{ id: "saved", name: "Saved", kind: "image", relativePath: "media/generated/saved.jpg", mimeType: "image/jpeg", width: 101, height: 77, createdAt: initial.createdAt }];
  const current = setup(initial);
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Saved" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New empty image" }));
  expect(screen.queryByRole("combobox", { name: "Type" })).not.toBeInTheDocument();
  expect(promptValue(screen.getByLabelText("Prompt (high-level description)"))).toBe("");
  expect(current().imageScene!.nodes).toHaveLength(1);
  expect(screen.getByRole("button", { name: "View New image" })).toHaveAttribute("aria-pressed", "true");
  typePrompt(screen.getByLabelText("Prompt (high-level description)"), "A green forest");
  fireEvent.click(screen.getByRole("button", { name: "View Saved" }));
  fireEvent.click(screen.getByRole("button", { name: "View New image" }));
  expect(promptValue(screen.getByLabelText("Prompt (high-level description)"))).toBe("A green forest");
  expect(parseProjectConfig(JSON.parse(JSON.stringify(current()))).assets).toEqual(current().assets);
  fireEvent.contextMenu(screen.getByLabelText("Generated images"));
  expect(screen.queryByRole("menuitem", { name: "Remove" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "New empty image" }));
  expect(current().assets).toHaveLength(3);
  expect(promptValue(screen.getByLabelText("Prompt (high-level description)"))).toBe("");
});

it("creates an image from the empty bar's keyboard context menu", () => {
  const current = setup();
  fireEvent.keyDown(screen.getByLabelText("Generated images"), { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "New empty image" }));
  expect(current().assets).toHaveLength(1);
  expect(current().assets[0]).toMatchObject({ name: "New image", imageDraft: true });
});

it("edits ordered style tokens with suggestions, custom tags, removal, undo, and mode-specific choices", () => {
  const current = setup();
  expect(screen.getByRole("button", { name: "Aesthetics tag: Minimal poster" })).toBeInTheDocument();
  const aesthetics = screen.getByRole("combobox", { name: "Add Aesthetics tag" });
  fireEvent.focus(aesthetics);
  const list = () => within(screen.getByRole("listbox", { name: "Aesthetics suggestions" }));
  expect(list().getByRole("option", { name: "whimsical" })).toBeInTheDocument();
  fireEvent.change(aesthetics, { target: { value: "vibr" } });
  fireEvent.click(list().getByRole("option", { name: "vibrant" }));
  fireEvent.change(aesthetics, { target: { value: "vibr" } });
  expect(screen.queryByRole("option", { name: "vibrant" })).not.toBeInTheDocument();
  fireEvent.change(aesthetics, { target: { value: " intricate" } });
  fireEvent.keyDown(aesthetics, { key: "Enter" });
  fireEvent.change(aesthetics, { target: { value: "custom finish, " } });
  expect(current().imageScene!.style.aesthetics).toBe("Minimal poster, vibrant, intricate, custom finish");
  expect(aesthetics).toHaveValue("");
  fireEvent.keyDown(aesthetics, { key: "Escape" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove vibrant from Aesthetics" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Aesthetics tag: intricate" }), { key: "ArrowLeft", altKey: true });
  expect(current().imageScene!.style.aesthetics).toBe("intricate, Minimal poster, custom finish");
  undoImageEdit();
  expect(current().imageScene!.style.aesthetics).toBe("Minimal poster, intricate, custom finish");
  choose("Mode", "Photo");
  const lighting = screen.getByRole("combobox", { name: "Add Lighting tag" });
  fireEvent.change(lighting, { target: { value: "golden" } });
  fireEvent.keyDown(lighting, { key: "ArrowDown" });
  fireEvent.keyDown(lighting, { key: "Enter" });
  const camera = screen.getByRole("combobox", { name: "Add Camera / lens tag" });
  fireEvent.change(camera, { target: { value: "35mm" } });
  fireEvent.click(screen.getByRole("option", { name: "35mm" }));
  expect(imageScenePrompt(current().imageScene!)).toContain("A still photograph with Minimal poster, intricate, custom finish aesthetics, Sunrise, golden hour lighting, Screen print, 35mm camera and lens characteristics.");
  fireEvent.blur(camera);
  fireEvent.focus(aesthetics);
  expect(screen.getByRole("option", { name: "photorealistic" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "whimsical" })).not.toBeInTheDocument();
  fireEvent.keyDown(aesthetics, { key: "Backspace" });
  expect(current().imageScene!.style.aesthetics).toBe("Minimal poster, intricate");
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
  undoImageEdit();
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
  undoImageEdit();
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

it("walks the tree with arrow keys as a single tab stop and duplicates with Ctrl+D", () => {
  const current = setup();
  const image = screen.getByRole("button", { name: "Image" });
  expect(image).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("tabindex", "-1");
  fireEvent.keyDown(image, { key: "ArrowDown" });
  expect(screen.getByRole("button", { name: "Rocket" })).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(screen.getByRole("button", { name: "Rocket" }), { key: "ArrowLeft" });
  expect(screen.queryByRole("button", { name: "Title" })).not.toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("button", { name: "Rocket" }), { key: "ArrowRight" });
  fireEvent.keyDown(screen.getByRole("button", { name: "Rocket" }), { key: "ArrowRight" });
  expect(screen.getByRole("button", { name: "Title" })).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(screen.getByRole("button", { name: "Title" }), { key: "d", ctrlKey: true });
  expect(current().imageScene!.nodes.map((node) => node.name)).toContain("Title copy");
  expect(screen.getByRole("button", { name: "Title copy" })).toHaveAttribute("tabindex", "0");
  fireEvent.keyDown(screen.getByRole("button", { name: "Title copy" }), { key: "Home" });
  expect(screen.getByRole("button", { name: "Image" })).toHaveAttribute("tabindex", "0");
});

it("deletes a box selected on the canvas, supports undo, and leaves text editing alone", () => {
  const current = setup();
  const original = current().imageScene!;
  const canvas = screen.getByLabelText("Image placement canvas");
  const viewport = canvas.closest(".image-viewport")!;
  Object.defineProperty(canvas, "setPointerCapture", { value: vi.fn() });
  const selectBox = (id: string) => {
    const box = canvas.querySelector(`[data-node="${id}"]`)!;
    const event = createEvent.pointerDown(box);
    Object.defineProperties(event, { button: { value: 0 }, clientX: { value: 100 }, clientY: { value: 100 }, pointerId: { value: 1 } });
    fireEvent(box, event);
    const up = createEvent.pointerUp(canvas);
    Object.defineProperty(up, "pointerId", { value: 1 });
    fireEvent(canvas, up);
  };
  screen.getByLabelText("Prompt (high-level description)").focus();
  selectBox("title");
  expect(viewport).toHaveFocus();
  const description = screen.getByLabelText("Description");
  description.focus();
  fireEvent.keyDown(description, { key: "Delete" });
  expect(current().imageScene).toEqual(original);
  selectBox("title");
  fireEvent.keyDown(document.activeElement!, { key: "Delete" });
  expect(canvas.querySelector('[data-node="title"]')).toBeNull();
  expect(current().imageScene!.nodes.map((node) => node.id)).toEqual(["image-root", "group-rocket"]);
  fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
  expect(current().imageScene).toEqual(original);
  // Deleting a group removes its children as it does in the hierarchy.
  selectBox("group-rocket");
  fireEvent.keyDown(document.activeElement!, { key: "Delete" });
  expect(current().imageScene!.nodes.map((node) => node.id)).toEqual(["image-root"]);
  fireEvent.keyDown(viewport, { key: "Delete" });
  expect(current().imageScene!.nodes.map((node) => node.id)).toEqual(["image-root"]);
});

it("undoes and redoes image edits with the keyboard inside the editor only", () => {
  const current = setup();
  const before = current().imageScene!.nodes.length;
  const rocket = screen.getByRole("button", { name: "Rocket" });
  fireEvent.click(rocket);
  fireEvent.keyDown(rocket, { key: "d", ctrlKey: true });
  expect(current().imageScene!.nodes).toHaveLength(before + 2);
  const tree = screen.getByRole("tree", { name: "Image nodes" });
  fireEvent.keyDown(tree, { key: "z", ctrlKey: true });
  expect(current().imageScene!.nodes).toHaveLength(before);
  fireEvent.keyDown(tree, { key: "y", ctrlKey: true });
  expect(current().imageScene!.nodes).toHaveLength(before + 2);
  // Outside the editor Ctrl+Z is the project's, not this editor's.
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(current().imageScene!.nodes).toHaveLength(before + 2);
});

it("picks canvas tools from a radio group or their letter keys and zooms from the keyboard", () => {
  setup();
  const tools = screen.getByRole("radiogroup", { name: "Canvas tool" });
  expect(within(tools).getByRole("radio", { name: "Select" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(within(tools).getByRole("radio", { name: "Draw text" }));
  expect(within(tools).getByRole("radio", { name: "Draw text" })).toHaveAttribute("aria-checked", "true");
  const canvas = screen.getByLabelText("Image placement canvas");
  fireEvent.keyDown(canvas, { key: "g" });
  expect(within(tools).getByRole("radio", { name: "Draw group" })).toHaveAttribute("aria-checked", "true");
  fireEvent.keyDown(canvas, { key: "v" });
  expect(within(tools).getByRole("radio", { name: "Select" })).toHaveAttribute("aria-checked", "true");
  expect(within(tools).getByRole("radio", { name: "Draw object" })).toHaveAttribute("data-tooltip-shortcut", "O");

  const zoom = screen.getByRole("combobox", { name: "Image zoom" });
  const frame = canvas.parentElement!;
  expect(zoom).toHaveValue("Fit");
  fireEvent.keyDown(canvas, { key: "=", ctrlKey: true });
  expect(frame.style.getPropertyValue("--image-zoom")).toBe("1.5");
  expect(zoom).toHaveValue("150%");
  fireEvent.keyDown(canvas, { key: "-", ctrlKey: true });
  fireEvent.keyDown(canvas, { key: "-", ctrlKey: true });
  expect(frame.style.getPropertyValue("--image-zoom")).toBe("0.75");
  // Presets from the drop-down button beside the field.
  fireEvent.click(zoom.parentElement!.querySelector(".ui-combo__button")!);
  fireEvent.click(screen.getByRole("option", { name: "200%" }));
  expect(frame.style.getPropertyValue("--image-zoom")).toBe("2");
  // Or any percentage, typed.
  zoom.focus();
  fireEvent.change(zoom, { target: { value: "137" } });
  fireEvent.keyDown(zoom, { key: "Enter" });
  expect(frame.style.getPropertyValue("--image-zoom")).toBe("1.37");
  expect(zoom).toHaveValue("137%");
  fireEvent.change(zoom, { target: { value: "9000%" } });
  fireEvent.keyDown(zoom, { key: "Enter" });
  expect(frame.style.getPropertyValue("--image-zoom")).toBe("1.37");
  expect(zoom).toHaveValue("137%");
  fireEvent.keyDown(canvas, { key: "0", ctrlKey: true });
  expect(zoom).toHaveValue("Fit");
});

it("heads the inspector with the selected node rather than an Inspector title", () => {
  setup();
  const inspector = screen.getByRole("complementary", { name: "Image node inspector" });
  expect(within(inspector).getByRole("heading", { name: "Image" })).toBeInTheDocument();
  expect(within(inspector).getByText("Root")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /^Inspector/ })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Scene" })).toBeInTheDocument();
});

it("shows an image's family behind a back button, the original first", () => {
  const initial = parseProjectConfig(fixture);
  const image = (id: string, parentAssetId?: string) => ({ id, name: id, kind: "image" as const, relativePath: `media/generated/${id}.jpg`, mimeType: "image/jpeg", createdAt: initial.createdAt, ...(parentAssetId ? { parentAssetId } : {}) });
  initial.assets = [image("Original"), image("Other"), image("Retry", "Original"), image("Edited", "Original")];
  initial.imageScene!.outputAssetId = "Other";
  setup(initial);
  const bar = () => within(screen.getByLabelText("Generated images")).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  expect(bar()).toEqual(["View Original, 3 versions", "View Other"]);
  fireEvent.click(screen.getByRole("button", { name: "View Original, 3 versions" }));
  expect(bar()).toEqual(["Back to all images", "View Original", "View Retry", "View Edited"]);
  expect(screen.getByRole("button", { name: "View Original" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "View Edited" }));
  expect(screen.getByRole("button", { name: "View Edited" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Back to all images" }));
  // Back to the originals, with the family still marked as the selection.
  expect(bar()).toEqual(["View Original, 3 versions", "View Other"]);
  expect(screen.getByRole("button", { name: "View Original, 3 versions" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "View Other" }));
  expect(bar()).toEqual(["View Original, 3 versions", "View Other"]);
});

it("removes an original with a family only from inside the family, and the leftmost image takes its place", () => {
  const initial = parseProjectConfig(fixture);
  const image = (id: string, parentAssetId?: string) => ({ id, name: id, kind: "image" as const, relativePath: `media/generated/${id}.jpg`, mimeType: "image/jpeg", createdAt: initial.createdAt, ...(parentAssetId ? { parentAssetId } : {}) });
  initial.assets = [image("Original"), image("Other"), image("Retry", "Original"), image("Edited", "Original")];
  initial.imageScene!.outputAssetId = "Other";
  const current = setup(initial);
  const bar = () => within(screen.getByLabelText("Generated images")).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
  const remove = (name: string) => {
    fireEvent.contextMenu(screen.getByRole("button", { name }));
    return screen.getByRole("menuitem", { name: "Remove" });
  };
  // On the originals, an original with a family cannot be removed; one alone can.
  expect(remove("View Original, 3 versions")).toBeDisabled();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(remove("View Other")).toBeEnabled();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });

  // Inside the family it can, and the leftmost image becomes the original.
  fireEvent.click(screen.getByRole("button", { name: "View Original, 3 versions" }));
  fireEvent.click(remove("View Original"));
  expect(bar()).toEqual(["Back to all images", "View Retry", "View Edited"]);
  expect(screen.getByRole("button", { name: "View Retry" })).toHaveAttribute("aria-pressed", "true");
  expect(current().assets.map((asset) => [asset.id, asset.parentAssetId])).toEqual([["Other", undefined], ["Retry", undefined], ["Edited", "Retry"]]);

  // Emptying the family takes it off the originals too.
  fireEvent.click(remove("View Retry"));
  expect(bar()).toEqual(["View Other", "View Edited"]);
  fireEvent.click(remove("View Edited"));
  expect(bar()).toEqual(["View Other"]);
});
