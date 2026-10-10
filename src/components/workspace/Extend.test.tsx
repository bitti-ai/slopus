// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageEditor } from "./ImageEditor";
import { ExtendCanvas } from "./ExtendCanvas";
import { parseProjectConfig } from "../../lib/project";
import * as persistence from "../../lib/persistence";
import * as settings from "../../lib/settings";
import { choose } from "./comboTestUtils";
import fixture from "../../../fixtures/project-v1-image.json";
import type { ExtendBounds } from "../../lib/extendImage";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const source = { id: "source", name: "Source", kind: "image" as const, relativePath: "media/source.png", mimeType: "image/png", width: 400, height: 300, createdAt: "2026-10-04T00:00:00Z" };

it("opens Extend from Template with box controls and returns to image settings", () => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const config = parseProjectConfig(fixture); config.assets = [source]; config.imageScene!.outputAssetId = source.id;
  render(<ImageEditor config={config} folderPath="D:/Images" onChange={vi.fn()} onGenerate={vi.fn()} onCancel={vi.fn()} onGenerateExtend={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Template" }));
  expect(screen.getByRole("menuitem", { name: "Extend" })).toBeEnabled();
  expect(screen.getByRole("menuitem", { name: "Character sheet" })).toBeEnabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Extend" }));
  expect(screen.getByLabelText("Extend bounding box tool")).toBeInTheDocument();
  expect(screen.getByLabelText("Extend width")).toHaveValue(608);
  expect(screen.getByLabelText("Extend resolution")).toBeEnabled();
  expect(screen.getByLabelText("Extend prompt")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close template settings" }));
  expect(screen.queryByLabelText("Extend bounding box tool")).not.toBeInTheDocument();
});

it("executes an optional-prompt extension at the changed resolution without changing video settings", () => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(settings, "templateUsable").mockReturnValue(true);
  const generator = settings.createGeneratorTemplate("Extend generator");
  settings.saveGeneratorTemplateSettings({ templates: [generator], defaultTemplateId: generator.id });
  const initial = parseProjectConfig(fixture);
  initial.assets = [source]; initial.imageScene!.outputAssetId = source.id;
  let latest = initial;
  const execute = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(initial); latest = config;
    return <ImageEditor config={config} folderPath="D:/Images" onChange={setConfig} onGenerate={vi.fn()} onCancel={vi.fn()} onGenerateExtend={execute} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Template" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Extend" }));
  choose("Extend resolution", "1088p");
  expect(latest.imageSettings?.resolution).toBe("1088p");
  expect(latest.settings).toEqual(initial.settings);
  fireEvent.click(screen.getByRole("button", { name: "Execute" }));
  expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: generator.id }), source.id,
    expect.objectContaining({ prompt: "", bounds: { x: -104, y: -74, width: 608, height: 448 } }));
});

it("moves, resizes, redraws and cancels box drags in original pixel coordinates", () => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  let latest: ExtendBounds = { x: -96, y: -64, width: 576, height: 448 };
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
  expect(latest).toEqual({ x: -76, y: -54, width: 576, height: 448 });
  pointer("pointerDown", canvas.querySelector('[data-handle="nw"]')!, -76, -54);
  pointer("pointerMove", canvas, -106, -79); pointer("pointerUp", canvas, -106, -79);
  expect(latest).toEqual({ x: -108, y: -86, width: 608, height: 480 });
  pointer("pointerDown", canvas, -130, -100);
  pointer("pointerMove", canvas, 200, 200); pointer("pointerUp", canvas, 200, 200);
  expect(latest).toEqual({ x: -130, y: -100, width: 320, height: 288 });
  pointer("pointerDown", canvas.querySelector('[data-handle="se"]')!, 200, 200);
  pointer("pointerMove", canvas, 300, 300); pointer("pointerCancel", canvas, 300, 300);
  expect(latest).toEqual({ x: -130, y: -100, width: 320, height: 288 });
  pointer("pointerDown", canvas.querySelector('[data-handle="e"]')!, 200, 0);
  pointer("pointerMove", canvas, 300, 0);
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(latest).toEqual({ x: -130, y: -100, width: 320, height: 288 });
});

it.each([0.5, 2])("snaps within six screen pixels at %sx scale without trapping the drag or resizing a moved box", (scale) => {
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const original = { x: -96, y: -64, width: 576, height: 448 };
  let latest: ExtendBounds = original;
  function Harness() {
    const [bounds, setBounds] = useState(original); latest = bounds;
    return <ExtendCanvas source={{ ...source, width: 384, height: 288 }} folderPath="D:/Images" bounds={bounds} onChange={setBounds} disabled={false} />;
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
  pointer("pointerDown", canvas.querySelector('[data-handle="e"]')!, 480, 150);
  pointer("pointerMove", canvas, 384 + 4 / scale, 150);
  expect(latest).toEqual({ ...original, width: 480 });
  pointer("pointerMove", canvas, 416, 150);
  expect(latest).toEqual({ ...original, width: 512 });
  pointer("pointerMove", canvas, 384 - 4 / scale, 150);
  expect(latest).toEqual({ ...original, width: 480 });
  pointer("pointerCancel", canvas, 384, 150);
  expect(latest).toEqual(original);

  // A corner snaps to both original borders while preserving the opposite corner.
  pointer("pointerDown", canvas.querySelector('[data-handle="nw"]')!, -96, -64);
  pointer("pointerMove", canvas, -4 / scale, 4 / scale);
  expect(latest).toEqual({ x: 0, y: 0, width: 480, height: 384 });
  fireEvent.keyDown(canvas, { key: "Escape" });
  expect(latest).toEqual(original);

  // Moving snaps by translation, never by stretching the box.
  pointer("pointerDown", screen.getByRole("button", { name: "Move Extend box" }), 0, 0);
  pointer("pointerMove", canvas, 96 - 4 / scale, 64 + 4 / scale);
  expect(latest).toEqual({ ...original, x: 0, y: 0 });
  pointer("pointerCancel", canvas, 96, 64);

  // Both endpoints of a newly drawn box can align exactly with the source.
  pointer("pointerDown", canvas, -4 / scale, -4 / scale);
  pointer("pointerMove", canvas, 384 + 4 / scale, 288 + 4 / scale);
  expect(latest).toEqual({ x: 0, y: 0, width: 384, height: 288 });
  pointer("pointerUp", canvas, 384, 288);
  fireEvent.keyDown(screen.getByRole("button", { name: "Move Extend box" }), { key: "ArrowLeft" });
  expect(latest).toEqual({ x: -1, y: 0, width: 384, height: 288 });
});
