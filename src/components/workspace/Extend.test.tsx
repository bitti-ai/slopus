// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import { ExtendCanvas } from "./ExtendCanvas";
import { typePrompt } from "./promptTestUtils";
import { parseProjectConfig } from "../../lib/project";
import { EMPTY_ENGINE_SETTINGS, saveGeneratorTemplateSettings } from "../../lib/settings";
import * as persistence from "../../lib/persistence";
import fixture from "../../../fixtures/project-v1-image.json";
import type { ExtendBounds } from "../../lib/extendImage";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const source = { id: "source", name: "Source", kind: "image" as const, relativePath: "media/source.png", mimeType: "image/png", width: 400, height: 300, createdAt: "2026-10-04T00:00:00Z" };

it("activates the box through Template, validates settings and executes without editing the source", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const template = { id: "test", name: "Test", modelType: "minimax-h3" as const, defaultSteps: 20, attention: "sage2" as const, paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "D:/h3.safetensors" } };
  saveGeneratorTemplateSettings({ defaultTemplateId: "test", templates: [template] });
  const config = parseProjectConfig(fixture); config.assets = [source]; config.imageScene!.outputAssetId = source.id;
  const generate = vi.fn(), change = vi.fn();
  render(<ImageEditor config={config} folderPath="D:/Images" onChange={change} onGenerate={vi.fn()} onCancel={vi.fn()} onGenerateExtend={generate} />);
  fireEvent.click(screen.getByRole("button", { name: "Template" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Extend" }));
  expect(screen.getByLabelText("Extend bounding box tool")).toBeInTheDocument();
  expect(screen.queryByLabelText("Image placement canvas")).not.toBeInTheDocument();
  const panel = within(screen.getByRole("complementary", { name: "Extend settings" }));
  expect(panel.getByLabelText("Extend x")).toHaveValue(-100);
  expect(panel.getByLabelText("Extend width")).toHaveValue(600);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Extend box" }), { key: "ArrowLeft", shiftKey: true });
  expect(panel.getByLabelText("Extend x")).toHaveValue(-110);
  fireEvent.change(panel.getByLabelText("Extend x"), { target: { value: "400" } });
  expect(panel.getByRole("button", { name: "Execute" })).toBeDisabled();
  expect(panel.getByText("The box must overlap the original image.")).toBeInTheDocument();
  fireEvent.click(panel.getByRole("button", { name: "Reset box" }));
  fireEvent.change(panel.getByLabelText("Steps"), { target: { value: "31" } });
  fireEvent.change(panel.getByLabelText("Seed"), { target: { value: "0" } });
  typePrompt(panel.getByRole("textbox", { name: "Extend prompt" }), "A forest clearing");
  fireEvent.click(panel.getByRole("button", { name: "Execute" }));
  expect(generate).toHaveBeenCalledWith(expect.objectContaining({ id: template.id }), source.id,
    { bounds: { x: -100, y: -75, width: 600, height: 450 }, steps: 31, seed: 0, prompt: "A forest clearing" });
  expect(screen.getByRole("status")).toHaveTextContent("Extend: 600 × 450 px");
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(panel.getByRole("button", { name: "Close template settings" }));
  expect(screen.queryByLabelText("Extend bounding box tool")).not.toBeInTheDocument();
  const normal = screen.getByLabelText("Image placement canvas").closest(".image-viewport")!;
  const frame = normal.querySelector<HTMLElement>(".image-frame")!;
  const zoom = frame.style.getPropertyValue("--image-zoom");
  fireEvent.wheel(normal, { deltaY: -100 });
  expect(frame.style.getPropertyValue("--image-zoom")).not.toBe(zoom);
});

it("moves, resizes, redraws and cancels box drags in original pixel coordinates", () => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  let latest: ExtendBounds = { x: -100, y: -75, width: 600, height: 450 };
  function Harness() {
    const [bounds, setBounds] = useState(latest); latest = bounds;
    return <ExtendCanvas source={source} folderPath="D:/Images" bounds={bounds} onChange={setBounds} disabled={false} />;
  }
  render(<Harness />);
  const canvas = screen.getByLabelText("Extend bounding box tool");
  const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", target: Element, x: number, y: number) => {
    const view = canvas.getAttribute("viewBox")!.split(" ").map(Number);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: view[2], height: view[3] } as DOMRect);
    const event = createEvent[type](target);
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x - view[0] }, clientY: { value: y - view[1] } });
    fireEvent(target, event);
  };
  pointer("pointerDown", screen.getByRole("button", { name: "Move Extend box" }), 0, 0);
  pointer("pointerMove", canvas, 20, 10); pointer("pointerUp", canvas, 20, 10);
  expect(latest).toEqual({ x: -80, y: -65, width: 600, height: 450 });
  pointer("pointerDown", canvas.querySelector('[data-handle="nw"]')!, -80, -65);
  pointer("pointerMove", canvas, -110, -90); pointer("pointerUp", canvas, -110, -90);
  expect(latest).toEqual({ x: -110, y: -90, width: 630, height: 475 });
  pointer("pointerDown", canvas, -130, -100);
  pointer("pointerMove", canvas, 200, 200); pointer("pointerUp", canvas, 200, 200);
  expect(latest).toEqual({ x: -130, y: -100, width: 330, height: 300 });
  pointer("pointerDown", canvas.querySelector('[data-handle="se"]')!, 200, 200);
  pointer("pointerMove", canvas, 300, 300); pointer("pointerCancel", canvas, 300, 300);
  expect(latest).toEqual({ x: -130, y: -100, width: 330, height: 300 });
  pointer("pointerDown", canvas.querySelector('[data-handle="e"]')!, 200, 0);
  pointer("pointerMove", canvas, 300, 0);
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(latest).toEqual({ x: -130, y: -100, width: 330, height: 300 });
});

it.each([0.5, 2])("snaps within six screen pixels at %sx scale without trapping the drag or resizing a moved box", (scale) => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const original = { x: -100, y: -75, width: 600, height: 450 };
  let latest: ExtendBounds = original;
  function Harness() {
    const [bounds, setBounds] = useState(original); latest = bounds;
    return <ExtendCanvas source={source} folderPath="D:/Images" bounds={bounds} onChange={setBounds} disabled={false} />;
  }
  render(<Harness />);
  const canvas = screen.getByLabelText("Extend bounding box tool");
  const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", target: Element, x: number, y: number) => {
    const view = canvas.getAttribute("viewBox")!.split(" ").map(Number);
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: view[2] * scale, height: view[3] * scale } as DOMRect);
    const event = createEvent[type](target);
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: (x - view[0]) * scale }, clientY: { value: (y - view[1]) * scale } });
    fireEvent(target, event);
  };
  // Resize only the active edge, leaving its opposite edge and vertical bounds fixed.
  pointer("pointerDown", canvas.querySelector('[data-handle="e"]')!, 500, 150);
  pointer("pointerMove", canvas, 400 + 4 / scale, 150);
  expect(latest).toEqual({ ...original, width: 500 });
  pointer("pointerMove", canvas, 400 + 8 / scale, 150);
  expect(latest).toEqual({ ...original, width: 500 + 8 / scale });
  pointer("pointerMove", canvas, 400 - 4 / scale, 150);
  expect(latest).toEqual({ ...original, width: 500 });
  pointer("pointerCancel", canvas, 400, 150);
  expect(latest).toEqual(original);

  // A corner snaps to both original borders while preserving the opposite corner.
  pointer("pointerDown", canvas.querySelector('[data-handle="nw"]')!, -100, -75);
  pointer("pointerMove", canvas, -4 / scale, 4 / scale);
  expect(latest).toEqual({ x: 0, y: 0, width: 500, height: 375 });
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(latest).toEqual(original);

  // Moving snaps by translation, never by stretching the box.
  pointer("pointerDown", screen.getByRole("button", { name: "Move Extend box" }), 0, 0);
  pointer("pointerMove", canvas, 100 - 4 / scale, 75 + 4 / scale);
  expect(latest).toEqual({ ...original, x: 0, y: 0 });
  pointer("pointerCancel", canvas, 100, 75);

  // Both endpoints of a newly drawn box can align exactly with the source.
  pointer("pointerDown", canvas, -4 / scale, -4 / scale);
  pointer("pointerMove", canvas, 400 + 4 / scale, 300 + 4 / scale);
  expect(latest).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  pointer("pointerUp", canvas, 400, 300);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Extend box" }), { key: "ArrowLeft" });
  expect(latest).toEqual({ x: -1, y: 0, width: 400, height: 300 });
});
