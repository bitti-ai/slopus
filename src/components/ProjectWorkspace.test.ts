import { WorkQueue } from "../lib/workQueue";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { compileMiniMaxH3Prompt, createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneShots, UNTITLED_SCENE, type GenerationJob, type ProjectConfig, type ProjectRecord } from "../lib/project";
import { saveGeneratedScene } from "../lib/generatedVideo";
import { formatDurationTimecode, formatSavedAt, formatSequenceLength, isGenerationOngoing } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GeneratorView } from "./workspace/GeneratorView";
import { changePromptChip, insertPromptReference, placePromptCaret, promptChips, promptValue, typePrompt } from "./workspace/promptTestUtils";
import { ReferencesView } from "./workspace/ReferencesView";
import { saveDebugOptionsEnabled } from "../lib/settings";
import { SHOT_TAG_GROUPS } from "../lib/shot-tags";
import { chooseOption, optionNames } from "./workspace/comboTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const storedLine = promptValue;
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../lib/generatedVideo", () => ({ saveGeneratedScene: vi.fn(), releaseRendered: vi.fn(async () => true) }));

afterEach(() => {
  cleanup();
  saveDebugOptionsEnabled(false);
});

/** Runs `body` with the app believing it is inside the desktop shell, so the
 *  REAL Tauri import path executes instead of the browser fallback. */
async function asDesktopApp(importedImage: { name: string; relativePath: string } | Array<{ kind?: "image"; name: string; relativePath: string }>, body: () => void | Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockResolvedValue(importedImage);
  try {
    await body();
  } finally {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  }
}

/** Runs `body` with a media stack that behaves like a browser's: the desktop
 *  shell serves the bytes, blob URLs exist, and a <video>/<audio> element
 *  reports the metadata of a file this long and this big. jsdom loads no media
 *  and never fires a media event, so the decode has to be stood in for — the
 *  numbers under test are the ones the real element would expose. */
async function withFakeDecoder(file: { seconds: number; width: number; height: number }, body: () => Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(8));
  // jsdom implements neither of these, so they are installed rather than
  // replaced — and left installed, because restoring them to `undefined` turns
  // any decode still finishing into an unhandled TypeError.
  URL.createObjectURL = () => "blob:slopus-test";
  URL.revokeObjectURL = () => undefined;
  /* jsdom answers `load` and `getContext` by raising a "not implemented" error
     on its virtual console, which vitest counts as an error in the run. The
     component already treats a canvas it cannot get as no thumbnail, so give it
     the plain refusal rather than the environment's complaint. */
  const media = HTMLMediaElement.prototype.load;
  const canvas = HTMLCanvasElement.prototype.getContext;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLCanvasElement.prototype.getContext = () => null;
  const create = document.createElement.bind(document);
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = create(tag, options);
    if (tag === "video" || tag === "audio") {
      for (const [name, value] of [["duration", file.seconds], ["videoWidth", file.width], ["videoHeight", file.height]] as const) {
        Object.defineProperty(element, name, { value, configurable: true });
      }
      // jsdom's currentTime setter neither seeks nor complains, so the seek for
      // a poster frame has to answer for itself too.
      let currentTime = 0;
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; setTimeout(() => element.dispatchEvent(new Event("seeked")), 0); },
      });
      setTimeout(() => { element.dispatchEvent(new Event("loadeddata")); element.dispatchEvent(new Event("loadedmetadata")); }, 0);
    }
    return element;
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
    HTMLMediaElement.prototype.load = media;
    HTMLCanvasElement.prototype.getContext = canvas;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  }
}

describe("the one definition of an ongoing generation", () => {
  it("is every status with something still to lose, and nothing else", () => {
    const statuses: GenerationJob["status"][] = ["draft", "queued", "generating", "ready", "completed", "failed", "cancelled"];
    /* "ready" is in the list because it does not mean finished: the pictures
       exist and the file does not yet — the app is encoding them into the
       project folder. "completed" is the one that means there is a file. */
    expect(statuses.filter((status) => isGenerationOngoing({ status } as GenerationJob))).toEqual(["queued", "generating", "ready"]);
  });
});

describe("project workspace timecode", () => {
  it("formats project duration as valid hours, minutes, and seconds", () => {
    expect(formatDurationTimecode(0)).toBe("00:00:00");
    expect(formatDurationTimecode(59)).toBe("00:00:59");
    expect(formatDurationTimecode(60)).toBe("00:01:00");
    expect(formatDurationTimecode(600)).toBe("00:10:00");
  });

  it("docks the agent in a pane beside the view, and hides and shows it from the title bar", async () => {
    localStorage.removeItem("slopus.workspace.agentPane");
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config },
      initialView: "timeline",
      runtime: {
        providers: [{ id: "codex", label: "Codex", state: "ready", executable: "codex", version: "test", detail: "Ready" }],
        slopfab: { state: "demo", dllPath: "Browser demo", version: null, platform: null, detail: "Demo", models: [] },
      },
      onBack: () => undefined,
      onSave: async () => undefined,
    }));

    // The views are tabs in the title bar; the agent is not one of them.
    const tabs = screen.getByRole("tablist", { name: "Project views" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual(["Timeline", "Video", "Image", "References", "Export"]);
    expect(within(tabs).getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
    const panel = document.getElementById(within(tabs).getByRole("tab", { name: "Timeline" }).getAttribute("aria-controls")!);
    expect(panel).toHaveAttribute("role", "tabpanel");

    const toggle = screen.getByRole("button", { name: "Agent" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const pane = screen.getByRole("complementary", { name: "Agent" });
    expect(within(pane).getByRole("textbox", { name: "Ask Slop about the edit" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize agent pane" })).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize agent pane" })).toBeNull();
    expect(localStorage.getItem("slopus.workspace.agentPane")).toBe("closed");

    // Ctrl+Shift+A brings it back — the same pane, still mounted.
    fireEvent.keyDown(document.body, { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("complementary", { name: "Agent" })).toBe(pane);
    expect(localStorage.getItem("slopus.workspace.agentPane")).toBe("open");

    // Ctrl+2 switches to the second view.
    fireEvent.keyDown(document.body, { key: "2", code: "Digit2", ctrlKey: true });
    expect(within(tabs).getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
    expect(within(pane).getByRole("textbox", { name: "Ask Slop about this generation queue" })).toBeInTheDocument();
  });

  it("formats the status bar's sequence length and save time", () => {
    expect(formatSequenceLength(32_000)).toBe("32 s");
    expect(formatSequenceLength(2_500)).toBe("2.5 s");
    expect(formatSequenceLength(65_000)).toBe("1:05");
    expect(formatSavedAt(null)).toBe("Saved");
    const now = new Date(2026, 8, 26, 18, 42).getTime();
    expect(formatSavedAt(now, now)).toMatch(/^Saved .*42/);
    expect(formatSavedAt(new Date(2026, 8, 24, 9, 0).getTime(), now)).toMatch(/^Saved .*24/);
  });

  it("keeps one status bar on every view: the view's facts leading, format and save state trailing", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, { project: { folderPath: "C:\Ceramic Lamp", config }, initialView: "references", onBack: () => undefined, onSave: async () => undefined }));
    const bar = screen.getByRole("region", { name: "References status" });
    expect(bar).toHaveTextContent("0 references");
    expect(bar).toHaveTextContent(`1920×1080 · ${config.settings.frameRate} fps · 0 s`);
    expect(bar).toHaveTextContent(/Saved/);

    const tabs = screen.getByRole("tablist", { name: "Project views" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "Video" }));
    const generatorBar = screen.getByRole("region", { name: "Video status" });
    expect(generatorBar).toBe(bar);
    expect(within(generatorBar).getByRole("status")).toHaveTextContent(/scene/);
    expect(generatorBar).not.toHaveTextContent("references");
    expect(document.querySelectorAll(".ui-statusbar")).toHaveLength(1);
  });

  it("marks the scene open in the Generator in the Timeline's sources", () => {
    const base = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = { ...base, generationJobs: [
      createDraftGenerationJob("First", { id: "scene-first", title: "First scene" }),
      createDraftGenerationJob("Second", { id: "scene-second", title: "Second scene" }),
    ] };
    render(createElement(ProjectWorkspace, { project: { folderPath: "C:\Ceramic Lamp", config }, initialView: "generator", onBack: () => undefined, onSave: async () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Select scene Second scene" }));
    const tabs = screen.getByRole("tablist", { name: "Project views" });
    fireEvent.click(within(tabs).getByRole("tab", { name: "Timeline" }));
    const open = [...document.querySelectorAll(".scene-card.is-selected")];
    expect(open).toHaveLength(1);
    expect(open[0]).toHaveTextContent("Second scene");
  });

  it("surfaces native save failures in the workspace, inline under the title bar", async () => {
    const record = { folderPath: "C:\\Portable Launch Film", config: parseProjectConfig(completeFixture) };
    const queue = new WorkQueue(async () => { throw new Error("The original project file is locked."); });
    render(createElement(ProjectWorkspace, { project: record, workQueue: queue, initialView: "export", onBack: () => undefined, onSave: async () => undefined }));
    // Save is the only save state in the title bar, so it is off until there
    // is something to write.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    act(() => queue.project(record).edit((current) => ({ ...current, name: "Renamed" })));
    expect(save).toBeEnabled();
    fireEvent.keyDown(document.body, { key: "s", code: "KeyS", ctrlKey: true });
    const alert = await waitFor(() => within(document.querySelector<HTMLElement>(".project-infobars")!).getByRole("alert"));
    expect(alert).toHaveClass("ui-infobar");
    expect(alert.textContent).toContain("Couldn’t save project");
    expect(alert.textContent).toContain("The original project file is locked.");
    fireEvent.click(within(alert).getByRole("button", { name: "Close" }));
    expect(document.querySelector(".project-infobars")).toBeNull();
  });

  it("undoes and redoes project edits from the title bar and the keyboard, but not inside a text field", () => {
    const record = { folderPath: "C:\\Undo", config: createProjectConfig({ name: "Before", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 }) };
    const queue = new WorkQueue(async (saved) => saved);
    render(createElement(ProjectWorkspace, { project: record, workQueue: queue, initialView: "export", onBack: () => undefined, onSave: async () => undefined }));
    const session = queue.project(record);
    const title = () => screen.getByRole("button", { name: /^Edit project settings for / }).textContent;
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAttribute("data-tooltip-shortcut", "Ctrl+Z");
    act(() => session.edit((current) => ({ ...current, name: "After" }), "name"));
    expect(title()).toBe("After");
    fireEvent.click(undo);
    expect(title()).toBe("Before");
    expect(redo).toBeEnabled();
    fireEvent.keyDown(document.body, { key: "y", code: "KeyY", ctrlKey: true });
    expect(title()).toBe("After");
    fireEvent.keyDown(document.body, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(title()).toBe("Before");
    fireEvent.keyDown(document.body, { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true });
    expect(title()).toBe("After");
    // A text field keeps its own undo.
    const field = document.createElement("input");
    document.body.append(field);
    fireEvent.keyDown(field, { key: "z", code: "KeyZ", ctrlKey: true });
    expect(title()).toBe("After");
    field.remove();
  });

  it("goes back to the library with Alt+Left, asking first when there are unsaved edits", () => {
    const record = { folderPath: "C:\\Back", config: createProjectConfig({ name: "Back", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 }) };
    const queue = new WorkQueue(async (saved) => saved);
    const onBack = vi.fn();
    render(createElement(ProjectWorkspace, { project: record, workQueue: queue, initialView: "export", onBack, onSave: async () => undefined }));
    fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
    expect(onBack).toHaveBeenCalledOnce();
    act(() => queue.project(record).edit((current) => ({ ...current, name: "Edited" })));
    fireEvent.keyDown(document.body, { key: "ArrowLeft", altKey: true });
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog", { name: "Save changes to “Edited”?" })).toBeInTheDocument();
  });

  it("counts running generations on the Video tab, and returns to the library without a generation warning", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const now = new Date().toISOString();
    config.generationJobs = [
      ...(["generating", "queued", "ready"] as const).map((status, index) => ({ ...config.generationJobs[0], id: `job-${index}`, title: `Shot ${index + 1}`, status, updatedAt: now })),
      ...config.generationJobs,
    ];
    const onBack = vi.fn();
    render(createElement(ProjectWorkspace, { project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "export", onBack, onSave: async () => undefined }));
    const generator = within(screen.getByRole("tablist", { name: "Project views" })).getByRole("tab", { name: "Video" });
    expect(generator.querySelector(".ui-badge")?.textContent).toBe("3");
    fireEvent.click(screen.getByRole("button", { name: "Back to project library" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("persists a completed generation without waiting for the Save button", async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>();
    const scope = globalThis as unknown as Record<string, unknown>;
    scope.__TAURI_INTERNALS__ = {};
    vi.mocked(listen).mockImplementation((async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }) as unknown as typeof listen);
    vi.mocked(saveGeneratedScene).mockResolvedValue({
      relativePath: "media/generated/job-initial-brief.mp4",
      bytes: 4_200_000,
      note: null,
    });
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const jobId = config.generationJobs[0].id;
    const onSave = vi.fn(async (_record: ProjectRecord) => undefined);
    const mediaLoad = HTMLMediaElement.prototype.load;
    HTMLMediaElement.prototype.load = vi.fn();

    const runtimeModule = await import("../lib/runtime");
    const resolvePlan = vi.spyOn(runtimeModule, "resolveSlopfabPlan").mockResolvedValue({ alignedFrames: 120, canvasWidth: 736, canvasHeight: 416 } as Awaited<ReturnType<typeof runtimeModule.resolveSlopfabPlan>>);
    const enqueue = vi.spyOn(runtimeModule, "enqueueSlopfabGeneration").mockResolvedValue(undefined);
    const queue = new WorkQueue(onSave);
    const record = { folderPath: "C:/Ceramic Lamp", config };
    const stop = queue.start();
    queue.enqueue(queue.project(record), [{ job: config.generationJobs[0], snapshot: "test", request: { jobId, prompt: "A quiet film", frames: 120, steps: 12, seed: 42, canvasWidth: 736, canvasHeight: 416, referencePaths: [] } }]);
    try {
      await waitFor(() => expect(enqueue).toHaveBeenCalled());
      render(createElement(ProjectWorkspace, {
        project: record,
        workQueue: queue,
        initialView: "timeline",
        onBack: () => undefined,
        onSave,
      }));
      await waitFor(() => expect(handlers.has("slopfab-job")).toBe(true));
      await act(async () => {
        handlers.get("slopfab-job")?.({ payload: { jobId: queue.getSnapshot()[0].id, state: "framesReady", detail: "Frames ready." } });
        await Promise.resolve();
      });
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

      const saved = onSave.mock.calls[1][0];
      expect(saved.config.generationJobs[0]).toMatchObject({
        status: "completed",
        outputRelativePath: "media/generated/job-initial-brief.mp4",
      });
      expect(parseProjectConfig(saved.config)).toBeTruthy();
      await waitFor(() => expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true));
    } finally {
      stop(); resolvePlan.mockRestore(); enqueue.mockRestore();
      cleanup();
      HTMLMediaElement.prototype.load = mediaLoad;
      delete scope.__TAURI_INTERNALS__;
      vi.mocked(listen).mockReset();
      vi.mocked(listen).mockImplementation(async () => () => undefined);
      vi.mocked(saveGeneratedScene).mockReset();
    }
  });

  it("opens the existing unstarted draft instead of duplicating it", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "timeline",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
    await screen.findByRole("toolbar", { name: "Generator" });
    // A new project already carries one draft made from the user's own words.
    // "Add or generate a scene" must open that, not stack a second near-identical
    // shot the user has no way to tell apart.
    expect(screen.getByRole("heading", { name: "First scene" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "New scene draft" })).toBeNull();
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("leaves the monitor empty rather than explaining the emptiness", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "timeline",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    expect(screen.queryByTestId("project-empty-monitor")).toBeNull();
    expect(screen.queryByText(/Nothing to play yet/)).toBeNull();
    // The point the old placeholder was carrying: no other project's demo
    // footage ever appears in this one's monitor.
    expect(screen.queryByText("NORTHERN LIGHT")).toBeNull();
  });

  /** A project carrying one importable clip of each kind, so the media panel
   *  has a card that belongs on a video track and one that belongs on audio. */
  function projectWithMedia(): ProjectConfig {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    return parseProjectConfig({ ...fresh, assets: [{
      id: "asset-macro", kind: "video", name: "Macro footage", relativePath: "media/imported/macro.mp4",
      mimeType: "video/mp4", durationMs: null, width: null, height: null, createdAt: fresh.createdAt,
    }, {
      id: "asset-room", kind: "audio", name: "Room tone", relativePath: "media/imported/room.wav",
      mimeType: "audio/wav", durationMs: null, width: null, height: null, createdAt: fresh.createdAt,
    }] });
  }

  it("does not mark a saved project edited for having its media looked at", async () => {
    /* N3: opening the Media panel measured the files, the measurement went back
       through the same door as a user's edit, and Save lit up on a project
       nobody had touched — "Save your changes to this project folder" over a
       folder that had none. A measurement is still worth keeping, so it stays
       in the project and rides along with the next real save. */
    const onSave = vi.fn(async (_record: ProjectRecord) => undefined);
    const project = { folderPath: "C:\\Looked At", config: projectWithMedia() };
    await withFakeDecoder({ seconds: 40, width: 1920, height: 1080 }, async () => {
      render(createElement(ProjectWorkspace, { project, onBack: () => undefined, onSave }));
      const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      expect(save().disabled).toBe(true);
      expect(save().getAttribute("data-tooltip")).toBe("Everything is saved");

      fireEvent.click(screen.getByRole("tab", { name: "Media" }));
      // The panel prints the length it read, so this waits on the measurement
      // itself rather than on a guess at how long a decode takes.
      await waitFor(() => expect(screen.getAllByText(/40\.0s/).length).toBe(2), { timeout: 8_000 });
      expect(save().disabled).toBe(true);
      expect(save().getAttribute("data-tooltip")).toBe("Everything is saved");

      // An actual edit still turns it on, and carries the measurement with it.
      fireEvent.change(screen.getAllByLabelText(/^Rename /)[0], { target: { value: "Opening layer" } });
      expect(save().disabled).toBe(false);
      fireEvent.click(save());
      await waitFor(() => expect(onSave).toHaveBeenCalled());
    });
    const saved = onSave.mock.calls[0][0];
    expect(saved.config.assets.map((asset) => asset.durationMs)).toEqual([40_000, 40_000]);
    expect(parseProjectConfig(saved.config)).toBeTruthy();
  }, 20_000);

  it("keeps timeline actions out of scene settings", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(screen.queryByRole("button", { name: "Insert into Track 1" })).toBeNull();
  });

  it("counts only the references that actually reach the compiled prompt", () => {
    saveDebugOptionsEnabled(true);
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-lamp", kind: "text", name: "Lamp silhouette", description: "Matte cream ceramic, tapered neck.", content: "Matte cream ceramic, tapered neck.", intendedUse: ["product"], createdAt },
      // Described, then cleared to be rewritten — compileMiniMaxH3Prompt skips it.
      { id: "ref-blank", kind: "text", name: "Lead character", description: "", content: null, intendedUse: ["character"], createdAt },
      // Audio-only, so isVisualReference skips it too.
      { id: "ref-score", kind: "text", name: "Score idea", description: "Sparse piano.", content: "Sparse piano.", intendedUse: ["audio"], createdAt },
    ];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-lamp", "ref-blank", "ref-score"] }] });
    config.generationJobs[0].shots![0].action = "@[ref:ref-lamp] @[ref:ref-blank] @[ref:ref-score]";
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(document.querySelector(".debug-prompt-dialog .compiled-prompt__text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Debug prompt" }));
    const prompt = document.querySelector(".debug-prompt-dialog .compiled-prompt__text")!.textContent!;
    expect(prompt).toContain("<Subject 1>");
    expect(prompt).not.toContain("Lead character");
    expect(prompt).not.toContain("Score idea");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("renames a scene, and never saves it nameless", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const field = screen.getByRole("textbox", { name: "Rename First scene" });
    fireEvent.change(field, { target: { value: "Clay on the wheel" } });
    expect(onChange.mock.calls[0][0].generationJobs[0].title).toBe("Clay on the wheel");
    // The schema has no room for an empty title, so an emptied field falls back.
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange.mock.calls[1][0].generationJobs[0].title).toBe("Untitled scene");
    expect(parseProjectConfig(onChange.mock.calls[1][0])).toBeTruthy();
  });

  it("keeps reference selection controls out of scene settings", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-lamp", kind: "text", name: "Lamp silhouette", description: "Matte cream ceramic, tapered neck.", content: "Matte cream ceramic, tapered neck.", intendedUse: ["product"], createdAt },
      { id: "ref-light", kind: "text", name: "Window light", description: "Soft north light, long shadows.", content: "Soft north light, long shadows.", intendedUse: ["style"], createdAt },
    ];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-lamp"] }] });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(container.querySelector(".job-refs")).toBeNull();
  });

  it("keeps reference previews out of scene settings", () => {
    /* This list used to render <i class="ref-mini ref-mini--{index}"> against a
       hardcoded gradient, and only --1 had a rule of its own — so every
       reference except the second wore the SAME fabricated picture, over files
       that were sitting on disk and already rendered properly by
       ReferencesView. The rule here is the one the scene thumb and the media
       thumb follow: a labelled placeholder, never invented art. */
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-photo", kind: "image", name: "Lamp photograph", description: "The lamp itself.", relativePath: "references/lamp.jpg", intendedUse: ["product"], createdAt },
      { id: "ref-light", kind: "text", name: "Window light", description: "Soft north light.", content: "Soft north light.", intendedUse: ["style"], createdAt },
    ];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-photo"] }] });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    expect(container.querySelector(".job-refs")).toBeNull();
    expect(container.querySelector(".scene-settings img, .scene-settings .reference-image-fallback")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start frame for this scene" }));
    expect(screen.getByRole("dialog", { name: "Start frame for this scene" })).toHaveTextContent("Lamp photograph");
  });

  it("keeps scene settings editable while a scene is running", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const references = [{ id: "ref-lamp", kind: "text", name: "Lamp silhouette", description: "Matte cream ceramic.", content: "Matte cream ceramic.", intendedUse: ["product"], createdAt: fresh.createdAt }];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.4, referenceIds: ["ref-lamp"] }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect((screen.getByRole("combobox", { name: "The look of this scene" }) as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "The sound of this scene" }) as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "The music of this scene" }) as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("spinbutton", { name: "Generation step count" }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("spinbutton", { name: "Generation seed" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("does not show reference guidance in scene settings", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const references = [{ id: "ref-blank", kind: "text", name: "Lead character", description: "", content: null, intendedUse: ["character"], createdAt: fresh.createdAt }];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-blank"] }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(screen.queryByText("No references used by this scene")).toBeNull();
    expect(screen.queryByText("The video engine only follows the words in the shots.")).toBeNull();
  });

  it("keeps a half-written shot line when you visit another tab and come back", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "generator",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    const line = () => screen.getByRole("textbox", { name: "Describe shot 1" });
    openShot(1);
    typePrompt(line(), "a slow push across the launch pad");
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    await screen.findByRole("heading", { name: "Timeline", level: 2 });
    fireEvent.click(screen.getByRole("tab", { name: "Video" }));
    await screen.findByRole("toolbar", { name: "Generator" });
    /* The trip unmounted the generator, so the panel is back on the scene and
       the card is where the words have to have survived. */
    expect(screen.getByRole("button", { name: "Shot 1 of First scene" }).textContent)
      .toContain("a slow push across the launch pad");
    openShot(1);
    /* Switching tabs unmounts the generator. The words are no longer typed into
       a composer the parent has to hold on its behalf — every keystroke lands on
       the scene itself, so the project carries them across the trip. Losing the
       user's own half-written words is the one thing this app must never do. */
    expect(storedLine(line())).toBe("a slow push across the launch pad");
  });

  it("does not bind an audio-tagged reference a new shot's prompt would drop", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, references: [
      { id: "ref-audio", kind: "text", name: "Score idea", description: "Sparse piano.", content: "Sparse piano.", intendedUse: ["audio"], createdAt: fresh.createdAt },
    ] });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
    // It would take a binding slot and then be dropped by the compiler, so the
    // shot would claim a reference its prompt never mentions.
    expect(onChange.mock.calls[0][0].generationJobs[0].referenceIds).toEqual([]);
  });

  it("sends no filename and no app boilerplate to the model for a really imported image", async () => {
    // Built the way the PRODUCT builds it — the actual "Add image" button and
    // the actual Tauri import path — not a hand-written reference with a tidy
    // name and description. Every earlier compiler test supplied both by hand,
    // which is exactly why this shipped.
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const onChange = vi.fn();
    await asDesktopApp([{ kind: "image", name: "IMG_4821", relativePath: "references/IMG_4821.jpg" }], async () => {
      const view = render(createElement(ReferencesView, { config, folderPath: "C:\\Ceramic Lamp", onChange }));
      fireEvent.click(screen.getByRole("button", { name: /Reference browser/ }));
      const dialog = screen.getByRole("dialog", { name: "Add reference" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Product" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "New" }));
      const withReference = onChange.mock.calls[0][0];
      view.rerender(createElement(ReferencesView, { config: withReference, folderPath: "C:\\Ceramic Lamp", onChange }));
      onChange.mockClear();
      fireEvent.click(screen.getByRole("button", { name: "Add file" }));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
    });

    const imported = onChange.mock.calls[0][0].references[0];
    expect(imported.kind).toBe("text");
    expect(imported.relativePath).toBeUndefined();
    expect(imported.images[0].relativePath).toBe("references/IMG_4821.jpg");
    // The import writes no prose: description is what the compiler hands the
    // model as the user's own account of the picture.
    expect(imported.description).toBe("");

    const compiled = compileMiniMaxH3Prompt("a cat walking across a sunny kitchen floor", [imported]);
    expect(compiled).toContain("<Subject 1> is the content shown in <Picture 1>.");
    for (const line of compiled.split("\n").filter((row) => row.startsWith("<Subject "))) {
      expect(line).not.toContain("IMG_4821");
      expect(line).not.toContain("Visual reference");
    }
    expect(compiled).not.toContain("IMG_4821");
    expect(compiled).not.toContain("Visual reference");
    expect(compiled).toContain("fully_preserved - the referenced characteristics are retained.");

    // The screen must describe the rule the code implements. isReferenceUsable
    // qualifies an image on its FILE alone, so this imported picture IS bound
    // and IS sent — nothing on the page may say it is skipped or waiting on a
    // definition. The explainer panel that once said exactly that is gone; the
    // card is now the only place the screen states the rule, and it says the
    // file is sent.
    cleanup();
    const withImport = onChange.mock.calls[0][0];
    expect(withImport.references[0].images).toHaveLength(1);
    const { container } = render(createElement(ReferencesView, { config: withImport, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined }));
    const screenText = container.textContent ?? "";
    for (const staleRule of ["you’ve described", "described references", "skipped", "is skipped until you write"]) {
      expect(screenText, `stale binding rule on screen: ${staleRule}`).not.toContain(staleRule);
    }
    expect(screenText).toContain("Not described yet — the picture is sent, but nothing tells the engine what to keep.");
  });

  it("lays references out as a scrolling main area beside a full-height inspector", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container } = render(createElement(ReferencesView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined }));
    const view = container.querySelector(".references-view")!;
    expect(Array.from(view.children).map((element) => element.className.split(" ")[0])).toEqual(["references-main", "ui-splitter", "reference-inspector"]);
    expect(container.querySelector(".references-heading__actions")).toBeNull();
    expect(screen.getByRole("button", { name: /Reference browser/ })).not.toBeNull();
    expect(container.querySelector(".reference-inspector__scroll")).not.toBeNull();
    expect(container.querySelector(".reference-layout")).toBeNull();
    expect(container.querySelector(".reference-library__toolbar")).toBeNull();
  });

  /* The Generator is a board of shot cards and a panel that edits whichever
     one is open. It opens on the SCENE — the thing with a state, a prompt and a
     Generate button — so a test that wants a shot's own controls has to choose
     its card first, exactly as a user would. */

  /** Opens one shot's card, which is what puts its line and settings in the
   *  panel on the right. */
  const openShot = (shotNumber: number, sceneTitle = "First scene") =>
    fireEvent.click(screen.getByRole("button", { name: `Shot ${shotNumber} of ${sceneTitle}` }));

  /** Opens the scene's own settings, which live on the line that separates its
   *  row of cards from the next scene's. */
  const openScene = (sceneTitle = "First scene") =>
    fireEvent.click(screen.getByRole("button", { name: `Select scene ${sceneTitle}` }));

  /** Opens the exact prompt preview without accidentally closing it when a
   *  test returns to the scene panel more than once. */
  const openDebugPrompt = () => {
    act(() => saveDebugOptionsEnabled(true));
    const button = screen.getByRole("button", { name: "Debug prompt" });
    if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
  };

  /** Adds one setting to one shot: choose the setting, then choose its value.
   *  Settings are added one at a time now, rather than laid out as a wall of
   *  every term the vocabulary holds. */
  function addSetting(shotNumber: number, group: string, value: string) {
    const owner = SHOT_TAG_GROUPS.find((item) => item.id === group)!;
    chooseOption(screen.getByRole("combobox", { name: `Add a setting to shot ${shotNumber}` }), new RegExp(`^${owner.label}`));
    chooseOption(screen.getByRole("combobox", { name: new RegExp(`^Value for .* on shot ${shotNumber}$`) }), owner.options.find((option) => option.id === value)!.label);
  }

  /** A setting or look ComboBox, chosen by the stored value the old <select>s took. */
  function chooseTag(name: string, value: string) {
    const combobox = screen.getByRole("combobox", { name });
    const group = name.startsWith("Add a setting")
      ? undefined
      : name === "The look of this scene"
        ? SHOT_TAG_GROUPS.find((item) => item.id === "visualStyle")
        : SHOT_TAG_GROUPS.find((item) => name.startsWith(`Value for ${item.label} `));
    const label = group ? group.options.find((option) => option.id === value)!.label : SHOT_TAG_GROUPS.find((item) => item.id === value)!.label;
    chooseOption(combobox, group ? label : new RegExp(`^${label}`));
  }

  const lampProject = () => createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });

  it("has no scene rail: the scenes ARE the board, and the panel edits one thing", () => {
    const fresh = lampProject();
    for (const config of [parseProjectConfig({ ...fresh, generationJobs: [] }), fresh]) {
      const empty = config.generationJobs.length === 0;
      const { container, unmount } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
      /* The rail on the left is gone. Every scene is a row of shot cards in the
         middle instead, and the panel on the right is the ONE place anything is
         edited — so with nothing to edit there is no panel at all. */
      expect(screen.queryByRole("complementary", { name: "Scenes" })).toBeNull();
      expect(container.querySelector(".queue-panel")).toBeNull();
      expect(Boolean(container.querySelector(".scene-board"))).toBe(!empty);
      expect(Boolean(container.querySelector(".generator-panel"))).toBe(!empty);
      expect(container.querySelector(".generator-heading .eyebrow")).toBeNull();
      expect(screen.queryByRole("button", { name: "View timeline" })).toBeNull();
      /* The composer panel is gone. A new scene is added EMPTY — nothing on this
         page turns a sentence into a scene any more, so nothing may advertise
         that it does. */
      expect(screen.queryByRole("heading", { name: "Start another scene" })).toBeNull();
      expect(container.querySelector(".generation-composer")).toBeNull();
      expect(screen.getByRole("button", { name: "Add scene" })).not.toBeNull();
      unmount();
    }
  });

  it("shows every shot as a card, in the order they play, under its own scene line", () => {
    const fresh = lampProject();
    const config = parseProjectConfig({
      ...fresh,
      generationJobs: [
        { ...fresh.generationJobs[0], title: "Second scene", id: "job-second", durationSeconds: 8, shots: [{ id: "b1", startSeconds: 0, action: "the door opens" }] },
        { ...fresh.generationJobs[0], durationSeconds: 9, shots: [
          { id: "a1", startSeconds: 0, action: "she walks towards the camera" },
          { id: "a2", startSeconds: 4.5, action: "she stops at the doorway" },
        ] },
      ],
    });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));

    // One section per scene, each with its own line, and the cards inside it in
    // playing order.
    const sections = [...container.querySelectorAll(".scene-section")];
    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Second scene", "First scene"]);
    const cards = [...sections[1].querySelectorAll(".shot-card:not(.shot-card--add)")];
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Shot 1 of First scene", "Shot 2 of First scene"]);
    // The card carries the words and the span it covers — it IS the summary.
    expect(cards[0].textContent).toContain("she walks towards the camera");
    expect(cards[0].textContent).toContain("0.0s – 4.5s");
    expect(cards[1].textContent).toContain("4.5s – 9.0s");
    // Nothing has been rendered, so no card invents a picture.
    expect(container.querySelector(".shot-thumb--poster")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Shot 1 — Not rendered yet" }).length).toBe(2);
  });

  it("opens a shot in the panel when its card is chosen, and the scene from the scene line", () => {
    const config = lampProject();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // It opens on the scene: the thing with a state, a prompt and a Generate
    // button.
    expect(screen.getByRole("textbox", { name: "Rename First scene" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Describe shot 1" })).toBeNull();

    openShot(1);
    expect(screen.getByRole("textbox", { name: "Describe shot 1" })).not.toBeNull();
    // The shared scene header stays visible, while the right panel edits only
    // the shot.
    expect(screen.getByRole("slider", { name: "First scene length in seconds" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Rename First scene" })).toBeNull();

    // And the way back up is named, so a shot is never a dead end.
    fireEvent.click(screen.getByRole("button", { name: "First scene" }));
    expect(screen.getByRole("slider", { name: "First scene length in seconds" })).not.toBeNull();

    openShot(1);
    openScene();
    expect(screen.getByRole("textbox", { name: "Rename First scene" })).not.toBeNull();
  });

  it("adds an EMPTY scene from the + button — one blank shot, no words this app wrote", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const { rerender } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));

    const next = onChange.mock.calls.at(-1)![0];
    // It goes to the bottom and does not disturb the scene already there.
    expect(next.generationJobs).toHaveLength(2);
    expect(next.generationJobs[0]).toEqual(config.generationJobs[0]);
    const added = next.generationJobs[1];
    expect(added.status).toBe("draft");
    // One shot with nothing in it, and a name that says so rather than a phrase
    // Slopus made up out of words the user never typed.
    expect(sceneShots(added).map((shot) => shot.action)).toEqual([""]);
    expect(added.title).toBe(UNTITLED_SCENE);
    expect(added.prompt).toBe("");
    expect(added.creativeBrief).toBe("");
    // Both validators have to accept it — Rust writes this to disk before the
    // frontend ever parses it back (see CLAUDE.md).
    expect(() => parseProjectConfig(next)).not.toThrow();

    // And it cannot be generated until the user writes a line in it.
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: added.id }));
    const addedScene = screen.getByRole("region", { name: UNTITLED_SCENE });
    const generate = within(addedScene).getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
  });

  it("splits a scene into three shots, each with its own line and cut", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const { rerender } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Two more shots, and the scene stretched to hold them.
    fireEvent.click(screen.getByRole("button", { name: "Add a shot to First scene" }));
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].shots).toHaveLength(2);
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Add a shot to First scene" }));
    next = onChange.mock.calls.at(-1)![0];
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    openScene();
    fireEvent.change(screen.getByRole("slider", { name: "First scene length in seconds" }), { target: { value: "9" } });
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].durationSeconds).toBe(9);
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Each cut is set on its shot, and the second and third lines are written.
    for (const [shotNumber, startSeconds, line] of [[2, 3, "she stops at the doorway"], [3, 6.5, "the door opens"]] as const) {
      openShot(shotNumber);
      fireEvent.change(screen.getByRole("spinbutton", { name: `Shot ${shotNumber} starts at, in seconds` }), { target: { value: String(startSeconds) } });
      next = onChange.mock.calls.at(-1)![0];
      rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
      typePrompt(screen.getByRole("textbox", { name: `Describe shot ${shotNumber}` }), line);
      next = onChange.mock.calls.at(-1)![0];
      rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    }

    openScene();
    openDebugPrompt();
    const compiled = document.querySelector(".compiled-prompt__text")!.textContent!;
    expect(compiled).toContain("[Shot 1] Live-action, cinematic, A quiet product film.");
    expect(compiled).toContain("[Shot 2] At 00:03.000, she stops at the doorway.");
    expect(compiled).toContain("[Shot 3] At 00:06.500, the door opens");
    expect(compiled.indexOf("[Shot 2]")).toBeLessThan(compiled.indexOf("[Shot 3]"));
    // And the whole thing is still a project that can be saved.
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("keeps the scene inside nought to fifteen seconds", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const app = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const length = () => screen.getByRole("slider", { name: "First scene length in seconds" }) as HTMLInputElement;
    // The length belongs to the scene, so it is on the scene's header.
    expect(length().min).toBe("0");
    expect(length().max).toBe("15");
    // The bound is enforced, not merely advertised: a hand-set value past the
    // end is clamped rather than persisted as a scene the schema refuses.
    fireEvent.change(length(), { target: { value: "40" } });
    expect(onChange.mock.calls.at(-1)![0].generationJobs[0].durationSeconds).toBe(15);
    fireEvent.change(length(), { target: { value: "-3" } });
    const emptied = onChange.mock.calls.at(-1)![0];
    expect(emptied.generationJobs[0].durationSeconds).toBe(0);
    expect(parseProjectConfig(emptied)).toBeTruthy();
    // A scene of no length has no frames to render; the header keeps the value
    // editable without adding another description to the settings panel.
    app.rerender(createElement(GeneratorView, { config: parseProjectConfig(emptied), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(length().value).toBe("0");
  });

  it("adds a setting to one shot and takes it off again, without touching the other shot", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const { rerender } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    openShot(1);
    addSetting(1, "cameraMovement", "push-in");
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].shots[0].settings).toEqual({ cameraMovement: ["push-in"] });
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Speed only means something once a movement exists, so it is refused until
    // then and offered afterwards — the compiler drops it otherwise.
    addSetting(1, "cameraSpeed", "slow");
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].shots[0].settings).toEqual({ cameraMovement: ["push-in"], cameraSpeed: ["slow"] });
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // The compiled prompt shows it immediately, with the term marked as the
    // user's choice rather than as their own prose.
    openScene();
    openDebugPrompt();
    const prompt = document.querySelector(".compiled-prompt__text")!;
    expect(prompt.textContent).toContain("Camera movement: push in, slow speed.");
    expect([...document.querySelectorAll(".prompt-part--tag")].map((part) => part.textContent)).toContain("push in, slow speed");
    expect(document.querySelector(".prompt-part--brief")!.textContent).not.toContain("push in");

    openShot(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Camera movement: Push in from shot 1" }));
    expect(onChange.mock.calls.at(-1)![0].generationJobs[0].shots[0].settings).toEqual({ cameraSpeed: ["slow"] });
  });

  it("refuses movement speed until there is a movement for it to qualify", () => {
    const config = lampProject();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    openShot(1);
    // Not merely disabled — it says why, the way every other blocked control on
    // this screen does.
    const menu = screen.getByRole("combobox", { name: "Add a setting to shot 1" });
    fireEvent.click(menu);
    const speed = screen.getByRole("option", { name: /^Movement speed/ });
    expect(speed).toHaveAttribute("aria-disabled", "true");
    expect(speed.textContent).toContain("Needs a camera movement first");
    // The look belongs to the whole scene, so it is not offered per shot — it is
    // on the scene's own panel instead.
    expect(screen.queryByRole("option", { name: "Look" })).toBeNull();
    fireEvent.click(menu);
    openScene();
    expect(screen.getByRole("combobox", { name: "The look of this scene" })).not.toBeNull();
  });

  it("reopens a scene written before scenes existed, with its tags on its one shot", () => {
    const fresh = lampProject();
    // The legacy shape: no shots, no length, tags on the job itself.
    const legacy = { ...fresh.generationJobs[0], shots: null, durationSeconds: null, shotTags: { lens: ["macro-lens"] } };
    const config = parseProjectConfig({ ...fresh, generationJobs: [legacy] });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // One shot, holding the words and the tags the file already had.
    openShot(1);
    expect(storedLine(screen.getByRole("textbox", { name: "Describe shot 1" }))).toBe("A quiet product film");
    // The legacy per-job tag now reads as a setting ON the shot.
    expect(screen.getByRole("button", { name: "Remove Lens: Macro from shot 1" })).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Describe shot 2" })).toBeNull();
    // Only one card, because a legacy scene is read as a single-shot scene.
    expect(screen.queryByRole("button", { name: "Shot 2 of First scene" })).toBeNull();
    openScene();
    openDebugPrompt();
    expect(document.querySelector(".compiled-prompt__text")!.textContent).toContain("macro lens, A quiet product film");
    // Its length remains on the header slider; the old length/shot-count line
    // under the scene name is gone.
    expect((screen.getByRole("slider", { name: "First scene length in seconds" }) as HTMLInputElement).value).toBe("6");
    expect(screen.queryByText("6.0 seconds, one shot")).toBeNull();

    // The first edit moves the tags onto the shot, and clears the legacy copy
    // so the two can never disagree.
    openShot(1);
    addSetting(1, "lighting", "soft-light");
    const next = onChange.mock.calls.at(-1)![0].generationJobs[0];
    expect(next.shots[0].settings).toEqual({ lens: ["macro-lens"], lighting: ["soft-light"] });
    expect(next.shotTags).toBeNull();
    expect(parseProjectConfig(onChange.mock.calls.at(-1)![0])).toBeTruthy();
  });

  it("keeps a running scene and its shots editable for the next generation", () => {
    const fresh = lampProject();
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.4 }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect((screen.getByRole("slider", { name: "First scene length in seconds" }) as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Add a shot to First scene" }) as HTMLButtonElement).disabled).toBe(false);
    openShot(1);
    expect(screen.getByRole("textbox", { name: "Describe shot 1" })).toHaveAttribute("contenteditable", "true");
    expect((screen.getByRole("combobox", { name: "Add a setting to shot 1" }) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/It can be changed once it finishes/)).toBeNull();
  });

  it("inserts a reference into a line, cites it as a subject, and changes its smart chip", () => {
    const fresh = lampProject();
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-woman", kind: "text", name: "Red-haired woman", description: "Dark red hair, green canvas jacket.", content: "Dark red hair, green canvas jacket.", intendedUse: ["character"], createdAt },
      { id: "ref-street", kind: "text", name: "City street", description: "Brick warehouses, wet cobbles.", content: "Brick warehouses, wet cobbles.", intendedUse: ["location"], createdAt },
    ];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], shots: [{ id: "shot-a", startSeconds: 0, action: "" }], referenceIds: [] }] });
    const onChange = vi.fn();
    const render1 = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const show = (next: ProjectConfig) => render1.rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const line = () => screen.getByRole("textbox", { name: "Describe shot 1" });
    openShot(1);

    // The picker says which references the scene already numbers.
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    expect(within(screen.getByRole("dialog", { name: "Insert a reference" })).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Red-haired womanNot in this scene yet · Text", "City streetNot in this scene yet · Text"]);
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    insertPromptReference("Red-haired woman");
    let next = onChange.mock.calls.at(-1)![0];
    // Writing it into the line is what binds it to the scene, which is what
    // gives it a subject number and a place in reference_paths.
    expect(next.generationJobs[0].referenceIds).toEqual(["ref-woman"]);
    show(next);

    typePrompt(line(), "@[ref:ref-woman] walks towards the camera on ");
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    placePromptCaret(line());
    insertPromptReference("City street");
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].referenceIds).toEqual(["ref-woman", "ref-street"]);
    show(next);

    // What the user reads in the field is each reference's name, on a chip;
    // what is stored is its id, so a rename or a reorder cannot re-point it.
    expect(promptChips(line())).toEqual(["Red-haired woman", "City street"]);
    expect(next.generationJobs[0].shots[0].action).toBe("@[ref:ref-woman] walks towards the camera on @[ref:ref-street]");
    openScene();
    openDebugPrompt();
    const compiled = () => document.querySelector(".compiled-prompt__text")!.textContent!;
    expect(compiled()).toContain("<Subject 1> walks towards the camera on <Subject 2>");
    expect(compiled()).not.toContain("@[ref:");
    // The citation is Slopus's format, not something the user typed.
    expect([...document.querySelectorAll(".prompt-part--frame")].map((part) => part.textContent)).toContain("<Subject 1>");
    expect(document.querySelector(".prompt-part--brief")!.textContent).not.toContain("<Subject");

    // Clicking the first reference in the line offers every other one.
    openShot(1);
    fireEvent.click(line().querySelectorAll(".prompt-chip")[0]);
    const picker = screen.getByRole("dialog", { name: "Change reference Red-haired woman" });
    expect(within(picker).getAllByRole("button").map((button) => button.textContent))
      .toEqual(["Red-haired womanReference 1 · Text", "City streetReference 2 · Text", "Remove from the prompt"]);
    fireEvent.click(within(picker).getByRole("button", { name: /^City street/ }));
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    expect(next.generationJobs[0].shots[0].action).toBe("@[ref:ref-street] walks towards the camera on @[ref:ref-street]");
    openScene();
    expect(compiled()).toContain("<Subject 1> walks towards the camera on <Subject 1>");
    expect(compiled()).not.toContain("Dark red hair");

    // A reference that can no longer be cited stays on its chip, marked.
    openShot(1);
    show({ ...next, references: next.references.filter((reference: { id: string }) => reference.id !== "ref-street") });
    expect(line().querySelector(".prompt-chip--missing")).toHaveTextContent("Deleted reference");
    expect(screen.getByText("A reference can’t be used")).toBeInTheDocument();
  });

  it("keeps a word off the citation wherever in the line it is inserted", () => {
    /* The caret has two sides and the insert used to look at one of them. At
       the START of a line there is nothing in front of the token, so nothing
       forced a space after it and the sentence compiled to
       "<Subject 1>walks towards the camera" — a malformed citation, sent to
       the model exactly as written. Between two words it was the same shape.
       At the very END there is no following word, and a trailing space would
       be litter, so that case must stay as it is. */
    const fresh = lampProject();
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-woman", kind: "text", name: "Red-haired woman", description: "Dark red hair.", content: "Dark red hair.", intendedUse: ["character"], createdAt },
    ];
    const start = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], shots: [{ id: "shot-a", startSeconds: 0, action: "walks towards the camera and stops." }], referenceIds: [] }] });

    /* Each case inserts the same reference at a different caret offset into the
       same untouched line, so the only variable is where it landed. */
    const insertAt = (caret: number): string => {
      let config = start;
      const onChange = vi.fn((next: ProjectConfig) => { config = parseProjectConfig(next); });
      const view = () => createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: start.generationJobs[0].id });
      const app = render(view());
      openShot(1);
      placePromptCaret(screen.getByRole("textbox", { name: "Describe shot 1" }), caret);
      insertPromptReference("Red-haired woman");
      app.unmount();
      return config.generationJobs[0].shots![0].action;
    };

    const line = "walks towards the camera and stops.";
    expect(insertAt(0)).toBe(`@[ref:ref-woman] ${line}`);
    expect(insertAt(line.length)).toBe(`${line} @[ref:ref-woman]`);
    /* Between two words, from either side of the space that separates them:
       one space each side, never two and never none. */
    expect(insertAt("walks towards ".length)).toBe("walks towards @[ref:ref-woman] the camera and stops.");
    expect(insertAt("walks towards".length)).toBe("walks towards @[ref:ref-woman] the camera and stops.");
  });


  it("writes a scene of three shots and two references, and compiles the prompt the engine gets", () => {
    /* The worked example, driven through the real screen rather than through
       the compiler: every value below is set with the control the user would
       use, and the assertion is on the panel that shows what is sent. */
    const fresh = createProjectConfig({ name: "Wet street", prompt: "walks towards the camera on ", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const createdAt = fresh.createdAt;
    const start = parseProjectConfig({
      ...fresh,
      references: [
        { id: "ref-woman", kind: "image", name: "Red-haired woman", description: "A woman in her thirties with dark red hair and a green canvas jacket.", relativePath: "references/woman.png", intendedUse: ["character"], createdAt },
        { id: "ref-street", kind: "image", name: "City street", description: "A narrow street of brick warehouses with wet cobbles and hanging cables.", relativePath: "references/street.png", intendedUse: ["location"], createdAt },
      ],
    });

    let config = start;
    const onChange = vi.fn((next: ProjectConfig) => { config = parseProjectConfig(next); });
    const view = () => createElement(GeneratorView, { config, folderPath: "C:\\Wet street", onChange, onOpenTimeline: () => undefined, selectedJobId: start.generationJobs[0].id });
    const app = render(view());
    const show = () => app.rerender(view());
    const set = (role: string, name: string, value: string) => {
      if (role === "combobox") chooseTag(name, value);
      else if (name.startsWith("Describe shot")) typePrompt(screen.getByRole(role, { name }), value);
      else fireEvent.change(screen.getByRole(role, { name }), { target: { value } });
      show();
    };
    const press = (name: string) => { fireEvent.click(screen.getByRole("button", { name })); show(); };
    /* Every control below belongs to one shot or to the scene, and the panel
       shows one of those at a time — so the test opens what it is about to set,
       exactly as the user would. */
    const shot = (shotNumber: number) => { openShot(shotNumber, "First scene"); show(); };
    const scene = () => { openScene("First scene"); show(); };
    const insertReference = (name: string, shotNumber: number) => {
      placePromptCaret(screen.getByRole("textbox", { name: `Describe shot ${shotNumber}` }));
      insertPromptReference(name);
      show();
    };

    set("slider", "First scene length in seconds", "12");
    press("Add a shot to First scene");
    press("Add a shot to First scene");

    // The street is inserted FIRST and the woman second, but the numbering
    // follows the project's reference order once both are bound — which is the
    // order reference_paths is built in, so <Subject 1> is <Picture 1>.
    shot(1);
    insertReference("City street", 1);
    insertReference("Red-haired woman", 1);
    set("textbox", "Describe shot 1", "@[ref:ref-woman] walks towards the camera on @[ref:ref-street]");
    shot(2);
    set("spinbutton", "Shot 2 starts at, in seconds", "4.5");
    set("textbox", "Describe shot 2", "she stops at a doorway and looks up");
    shot(3);
    set("spinbutton", "Shot 3 starts at, in seconds", "9");
    set("textbox", "Describe shot 3", "the door opens and light spills across @[ref:ref-street]");

    shot(1);
    set("combobox", "Add a setting to shot 1", "cameraMovement");
    set("combobox", "Value for Camera movement on shot 1", "push-in");
    set("combobox", "Add a setting to shot 1", "cameraSpeed");
    set("combobox", "Value for Movement speed on shot 1", "slow");
    shot(2);
    set("combobox", "Add a setting to shot 2", "shotSize");
    set("combobox", "Value for Shot size on shot 2", "medium-close-up");
    scene();
    set("combobox", "The look of this scene", "live-action-cinematic");
    set("textbox", "The sound of this scene", "Rain on cobbles, distant traffic, her boots on stone.");
    set("textbox", "The music of this scene", "Low sustained cello, slow tempo, swelling in the last two seconds.");

    // What the field shows is each name on a chip; what is stored is the id,
    // so a rename or a reorder cannot re-point the sentence.
    shot(1);
    expect(promptChips(screen.getByRole("textbox", { name: "Describe shot 1" }))).toEqual(["Red-haired woman", "City street"]);
    expect(config.generationJobs[0].shots![0].action).toBe("@[ref:ref-woman] walks towards the camera on @[ref:ref-street]");
    expect(config.generationJobs[0].durationSeconds).toBe(12);
    expect(config.generationJobs[0].shots!.map((item) => item.startSeconds)).toEqual([0, 4.5, 9]);

    scene();
    openDebugPrompt();
    const compiled = document.querySelector(".compiled-prompt__text")!.textContent!;
    // The panel IS the string that is sent — the parts concatenate to it.
    expect([...document.querySelectorAll(".compiled-prompt__text .prompt-part")].map((part) => part.textContent).join("")).toBe(compiled);
    expect(compiled).toBe([
      "subject_definitions:",
      "<Subject 1> is the content shown in <Picture 1>. A woman in her thirties with dark red hair and a green canvas jacket.",
      "<Subject 2> is the content shown in <Picture 2>. A narrow street of brick warehouses with wet cobbles and hanging cables.",
      "",
      "summary:",
      "[reference generation] <Subject 1> walks towards the camera on <Subject 2>. she stops at a doorway and looks up. the door opens and light spills across <Subject 2>. <Subject 1> and <Subject 2> provide generation guidance for the 3 shots described below.",
      "",
      "retention_analysis:",
      "<Subject 1> (appears in [Shot 1]): fully_preserved - the referenced characteristics are retained.",
      "<Subject 2> (appears in [Shot 1], [Shot 3]): fully_preserved - the referenced characteristics are retained.",
      "",
      "detailed_description:",
      "The target video is in a live-action, cinematic style.",
      "[Shot 1] <Subject 1> walks towards the camera on <Subject 2>. The shot features <Subject 1> and <Subject 2>, matching the definitions above. Camera movement: push in, slow speed.",
      // Shot 2 names nobody, so nothing claims it features anyone.
      "[Shot 2] At 00:04.500, Medium close-up, she stops at a doorway and looks up.",
      "[Shot 3] At 00:09.000, the door opens and light spills across <Subject 2>. The shot features <Subject 2>, matching the definitions above.",
      "",
      "overall_soundscape:",
      "Rain on cobbles, distant traffic, her boots on stone.",
      "",
      "non_diegetic_music:",
      "Low sustained cello, slow tempo, swelling in the last two seconds.",
    ].join("\n"));

    // Not one word of it is presented as the user's own except what they typed.
    expect([...document.querySelectorAll(".prompt-part--brief")].map((part) => part.textContent)).toEqual([
      "A woman in her thirties with dark red hair and a green canvas jacket.",
      "A narrow street of brick warehouses with wet cobbles and hanging cables.",
      " walks towards the camera on ",
      "she stops at a doorway and looks up",
      "the door opens and light spills across ",
      " walks towards the camera on ",
      "she stops at a doorway and looks up",
      "the door opens and light spills across ",
      "Rain on cobbles, distant traffic, her boots on stone.",
      "Low sustained cello, slow tempo, swelling in the last two seconds.",
    ]);
    expect([...document.querySelectorAll(".prompt-part--tag")].map((part) => part.textContent))
      .toEqual(["live-action, cinematic", "push in, slow speed", "Medium close-up"]);
    expect(parseProjectConfig(config)).toBeTruthy();

    // And the swap: the same sentence, pointed at the other reference.
    shot(1);
    changePromptChip(screen.getByRole("textbox", { name: "Describe shot 1" }), 0, "City street");
    show();
    scene();
    expect(document.querySelector(".compiled-prompt__text")!.textContent)
      .toContain("[Shot 1] <Subject 1> walks towards the camera on <Subject 1>.");
  });

  it("labels a cancelled scene as cancelled instead of queued, on the card and on its line", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "cancelled", stage: "failed" }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
    // The card's picture is the placeholder that says why there is no picture.
    expect(screen.getByRole("img", { name: "Shot 1 — Cancelled" })).not.toBeNull();
    expect(document.querySelector(".scene-rule__badge")?.textContent).toBe("Cancelled");
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(document.querySelector(".job-progress-block")).toBeNull();
    expect(screen.queryByText("Waiting in queue")).toBeNull();
  });
});
