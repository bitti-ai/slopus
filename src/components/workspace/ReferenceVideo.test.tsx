// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readMediaFileUrl } from "../../lib/persistence";
import { projectReferenceSchema, type ProjectReference } from "../../lib/project";
import { ReferenceVideo } from "./ReferenceVideo";

vi.mock("../../lib/persistence", () => ({ readMediaFileUrl: vi.fn(async () => "blob:video") }));
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const original: ProjectReference = {
  id: "reference", kind: "video", name: "Long video", description: "", intendedUse: [], createdAt: "2026-09-18T12:00:00Z",
  sourcePath: "C:/long.mp4", video: { startSeconds: 0, durationSeconds: 15, includeAudio: true },
};
function Harness({ initial = original }: { initial?: ProjectReference }) {
  const [reference, setReference] = useState(initial);
  return <><ReferenceVideo folderPath="C:/project" reference={reference} onChange={(video) => setReference((current) => projectReferenceSchema.parse({ ...current, video }))} /><output data-testid="saved">{JSON.stringify(reference.video)}</output></>;
}
async function ready(duration = 120) {
  const video = await screen.findByLabelText("Long video video preview") as HTMLVideoElement;
  Object.defineProperty(video, "duration", { value: duration, configurable: true });
  fireEvent.loadedMetadata(video);
  return video;
}
const saved = () => JSON.parse(screen.getByTestId("saved").textContent!);

it("starts at 0–15 seconds and moves and resizes the selection without reloading the source", async () => {
  render(<Harness />);
  const video = await ready();
  expect(screen.getByText("0:00.0 – 0:15.0")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Clip position"), { target: { value: "60" } });
  expect(saved()).toMatchObject({ startSeconds: 60, durationSeconds: 15 });
  expect(video.currentTime).toBe(60);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Selection end" }), { key: "ArrowLeft", shiftKey: true });
  expect(saved().durationSeconds).toBe(14);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Selection start" }), { key: "ArrowRight", shiftKey: true });
  expect(saved()).toMatchObject({ startSeconds: 61, durationSeconds: 13 });
  expect(screen.getByLabelText("Long video video preview")).toBe(video);
  expect(readMediaFileUrl).toHaveBeenCalledTimes(1);
});

it("keeps the selection in bounds at the end of a long video", async () => {
  render(<Harness />);
  await ready(3600);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Move selection" }), { key: "End" });
  expect(saved()).toMatchObject({ startSeconds: 3585, durationSeconds: 15 });
  fireEvent.change(screen.getByLabelText("Clip duration (seconds)"), { target: { value: "100" } });
  fireEvent.blur(screen.getByLabelText("Clip duration (seconds)"));
  expect(saved().durationSeconds).toBe(15);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Selection start" }), { key: "End" });
  expect(saved()).toMatchObject({ startSeconds: 3598, durationSeconds: 2 });
  fireEvent.keyDown(screen.getByRole("slider", { name: "Selection end" }), { key: "ArrowRight" });
  expect(saved().durationSeconds).toBe(2);
});

it("drags the selected interval and its edges", async () => {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  render(<Harness />);
  await ready();
  const bar = screen.getByLabelText("Drag the selection or its edges");
  Object.defineProperty(bar, "setPointerCapture", { value: vi.fn() });
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({ width: 300, left: 0 } as DOMRect);
  fireEvent.pointerDown(screen.getByRole("slider", { name: "Move selection" }), { button: 0, pointerId: 1, clientX: 75 });
  fireEvent.pointerMove(bar, { pointerId: 1, clientX: 125 });
  fireEvent.pointerUp(bar, { pointerId: 1 });
  expect(saved()).toMatchObject({ startSeconds: 5, durationSeconds: 15 });
  fireEvent.pointerDown(screen.getByRole("slider", { name: "Selection end" }), { button: 0, pointerId: 2, clientX: 200 });
  fireEvent.pointerMove(bar, { pointerId: 2, clientX: 150 });
  fireEvent.pointerUp(bar, { pointerId: 2 });
  expect(saved()).toMatchObject({ startSeconds: 5, durationSeconds: 10 });
});

it("starts the segment at the frame chosen in the video player", async () => {
  render(<Harness />);
  const video = await ready();
  video.currentTime = 42;
  fireEvent.click(screen.getByRole("button", { name: "Start at playhead" }));
  expect(saved()).toMatchObject({ startSeconds: 42, durationSeconds: 15 });
});

it("plays only the selected interval and keeps soundtrack settings", async () => {
  render(<Harness initial={{ ...original, video: { startSeconds: 30, durationSeconds: 5, includeAudio: false } }} />);
  const video = await ready();
  expect(video.muted).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play selection" })));
  expect(video.currentTime).toBe(30);
  expect(video.play).toHaveBeenCalledTimes(1);
  video.currentTime = 36;
  fireEvent.timeUpdate(video);
  expect(video.currentTime).toBe(35);
  expect(screen.getByRole("button", { name: "Play selection" })).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Include sound"));
  expect(saved().includeAudio).toBe(true);
});

it("uses the whole shorter source and restores a saved selection on reopen", async () => {
  const view = render(<Harness />);
  await ready(8);
  expect(saved()).toMatchObject({ startSeconds: 0, durationSeconds: 8 });
  view.unmount();
  render(<Harness initial={{ ...original, video: { startSeconds: 25, durationSeconds: 8, includeAudio: true } }} />);
  const video = await ready();
  expect(video.currentTime).toBe(25);
  expect(screen.getByText("0:25.0 – 0:33.0")).toBeInTheDocument();
});
