// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { createProjectConfig } from "../lib/project";
import { createEmptyImage } from "../lib/imageHistory";
import { newVideo } from "../lib/videoLibrary";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const project = () => createProjectConfig({ name: "Back navigation", prompt: "Walk", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });

it("uses application Back and Alt+Left for scenes, clears the action on tab switches and preserves the project exit guard", () => {
  const config = project(), onBack = vi.fn();
  config.videos = [{ ...newVideo(null), title: "Film", sceneIds: config.generationJobs.map((scene) => scene.id) }];
  const view = render(<ProjectWorkspace project={{ folderPath: "D:/Back", config }} initialView="generator" onBack={onBack} onSave={async () => {}} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Video title" }), { target: { value: "Renamed film" } });
  fireEvent.click(screen.getByRole("button", { name: "Open Renamed film" }));
  expect(within(view.container.querySelector(".video-scenes")!).queryByRole("button", { name: "Back to Video" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to Video" }));
  expect(screen.getByRole("button", { name: "Open Renamed film" })).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(onBack).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open Renamed film" }));
  fireEvent.click(screen.getByRole("tab", { name: "References" }));
  expect(screen.getByRole("button", { name: "Back to project library" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Video" }));
  expect(screen.getByRole("button", { name: "Back to Video" })).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  expect(screen.getByRole("button", { name: "Open Renamed film" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument(); expect(onBack).not.toHaveBeenCalled();
});

it("uses application Back to show parent images, then restores the project back action", () => {
  let config = createEmptyImage(project());
  const root = config.imageScene!.outputAssetId!;
  config = createEmptyImage(config, undefined, root);
  const child = config.imageScene!.outputAssetId!;
  const onBack = vi.fn();
  render(<ProjectWorkspace project={{ folderPath: "D:/Images", config }} initialView="editor" onBack={onBack} onSave={async () => {}} />);
  const bar = screen.getByLabelText("Generated images");
  expect(bar.querySelector(`[data-image-asset="${child}"]`)).toBeInTheDocument();
  expect(within(bar).queryByRole("button", { name: "Back to all images" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Back to all images" }));
  expect(bar.querySelector(`[data-image-asset="${child}"]`)).not.toBeInTheDocument();
  expect(bar.querySelector(`[data-image-asset="${root}"]`)).toHaveAttribute("aria-pressed", "true");
  expect(onBack).not.toHaveBeenCalled();
  // Opening the family again registers the keyboard action too.
  fireEvent.click(bar.querySelector(`[data-image-asset="${root}"]`)!);
  expect(screen.getByRole("button", { name: "Back to all images" })).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "ArrowLeft", code: "ArrowLeft", altKey: true });
  expect(bar.querySelector(`[data-image-asset="${child}"]`)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Back to project library" })).toBeInTheDocument();
});
