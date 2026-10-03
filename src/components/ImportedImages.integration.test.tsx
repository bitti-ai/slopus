// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createProjectConfig } from "../lib/project";
import { createProject } from "../lib/persistence";
import { ProjectSession } from "../lib/projectSession";
import { captureReferenceVideoFrame } from "../lib/referenceVideoFrame";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView } from "./workspace/TimelineView";
import { ImageEditor } from "./workspace/ImageEditor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../lib/persistence", async (original) => ({ ...await original<typeof import("../lib/persistence")>(), readMediaFileUrl: vi.fn(async () => "blob:image") }));
vi.mock("../lib/referenceVideoFrame", () => ({ captureReferenceVideoFrame: vi.fn() }));
vi.mock("./workspace/MediaThumbnail", () => ({ MediaThumbnail: () => null }));

const input = { name: "Imports", prompt: "", aspectRatio: "16:9" as const, resolution: "416p" as const, targetDurationSeconds: 10 };
beforeEach(() => {
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("URL", class extends URL { static revokeObjectURL = vi.fn(); });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

function setup(view: "references" | "timeline", video = false) {
  const config = createProjectConfig(input);
  config.references = [{ id: "reference", name: "Subject", kind: video ? "video" : "text", description: "", intendedUse: [], createdAt: config.createdAt,
    ...(video ? { sourcePath: "D:/clip.mp4", video: { startSeconds: 0, durationSeconds: 5, includeAudio: false } } : {}) }];
  const session = new ProjectSession({ config, folderPath: "D:/Imports" }, vi.fn());
  function Harness() {
    const { config } = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [editor, setEditor] = useState(false);
    return <><button onClick={() => setEditor(true)}>Open image editor</button>{editor
      ? <ImageEditor config={config} folderPath="D:/Imports" onChange={session.edit} onGenerate={vi.fn()} onCancel={vi.fn()} />
      : view === "references" ? <ReferencesView config={config} folderPath="D:/Imports" onChange={session.edit} />
      : <TimelineView config={config} folderPath="D:/Imports" onChange={session.edit} onOpenGenerator={vi.fn()} />}</>;
  }
  render(<Harness />);
  return session;
}

it.each(["references", "timeline"] as const)("puts images imported from %s in the image bar", async (view) => {
  vi.mocked(invoke).mockImplementation(async (command) => command === "choose_reference_files" || command === "import_media_files"
    ? [{ kind: "image", name: "Photo", relativePath: "references/photo.png", sourcePath: null, mimeType: "image/png" }] : null);
  const session = setup(view);
  fireEvent.click(screen.getAllByRole("button", { name: view === "references" ? "Add file" : /Import media/ })[0]);
  await waitFor(() => expect(session.getSnapshot().config.assets).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Open image editor" }));
  expect(screen.getByRole("button", { name: "View Photo" })).toBeInTheDocument();
});

it("puts a selected video frame in the image bar", async () => {
  const session = setup("references", true);
  fireEvent.click(screen.getByRole("button", { name: "Edit video clip" }));
  const preview = await screen.findByLabelText("Subject video preview");
  Object.defineProperties(preview, { duration: { value: 20 }, readyState: { value: 2 } });
  fireEvent.loadedMetadata(preview);
  fireEvent.click(screen.getByRole("tab", { name: "Frames" }));
  fireEvent.seeked(preview);
  vi.mocked(captureReferenceVideoFrame).mockResolvedValue({ id: "picked", name: "Subject frame", relativePath: "references/frames/picked.png", timeSeconds: 0 });
  fireEvent.click(screen.getByRole("button", { name: "Add current frame" }));
  await waitFor(() => expect(session.getSnapshot().config.assets).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Open image editor" }));
  expect(screen.getByRole("button", { name: "View Subject frame" })).toBeInTheDocument();
});

it("saves initial project reference imports as image assets", async () => {
  const config = createProjectConfig(input);
  config.references = [{ id: "initial", kind: "image", name: "Initial photo", relativePath: "references/initial.jpg", description: "", intendedUse: [], createdAt: config.createdAt }];
  vi.mocked(invoke).mockImplementation(async (command) => command === "create_project" ? { config, folderPath: "D:/Imports" } : undefined);
  const record = await createProject({ ...input, referenceImages: [{ name: "Initial photo", sourcePath: "D:/initial.jpg" }] });
  expect(record!.config.assets).toHaveLength(1);
  expect(record!.config.assets[0]).toMatchObject({ kind: "image", name: "Initial photo", relativePath: "references/initial.jpg" });
  expect(invoke).toHaveBeenCalledWith("save_project", { folderPath: "D:/Imports", config: record!.config });
});
