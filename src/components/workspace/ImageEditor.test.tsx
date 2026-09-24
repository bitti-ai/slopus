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
  expect(imageScenePrompt(current().imageScene!)).toContain("Style: Photograph. Minimal poster, intricate, custom finish. Sunrise, golden hour. Screen print, 35mm.");
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
  expect(screen.getByLabelText("Parent")).toHaveValue("cloud");
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
