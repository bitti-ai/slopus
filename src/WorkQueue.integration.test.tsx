// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import { saveGeneratedScene } from "./lib/generatedVideo";
import { listRecentProjects, saveProject } from "./lib/persistence";
import { createProjectConfig, type ProjectRecord } from "./lib/project";
import { enqueueSlopfabGeneration, type SlopfabStatus } from "./lib/runtime";
import { loadReferenceIconAutomation } from "./lib/referenceIconSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./lib/generatedVideo", () => ({ saveGeneratedScene: vi.fn(), releaseRendered: vi.fn(async () => true) }));
vi.mock("./lib/timelineThumbnails", async (original) => ({ ...await original<typeof import("./lib/timelineThumbnails")>(), purgeTimelineThumbnails: vi.fn(async () => undefined) }));
vi.mock("./lib/persistence", async (original) => ({ ...await original<typeof import("./lib/persistence")>(), isTauri: () => true, listRecentProjects: vi.fn(), saveProject: vi.fn() }));
vi.mock("./lib/runtime", async (original) => ({
  ...await original<typeof import("./lib/runtime")>(),
  getRuntimeStatus: async () => ({ providers: [], slopfab: { state: "ready", detail: "Ready", models: [] } as unknown as SlopfabStatus }),
  resolveSlopfabPlan: vi.fn(async () => ({ alignedFrames: 120, canvasWidth: 736, canvasHeight: 416 })),
  enqueueSlopfabGeneration: vi.fn(async () => undefined),
}));
const handlers = new Map<string, (event: { payload: unknown }) => void>();
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); handlers.clear();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => { handlers.set(name, handler); return () => handlers.delete(name); }) as unknown as typeof listen);
  vi.mocked(saveProject).mockImplementation(async (record) => record);
  vi.mocked(saveGeneratedScene).mockResolvedValue({ relativePath: "media/generated/queued-result.mp4", bytes: 42, note: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps icon confirmation available after returning to the library", async () => {
  const config = createProjectConfig({ name: "Icon project", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.references = [{ id: "hero", kind: "text", name: "Hero", description: "A friendly explorer", intendedUse: ["character"], createdAt: "2026-09-08T00:00:00.000Z" }];
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [{ folderPath: "C:/Icon project", config }], unreadable: [] });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Icon project" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Generate reference icons?" }, { timeout: 5000 });
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Start generation" }));
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
  expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0]).toMatchObject({ stillImage: true, canvasWidth: 768, steps: 20 });
  expect(screen.queryByRole("alertdialog", { name: "Generate reference icons?" })).toBeNull();
});

it("cancels automatic generation and exposes the remembered choice in Generator settings", async () => {
  const config = createProjectConfig({ name: "Cancel icons", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.references = [{ id: "hero", kind: "text", name: "Hero", description: "A friendly explorer", intendedUse: ["character"], createdAt: "2026-09-08T00:00:00.000Z" }];
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [{ folderPath: "C:/Cancel icons", config }], unreadable: [] });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open Cancel icons" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Generate reference icons?" }, { timeout: 5000 });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(loadReferenceIconAutomation()).toBe("disabled");
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("checkbox", { name: "Automatic reference icon generation" })).not.toBeChecked();
});

it("keeps the application queue alive while switching projects and saves results to their original project", async () => {
  const record = (name: string): ProjectRecord => ({ folderPath: `C:/${name}`, config: createProjectConfig({ name, prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 }) });
  const first = record("First project"), second = record("Second project");
  first.config.generationJobs.push({ ...first.config.generationJobs[0], id: "scene-next", title: "Upcoming scene" });
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [first, second], unreadable: [] });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Open First project" }));
  fireEvent.click(screen.getByRole("button", { name: "Generator" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
  const workId = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].jobId;
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open Second project" }));
  fireEvent.click(screen.getByRole("button", { name: "Work Queue" }));
  const panel = screen.getByRole("dialog", { name: "Work Queue" });
  expect(within(panel).getByRole("region", { name: "In progress" })).toHaveTextContent("First project");
  expect(within(panel).getByRole("region", { name: "Upcoming work" })).toHaveTextContent("Upcoming scene");
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel Upcoming scene in First project" }));
  expect(within(panel).queryByRole("region", { name: "Upcoming work" })).toBeNull();
  fireEvent.click(within(panel).getByRole("button", { name: "Close work queue" }));
  await act(async () => { handlers.get("slopfab-job")?.({ payload: { jobId: workId, state: "framesReady", detail: "Ready" } }); });
  await waitFor(() => expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({ folderPath: first.folderPath, config: expect.objectContaining({ generationJobs: expect.arrayContaining([expect.objectContaining({ status: "completed", outputRelativePath: "media/generated/queued-result.mp4" })]) }) })));
  expect(document.querySelector(".project-title")?.textContent).toBe("Second project");
  expect(saveGeneratedScene).toHaveBeenCalledWith(expect.objectContaining({ jobId: workId, folderPath: first.folderPath }));
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  fireEvent.click(screen.getByRole("button", { name: "Open First project" }));
  fireEvent.click(screen.getByRole("button", { name: "Generator" }));
  expect(screen.getByRole("region", { name: "First scene" })).toHaveTextContent("FINISHED");
});

it("opens an empty queue from the library and closes it with Escape", async () => {
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [], unreadable: [] });
  render(<App />);
  const trigger = screen.getByRole("button", { name: "Work Queue" });
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Work Queue" })).toHaveTextContent("No work yet");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Work Queue" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
