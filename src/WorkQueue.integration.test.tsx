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
import { reportGenerationJobs } from "./lib/nativeShell";
import { getExportJob, resetExportJobForTests, setExportJobForTests } from "./lib/exportJob";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./lib/nativeShell", async (original) => ({ ...await original<typeof import("./lib/nativeShell")>(), reportGenerationJobs: vi.fn(async () => undefined) }));
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetExportJobForTests(); });

it("keeps icon confirmation available after returning to the library", async () => {
  const config = createProjectConfig({ name: "Icon project", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.references = [{ id: "hero", kind: "text", name: "Hero", description: "A friendly explorer", intendedUse: ["character"], createdAt: "2026-09-08T00:00:00.000Z" }];
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [{ folderPath: "C:/Icon project", config }], unreadable: [] });
  render(<App />);
  fireEvent.doubleClick(await screen.findByRole("option", { name: "Icon project" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  const dialog = await screen.findByRole("dialog", { name: "Generate reference icons?" }, { timeout: 5000 });
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Start generation" }));
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
  expect(vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0]).toMatchObject({ stillImage: true, canvasWidth: 768, steps: 20 });
  expect(screen.queryByRole("dialog", { name: "Generate reference icons?" })).toBeNull();
  // Icons can be interrupted safely, so they never hold the window open: the
  // native exit question is only ever told about an empty list.
  expect(vi.mocked(reportGenerationJobs).mock.calls.every(([jobs]) => jobs.length === 0)).toBe(true);
});

it("cancels automatic generation and exposes the remembered choice in Generator settings", async () => {
  const config = createProjectConfig({ name: "Cancel icons", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.references = [{ id: "hero", kind: "text", name: "Hero", description: "A friendly explorer", intendedUse: ["character"], createdAt: "2026-09-08T00:00:00.000Z" }];
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [{ folderPath: "C:/Cancel icons", config }], unreadable: [] });
  render(<App />);
  fireEvent.doubleClick(await screen.findByRole("option", { name: "Cancel icons" }));
  const dialog = await screen.findByRole("dialog", { name: "Generate reference icons?" }, { timeout: 5000 });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(loadReferenceIconAutomation()).toBe("disabled");
  expect(enqueueSlopfabGeneration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("switch", { name: "Automatic reference icon generation" })).not.toBeChecked();
});

it("keeps the application queue alive while switching projects and saves results to their original project", async () => {
  const record = (name: string): ProjectRecord => ({ folderPath: `C:/${name}`, config: createProjectConfig({ name, prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 }) });
  const first = record("First project"), second = record("Second project");
  first.config.generationJobs.push({ ...first.config.generationJobs[0], id: "scene-next", title: "Upcoming scene" });
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [first, second], unreadable: [] });
  render(<App />);
  fireEvent.doubleClick(await screen.findByRole("option", { name: "First project" }));
  fireEvent.click(screen.getByRole("tab", { name: "Generator" }));
  fireEvent.click(screen.getByRole("button", { name: /^Generate all$/i }));
  await waitFor(() => expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1));
  const workId = vi.mocked(enqueueSlopfabGeneration).mock.calls[0][0].jobId;
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.doubleClick(screen.getByRole("option", { name: "Second project" }));
  // The title-bar button counts what is running or waiting.
  expect(screen.getByRole("button", { name: "Work queue" })).toHaveTextContent("2");
  fireEvent.click(screen.getByRole("button", { name: "Work queue" }));
  const panel = screen.getByRole("dialog", { name: "Work queue" });
  expect(within(panel).getByRole("region", { name: "In progress" })).toHaveTextContent("First project");
  expect(within(panel).getByRole("region", { name: "Upcoming work" })).toHaveTextContent("Upcoming scene");
  fireEvent.click(within(panel).getByRole("button", { name: "Cancel Upcoming scene in First project" }));
  expect(within(panel).queryByRole("region", { name: "Upcoming work" })).toBeNull();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Work queue" })).toBeNull();
  await act(async () => { handlers.get("slopfab-job")?.({ payload: { jobId: workId, state: "framesReady", detail: "Ready" } }); });
  await waitFor(() => expect(saveProject).toHaveBeenCalledWith(expect.objectContaining({ folderPath: first.folderPath, config: expect.objectContaining({ generationJobs: expect.arrayContaining([expect.objectContaining({ status: "completed", outputRelativePath: "media/generated/queued-result.mp4" })]) }) })));
  expect(document.querySelector(".project-title")?.textContent).toBe("Second project");
  expect(saveGeneratedScene).toHaveBeenCalledWith(expect.objectContaining({ jobId: workId, folderPath: first.folderPath }));
  expect(vi.mocked(reportGenerationJobs).mock.calls.some(([jobs]) => jobs.some((job) => job.running && job.title.includes("First project")))).toBe(true);
  expect(enqueueSlopfabGeneration).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
  fireEvent.doubleClick(screen.getByRole("option", { name: "First project" }));
  fireEvent.click(screen.getByRole("tab", { name: "Generator" }));
  expect(screen.getByRole("region", { name: "First scene" })).toHaveTextContent(/finished/i);
});

it("opens an empty queue from the library and closes it with Escape", async () => {
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [], unreadable: [] });
  render(<App />);
  // An empty library shows its empty state without a "0 projects" heading over it.
  expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /All projects/ })).toBeNull();
  expect(screen.getByRole("region", { name: "All projects" })).toBeInTheDocument();
  const trigger = screen.getByRole("button", { name: "Work queue" });
  trigger.focus(); fireEvent.click(trigger);
  const flyout = screen.getByRole("dialog", { name: "Work queue" });
  expect(flyout).toHaveTextContent("No work yet");
  // A light-dismiss flyout, not a modal: no scrim, nothing aria-modal.
  expect(flyout).not.toHaveAttribute("aria-modal");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Work queue" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("guards the window for a running export and lists it in the queue with a Cancel action", async () => {
  vi.mocked(listRecentProjects).mockResolvedValue({ projects: [], unreadable: [] });
  render(<App />);
  expect(vi.mocked(reportGenerationJobs).mock.calls.every(([jobs]) => jobs.length === 0)).toBe(true);
  act(() => setExportJobForTests({
    folderPath: "C:/Film", projectName: "Film", destination: "C:/out/film.mp4",
    progress: { phase: "rendering", framesDone: 18, frameCount: 72, detail: "Rendering frame 18 of 72." },
  }));
  await waitFor(() => expect(reportGenerationJobs).toHaveBeenLastCalledWith([{ title: "Export Film", running: true }]));
  const trigger = screen.getByRole("button", { name: /^Work queue/ });
  fireEvent.click(trigger);
  const flyout = screen.getByRole("dialog", { name: "Work queue" });
  const region = within(flyout).getByRole("region", { name: "Export" });
  expect(region).toHaveTextContent("Export Film");
  expect(region).toHaveTextContent("25%");
  expect(within(region).getByRole("progressbar", { name: "Export Film progress" })).toBeInTheDocument();
  const cancel = within(region).getByRole("button", { name: "Cancel Export Film" });
  fireEvent.click(cancel);
  expect(getExportJob().cancelling).toBe(true);
  expect(cancel).toBeDisabled();
  act(() => setExportJobForTests({ progress: null, cancelling: false, outcome: { kind: "cancelled" } }));
  expect(within(flyout).queryByRole("region", { name: "Export" })).toBeNull();
  await waitFor(() => expect(reportGenerationJobs).toHaveBeenLastCalledWith([]));
});
