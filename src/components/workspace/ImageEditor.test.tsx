// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import { parseProjectConfig, type ProjectConfig } from "../../lib/project";
import { imageScenePrompt } from "../../lib/imageScene";
import fixture from "../../../fixtures/project-v1-image.json";

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
  expect(imageScenePrompt(current().imageScene!)).toContain("Medium: Photograph.\nAesthetics: Minimal poster, intricate, custom finish.\nLighting: Sunrise, golden hour.\nCamera and lens: Screen print, 35mm.");
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
