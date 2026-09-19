import { WorkQueue } from "../lib/workQueue";
// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { createElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { compileMiniMaxH3Prompt, createProjectConfig, parseProjectConfig, sceneShots, STORY_TRACK_ID, UNTITLED_SCENE, type ProjectAsset, type ProjectConfig, type ProjectRecord, type TimelineClip } from "../lib/project";
import { saveGeneratedScene } from "../lib/generatedVideo";
import { formatDurationTimecode } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GeneratorView } from "./workspace/GeneratorView";
import { REFERENCE_DRAG_TYPE } from "./workspace/SceneEditor";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView } from "./workspace/TimelineView";
import { saveDebugOptionsEnabled } from "../lib/settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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

/** The same fake media stack as above, except that NOTHING settles on its own:
 *  each <video>/<audio> the panel opens waits here until the test lands it.
 *  That is what makes a staggered decode reproducible — two files finishing at
 *  their own speeds, with a render and a flush in between, which is the window
 *  the measurement race lives in and the reason a queue alone never closed it. */
async function withStagedDecoder(file: { seconds: number; width: number; height: number }, body: (stage: {
  /** Resolves once the panel has opened at least this many media elements. */
  opened: (count: number) => Promise<void>;
  /** Land one decode: metadata arrives, the poster seek answers, effects run. */
  settle: (index: number) => Promise<void>;
}) => Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(8));
  URL.createObjectURL = () => "blob:slopus-test";
  URL.revokeObjectURL = () => undefined;
  const media = HTMLMediaElement.prototype.load;
  const canvas = HTMLCanvasElement.prototype.getContext;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLCanvasElement.prototype.getContext = () => null;
  const create = document.createElement.bind(document);
  const waiting: HTMLElement[] = [];
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = create(tag, options);
    if (tag === "video" || tag === "audio") {
      for (const [name, value] of [["duration", file.seconds], ["videoWidth", file.width], ["videoHeight", file.height]] as const) {
        Object.defineProperty(element, name, { value, configurable: true });
      }
      let currentTime = 0;
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => { currentTime = value; setTimeout(() => element.dispatchEvent(new Event("seeked")), 0); },
      });
      waiting.push(element);
    }
    return element;
  });
  // One macrotask turn, with React's queues drained around it.
  const turn = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  try {
    await body({
      opened: async (count) => {
        for (let attempt = 0; attempt < 50 && waiting.length < count; attempt += 1) await turn();
        if (waiting.length < count) throw new Error(`Only ${waiting.length} of ${count} files were opened.`);
      },
      settle: async (index) => {
        const element = waiting[index];
        await act(async () => {
          element.dispatchEvent(new Event("loadeddata"));
          element.dispatchEvent(new Event("loadedmetadata"));
        });
        // The poster seek answers on a timer of its own, and the flush that
        // follows it is the write under test.
        await turn();
        await turn();
      },
    });
  } finally {
    spy.mockRestore();
    HTMLMediaElement.prototype.load = media;
    HTMLCanvasElement.prototype.getContext = canvas;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  }
}

describe("project workspace timecode", () => {
  it("formats project duration as valid hours, minutes, and seconds", () => {
    expect(formatDurationTimecode(0)).toBe("00:00:00");
    expect(formatDurationTimecode(59)).toBe("00:00:59");
    expect(formatDurationTimecode(60)).toBe("00:01:00");
    expect(formatDurationTimecode(600)).toBe("00:10:00");
  });

  it("opens a centered two-line Agent page from its first tab and moves the prompt down after submit", async () => {
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

    const navigation = screen.getByRole("navigation", { name: "Project views" });
    expect(within(navigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "Agent", "Timeline", "Generator", "References",
    ]);
    const field = screen.getByRole("textbox", { name: "Ask Slop about the edit" });
    expect(field.getAttribute("rows")).toBe("1");
    expect(screen.queryByRole("combobox", { name: "Agent provider" })).toBeNull();
    expect(screen.getByRole("img", { name: "Codex status: Ready" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Slop output/ })).toBeNull();

    fireEvent.click(within(navigation).getByRole("button", { name: "Agent" }));
    expect(within(navigation).getByRole("button", { name: "Agent" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "What should we create today?" })).not.toBeNull();
    expect(screen.queryByText("No activity yet. Send a prompt to start.")).toBeNull();
    expect(document.querySelector(".agent-dock-wrap--welcome")).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Ask Slop about this project" }).getAttribute("rows")).toBe("2");
    expect(screen.getByRole("combobox", { name: "Agent provider" }).textContent).toBe("Codex");
    expect(screen.getByRole("combobox", { name: "Agent provider" }).closest(".agent-dock__actions")).not.toBeNull();
    expect(document.querySelector(".project-agent-row--page")).not.toBeNull();

    fireEvent.click(within(navigation).getByRole("button", { name: "Timeline" }));
    const compactField = screen.getByRole("textbox", { name: "Ask Slop about the edit" });
    fireEvent.change(compactField, { target: { value: "Review this project" } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
    await waitFor(() => expect(within(navigation).getByRole("button", { name: "Agent" }).getAttribute("aria-current")).toBe("page"));
    expect(document.querySelector(".agent-dock-wrap--welcome")).toBeNull();
  });

  it("surfaces native save failures in the workspace", async () => {
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Portable Launch Film", config: parseProjectConfig(completeFixture) },
      onBack: () => undefined,
      onSave: async () => { throw new Error("The original project file is locked."); },
    }));
    // Save is the only save state left in the topbar — the standing "All
    // changes saved" pill is gone — so it is off until there is something to
    // write. Make an edit first, or the click lands on a disabled button.
    fireEvent.change(screen.getAllByTitle("Rename this track")[0], { target: { value: "Opening shots" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t save project");
    expect(alert.textContent).toContain("The original project file is locked.");
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
    fireEvent.click(screen.getByRole("button", { name: "Add or generate a scene" }));
    await screen.findByRole("heading", { name: "Generator" });
    // A new project already carries one draft made from the user's own words.
    // "Add or generate a scene" must open that, not stack a second near-identical
    // shot the user has no way to tell apart.
    expect(screen.getByRole("heading", { name: "First scene" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "New scene draft" })).toBeNull();
    expect(screen.queryByText("DRAFT")).toBeNull();
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

  /* jsdom has no DataTransfer, and the drop handler reads a custom type off it,
     so the drag has to carry its own. Same contract as the browser's: setData
     during dragstart, types visible during dragover, getData on drop. */
  function fakeDataTransfer() {
    const data: Record<string, string> = {};
    return {
      dropEffect: "none", effectAllowed: "all",
      types: [] as string[],
      setData(type: string, value: string) { data[type] = value; this.types.push(type); },
      getData(type: string) { return data[type] ?? ""; },
    };
  }

  /** What a view actually wrote. The timeline hands up UPDATERS rather than
   *  finished configs (see ConfigUpdate), so reading a call means applying it
   *  to the config the view was holding at the time. */
  const wrote = (call: unknown, current: ProjectConfig): ProjectConfig =>
    typeof call === "function" ? (call as (value: ProjectConfig) => ProjectConfig)(current) : call as ProjectConfig;

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

  /** The lane for the first track of this kind, and the card for that asset. */
  const laneAt = (container: HTMLElement, index: number) => container.querySelectorAll(".track-lane")[index];
  const cardFor = (asset: ProjectAsset) => screen.getByTitle(new RegExp(`^${asset.name} —`));

  function mediaPanel(config: ProjectConfig, onChange = vi.fn()) {
    const view = render(createElement(TimelineView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    return { ...view, onChange };
  }

  it("switches the media panel between grid and list, and remembers which", () => {
    localStorage.removeItem("slopus.media-layout.v1");
    const { container } = mediaPanel(projectWithMedia());
    expect(container.querySelector(".media-grid--grid")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(container.querySelector(".media-grid--list")).not.toBeNull();
    expect(container.querySelector(".media-grid--grid")).toBeNull();
    // The choice is a habit, not a per-project setting: it outlives the mount.
    cleanup();
    const second = mediaPanel(projectWithMedia());
    expect(second.container.querySelector(".media-grid--list")).not.toBeNull();
  });

  it("keeps imported media in Media and lists Generator scenes even before generation", () => {
    const base = projectWithMedia();
    const config = parseProjectConfig({ ...base, timeline: { tracks: base.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips: [{
      id: "clip-macro", assetId: "asset-macro", trackId: track.id, startMs: 0, durationMs: 5000, sourceStartMs: 0, label: "Macro footage", color: null, status: "approved",
    }] } : track) } });
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenGenerator: () => undefined }));

    expect(container.querySelector(".scene-list")!.textContent).toContain("First scene");
    expect(container.querySelector(".scene-list")!.textContent).not.toContain("Macro footage");
    expect(container.querySelector(".scene-list")!.textContent).not.toContain("Not rendered yet");
    expect(container.querySelector(".scene-card__thumb")).not.toBeNull();
    expect(container.querySelector(".scene-card__thumb .shot-thumb")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Generator scenes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    const media = container.querySelector(".media-grid")! as HTMLElement;
    expect(screen.queryByRole("heading", { name: "Project media" })).toBeNull();
    expect(screen.getByRole("button", { name: "Import" })).not.toBeNull();
    expect(media.querySelector(".media-import")).toBeNull();
    expect(within(media).getByText("Macro footage")).not.toBeNull();
    expect(within(media).getByText("Room tone")).not.toBeNull();
  });

  it("keeps the Import label while an import is in progress", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    let finish!: () => void;
    const pending = new Promise<unknown[]>((resolve) => { finish = () => resolve([]); });
    vi.mocked(invoke).mockReturnValue(pending as never);
    try {
      mediaPanel(projectWithMedia());
      const button = screen.getByRole("button", { name: "Import" });
      fireEvent.click(button);
      expect(button.textContent).toContain("Import");
      expect(button.textContent).not.toContain("Importing");
      expect(button).toHaveProperty("disabled", true);
      await act(async () => { finish(); await pending; });
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.mocked(invoke).mockReset();
    }
  });

  it("shows audio-only waveforms without restoring clip name panels", () => {
    const base = projectWithMedia();
    const config = parseProjectConfig({
      ...base,
      assets: base.assets.map((asset) => asset.kind === "video" ? { ...asset, hasAudio: true } : asset),
      timeline: { tracks: base.timeline.tracks.map((track, index) => ({
        ...track,
        clips: index === 0 ? [{
          id: "clip-video", assetId: "asset-macro", trackId: track.id, startMs: 0, durationMs: 5_000,
          sourceStartMs: 0, label: "Macro footage", color: null, status: "approved" as const,
        }] : index === 1 ? [{
          id: "clip-audio", assetId: "asset-room", trackId: track.id, startMs: 0, durationMs: 5_000,
          sourceStartMs: 0, label: "Room tone", color: null, status: "approved" as const,
        }] : [],
      })) },
    });
    const onChange = vi.fn();
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));

    expect(container.querySelectorAll(".clip-audio-visualization")).toHaveLength(2);
    expect(container.querySelector(".clip-audio-visualization__center")).toBeNull();
    expect(container.querySelector(".clip-audio-visualization__envelope")).toBeNull();
    expect(container.querySelector("polyline")).toBeNull();
    expect(container.querySelector(".clip-audio-visualization i")).toBeNull();
    expect(container.querySelectorAll(".timeline-clip--audio-only")).toHaveLength(1);
    expect(container.querySelector(".clip-text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Mute audio on Track 1" }));
    expect(wrote(onChange.mock.calls[0][0], config).timeline.tracks[0].muted).toBe(true);
  });

  it("shows the waveform below thumbnails for generated files from older projects", () => {
    const base = createProjectConfig({ name: "Older render", prompt: "A harbour", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 10 });
    const job = {
      ...base.generationJobs[0], status: "ready" as const, stage: "completed" as const, progress: 1,
      outputRelativePath: "media/generated/job-initial-brief.mp4",
    };
    const assetId = "asset-job-initial-brief";
    const config = parseProjectConfig({
      ...base,
      generationJobs: [job],
      assets: [{
        id: assetId, kind: "generated", name: job.title, relativePath: job.outputRelativePath,
        mimeType: "video/mp4", durationMs: 10_000, width: 1920, height: 1080, createdAt: base.createdAt,
      }],
      timeline: { tracks: base.timeline.tracks.map((track, index) => ({
        ...track,
        clips: index === 0 ? [{
          id: "clip-old", assetId, trackId: track.id, startMs: 0, durationMs: 10_000,
          sourceStartMs: 0, label: job.title, color: null, status: "generated" as const,
        }] : [],
      })) },
    });
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Older render", onChange: () => undefined, onOpenGenerator: () => undefined }));
    const clip = container.querySelector(".timeline-clip--has-audio");
    expect(clip?.querySelector(".clip-audio-visualization")).not.toBeNull();
  });

  it("removes project media and every timeline use of it", () => {
    const base = projectWithMedia();
    const config = parseProjectConfig({
      ...base,
      timeline: { tracks: base.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips: [{
        id: "clip-macro-a", assetId: "asset-macro", trackId: track.id, startMs: 0, durationMs: 2_000, sourceStartMs: 0, label: "Macro A", color: null, status: "approved",
      }, {
        id: "clip-macro-b", assetId: "asset-macro", trackId: track.id, startMs: 3_000, durationMs: 2_000, sourceStartMs: 2_000, label: "Macro B", color: null, status: "approved",
      }] } : track) },
    });
    const { onChange } = mediaPanel(config);

    fireEvent.click(screen.getByRole("button", { name: "Remove Macro footage from project" }));
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.assets.map((asset) => asset.id)).toEqual(["asset-room"]);
    expect(next.timeline.tracks.flatMap((track) => track.clips).some((clip) => clip.assetId === "asset-macro")).toBe(false);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("drops an ungenerated Generator scene onto an audiovisual track as a valid draft clip", () => {
    const config = projectWithMedia();
    const onChange = vi.fn();
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    const scene = screen.getByTitle(/^First scene — drag onto a track/);
    const dataTransfer = fakeDataTransfer();

    fireEvent.dragStart(scene, { dataTransfer });
    fireEvent.drop(laneAt(container, 1), { dataTransfer });
    const next = wrote(onChange.mock.calls[0][0], config);
    const generatedAsset = next.assets.find((asset) => asset.id === "asset-job-initial-brief")!;
    const clip = next.timeline.tracks.flatMap((track) => track.clips).find((item) => item.assetId === generatedAsset.id)!;
    expect(generatedAsset.kind).toBe("generated");
    expect(generatedAsset.relativePath ?? null).toBeNull();
    expect(clip.status).toBe("draft");
    expect(clip.label).toBe("First scene");
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("drops a video onto any audiovisual track", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange } = mediaPanel(config);
    const card = screen.getByTitle(new RegExp(`^${video.name} —`));
    const lane = laneAt(container, 1);

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(lane, { dataTransfer });
    fireEvent.drop(lane, { dataTransfer });
    const next = wrote(onChange.mock.calls[0][0], config);
    const track = next.timeline.tracks[1];
    const dropped = track.clips.find((clip) => clip.assetId === video.id)!;
    expect(dropped.label).toBe(video.name);
    // A zero-width lane in jsdom must still yield a real start time, not NaN.
    expect(Number.isFinite(dropped.startMs)).toBe(true);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("drops an audio-only file onto an audiovisual track", () => {
    const config = projectWithMedia();
    const sound = config.assets[1];
    const { container, onChange } = mediaPanel(config);

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(sound), { dataTransfer });
    // Video and audio are separated in BOTH directions. The video test beside
    // this one only proved the video half; a sound landing on a video track
    // makes a clip with a picture track and no picture.
    fireEvent.drop(laneAt(container, 2), { dataTransfer });
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.timeline.tracks[2].clips.map((clip) => clip.assetId)).toEqual([sound.id]);
    expect(container.querySelectorAll(".track-lane")).toHaveLength(3);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("lands the dropped clip under the pointer and selects it", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange, rerender } = mediaPanel(config);
    const lane = laneAt(container, 0) as HTMLElement;
    // jsdom lays nothing out, so the lane has to be told how wide it is — the
    // drop reads exactly this to turn a pointer position into a start time.
    lane.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, right: 1100, bottom: 72, height: 72, x: 100, y: 0, toJSON: () => ({}) });

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(video), { dataTransfer });
    // jsdom has no DragEvent, so fireEvent builds a plain Event and drops any
    // pointer coordinates on the floor. The drop reads clientX, so put it back.
    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: 350 });
    fireEvent(lane, drop);

    const next = wrote(onChange.mock.calls[0][0], config);
    const dropped = next.timeline.tracks.flatMap((track) => track.clips)[0];
    // A quarter of the way along a 30-second canvas, not pinned to zero.
    expect(dropped.startMs).toBe(Math.round(0.25 * 30_000));
    expect(parseProjectConfig(next)).toBeTruthy();

    // Dropping something and then having to find it again is a fair definition
    // of a broken drop, so the new clip arrives selected.
    rerender(createElement(TimelineView, { config: next, folderPath: "C:\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    const clip = container.querySelector(".timeline-clip.selected");
    expect(clip).not.toBeNull();
    expect(clip!.getAttribute("title")).toContain(video.name);
  });

  it("marks a locked lane as unavailable while media is being dragged", () => {
    const base = projectWithMedia();
    const config = {
      ...base,
      timeline: { tracks: base.timeline.tracks.map((track, index) => index === 1 ? { ...track, locked: true } : track) },
    };
    const { container } = mediaPanel(config);
    const rejected = () => Array.from(container.querySelectorAll(".track-lane--reject"));

    expect(rejected()).toHaveLength(0);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(config.assets[1]), { dataTransfer });
    // Every video track, for the whole drag — not only the one under the
    // pointer. A dark lane on its own says nothing the user can act on.
    expect(rejected()).toHaveLength(1);
    fireEvent.dragEnd(cardFor(config.assets[1]));
    expect(rejected()).toHaveLength(0);
  });

  /** The same project with its video asset already measured, as the media panel
   *  measures it the first time it decodes the file for a thumbnail. */
  const measuredVideo = (config: ProjectConfig, durationMs: number) => parseProjectConfig({
    ...config,
    assets: config.assets.map((asset) => asset.kind === "video" ? { ...asset, durationMs, width: 1920, height: 1080 } : asset),
  });

  /** That project with one clip of the video already cut into the story track. */
  const withClip = (config: ProjectConfig, clip: Partial<TimelineClip>) => parseProjectConfig({
    ...config,
    timeline: { tracks: config.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips: [{
      id: "clip-macro", assetId: config.assets[0].id, trackId: STORY_TRACK_ID,
      startMs: 0, durationMs: 40_000, sourceStartMs: 0, label: "Macro footage", color: null, status: "approved", ...clip,
    }] } : track) },
  });

  const droppedClip = (calls: { mock: { calls: unknown[][] } }, current: ProjectConfig) =>
    wrote(calls.mock.calls[0][0], current).timeline.tracks.flatMap((track) => track.clips)[0];

  it("drops a clip as long as the footage, and falls back to the stated default only when nothing measured it", () => {
    /* B3: every dropped clip used to be five seconds, forever — a 40-second
       rush included, with no way anywhere in the app to change it. */
    const known = measuredVideo(projectWithMedia(), 40_000);
    const first = mediaPanel(known);
    const transfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(known.assets[0]), { dataTransfer: transfer });
    fireEvent.drop(laneAt(first.container, 0), { dataTransfer: transfer });
    expect(droppedClip(first.onChange, known).durationMs).toBe(40_000);
    expect(wrote(first.onChange.mock.calls[0][0], known).brief.targetDurationSeconds).toBe(40);
    expect(parseProjectConfig(wrote(first.onChange.mock.calls[0][0], known))).toBeTruthy();
    cleanup();

    // Nothing has decoded this one, so there is no length to honour and the
    // documented stand-in is what lands.
    const unknown = projectWithMedia();
    const second = mediaPanel(unknown);
    const transferTwo = fakeDataTransfer();
    fireEvent.dragStart(cardFor(unknown.assets[0]), { dataTransfer: transferTwo });
    fireEvent.drop(laneAt(second.container, 0), { dataTransfer: transferTwo });
    expect(droppedClip(second.onChange, unknown).durationMs).toBe(5_000);
  });

  it("keeps a long drop at the requested position and grows the saved project beyond ten minutes", () => {
    const config = measuredVideo(projectWithMedia(), 700_000);
    const view = mediaPanel(config);
    const lane = laneAt(view.container, 0) as HTMLElement;
    lane.getBoundingClientRect = () => ({ left: 100, width: 1000 } as DOMRect);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(config.assets[0]), { dataTransfer });
    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: 1100 });
    fireEvent(lane, drop);
    const next = wrote(view.onChange.mock.calls[0][0], config);
    expect(next.timeline.tracks.flatMap((track) => track.clips)[0]).toMatchObject({ startMs: 30_000, durationMs: 700_000 });
    expect(next.brief.targetDurationSeconds).toBe(730);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("uses an editable clip name as the inspector heading", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), {});
    const onChange = vi.fn();
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));

    expect(container.querySelector(".clip-inspector")).not.toBeNull();
    expect(screen.queryByText("Clip details")).toBeNull();
    expect(container.querySelector(".inspector-summary")).toBeNull();
    const heading = screen.getByRole("heading", { name: "Macro footage" });
    const name = within(heading).getByRole("textbox", { name: "Clip name" });
    expect((name as HTMLInputElement).value).toBe("Macro footage");
    expect(screen.queryByRole("heading", { name: "Clip" })).toBeNull();

    fireEvent.change(screen.getByTitle(/^How long this clip lasts/), { target: { value: "8" } });
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.timeline.tracks.flatMap((track) => track.clips)[0].durationMs).toBe(8_000);
    fireEvent.change(name, { target: { value: "Opening detail" } });
    expect(wrote(onChange.mock.calls.at(-1)![0], config).timeline.tracks.flatMap((track) => track.clips)[0].label).toBe("Opening detail");
    fireEvent.change(name, { target: { value: "" } });
    expect(wrote(onChange.mock.calls.at(-1)![0], config).timeline.tracks.flatMap((track) => track.clips)[0].label).toBe("Untitled clip");
  });

  /* --- Dragging clips on the timeline --------------------------------------

     jsdom lays nothing out and has no PointerEvent, so both are supplied here:
     the lane is told how wide it is (a drag turns pixels into milliseconds
     against exactly this), and each gesture is a bubbling event carrying the
     coordinates the handlers read. 1000px over a 30-second canvas makes the
     arithmetic legible: 1px is 30ms, and the 8px magnet is 240ms.
     ======================================================================= */

  const LANE_WIDTH = 1000;
  const LANE_RECT = { left: 0, width: LANE_WIDTH, top: 0, right: LANE_WIDTH, bottom: 72, height: 72, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

  function pointerEvent(type: string, clientX: number, clientY = 40) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ clientX, clientY, button: 0, pointerId: 1 })) {
      Object.defineProperty(event, key, { value });
    }
    return event;
  }

  /** A project with clips cut into one of its tracks. */
  const withClips = (config: ProjectConfig, clips: Partial<TimelineClip>[], trackId = STORY_TRACK_ID) => parseProjectConfig({
    ...config,
    timeline: { tracks: config.timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: clips.map((clip, index) => ({
      id: `clip-${index}`, assetId: config.assets[0].id, trackId,
      startMs: 0, durationMs: 4_000, sourceStartMs: 0, label: `Shot ${index + 1}`, color: null, status: "approved", ...clip,
    })) } : track) },
  });

  /** Renders the timeline with every lane measured, and hands back what a drag
   *  needs: the lanes, the clips, and whatever was written. */
  function timeline(config: ProjectConfig) {
    const onChange = vi.fn();
    const view = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    for (const lane of view.container.querySelectorAll(".track-lane")) lane.getBoundingClientRect = () => LANE_RECT;
    const laneOf = (trackId: string) => view.container.querySelector(`[data-track-id="${trackId}"]`) as HTMLElement;
    const written = () => onChange.mock.calls.length ? wrote(onChange.mock.calls.at(-1)![0], config) : undefined;
    const clipsOn = (trackId: string) => written()?.timeline.tracks.find((track) => track.id === trackId)?.clips ?? [];
    return { ...view, onChange, laneOf, written, clipsOn };
  }

  /** One whole gesture: press on `grip`, move to `toX`, release. */
  function drag(grip: Element, fromX: number, toX: number, clientY = 40) {
    fireEvent(grip, pointerEvent("pointerdown", fromX, clientY));
    fireEvent(window, pointerEvent("pointermove", toX, clientY));
    fireEvent(window, pointerEvent("pointerup", toX, clientY));
  }

  /** Which lane the pointer is over. jsdom cannot hit-test, so this is the one
   *  thing about a cross-lane drag a test has to supply. */
  const overLane = (lane: HTMLElement) => {
    (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [lane];
  };
  const stopHitTesting = () => { delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint; };

  it("drags a clip along its own lane and writes where it landed", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 2_000, durationMs: 4_000 }]);
    const view = timeline(config);
    // Taken hold of 1s into the clip and dropped 6s further along: the clip
    // moves by what the POINTER moved, rather than jumping its head under it.
    drag(view.container.querySelector(".timeline-clip")!, 100, 300);
    expect(view.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 8_000, durationMs: 4_000 });
    expect(parseProjectConfig(view.written()!)).toBeTruthy();
  });

  it("drags a clip onto another audiovisual track", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }]);
    const view = timeline(config);
    overLane(view.laneOf("track-v2"));
    drag(view.container.querySelector(".timeline-clip")!, 20, 220);
    expect(view.clipsOn(STORY_TRACK_ID)).toHaveLength(0);
    expect(view.clipsOn("track-v2")[0]).toMatchObject({ startMs: 6_000, trackId: "track-v2" });
    expect(parseProjectConfig(view.written()!)).toBeTruthy();

    stopHitTesting();
  });

  it("extends the project when an existing clip is dragged past its end", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }]);
    const view = timeline(config);
    drag(view.container.querySelector(".timeline-clip")!, 20, 1220);
    const moved = view.clipsOn(STORY_TRACK_ID)[0];
    expect(moved.startMs).toBe(36_000);
    expect(view.written()!.brief.targetDurationSeconds).toBe(40);
    expect(parseProjectConfig(view.written()!)).toBeTruthy();
  });

  it("moves audio-only media from one audiovisual track to another", () => {
    const measured = parseProjectConfig({
      ...projectWithMedia(),
      assets: projectWithMedia().assets.map((asset) => asset.kind === "audio" ? { ...asset, durationMs: 20_000 } : asset),
    });
    const config = withClips(measured, [{ startMs: 0, durationMs: 6_000, assetId: "asset-room", label: "Room tone" }], "track-v2");
    const view = timeline(config);
    overLane(view.laneOf("track-v3"));
    drag(view.container.querySelector(".timeline-clip")!, 10, 110);
    expect(view.clipsOn("track-v2")).toHaveLength(0);
    expect(view.clipsOn("track-v3")[0]).toMatchObject({ startMs: 3_000, trackId: "track-v3" });
    stopHitTesting();
  });

  it("will not lay one clip over another", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [
      { startMs: 0, durationMs: 4_000 },
      { startMs: 12_000, durationMs: 4_000 },
    ]);
    const view = timeline(config);
    // Dragged from 12s back to 1s, right on top of the first clip: it lands
    // flush against the side it was nearer to, and nothing overlaps.
    drag(view.container.querySelectorAll(".timeline-clip")[1], 400, 33);
    expect(view.clipsOn(STORY_TRACK_ID).map((clip) => [clip.startMs, clip.durationMs])).toEqual([[0, 4_000], [4_000, 4_000]]);
    expect(parseProjectConfig(view.written()!)).toBeTruthy();
  });

  it("snaps a dragged clip to the cut beside it", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [
      { startMs: 0, durationMs: 4_000 },
      { startMs: 20_000, durationMs: 4_000 },
    ]);
    const view = timeline(config);
    /* Dropped with its head 150ms past the first clip's tail — inside the 240ms
       magnet, so the gap closes completely rather than leaving a hole too small
       to see and too real for the encoder to ignore. */
    drag(view.container.querySelectorAll(".timeline-clip")[1], 667, 138);
    expect(view.clipsOn(STORY_TRACK_ID)[1].startMs).toBe(4_000);
  });

  it("trims the tail by dragging the right edge, and never past the footage", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 6_000, sourceStartMs: 1_000 }]);
    const view = timeline(config);
    drag(view.container.querySelector(".clip-handle--end")!, 200, 100);
    // Only the length changes: the head of the clip and the point it starts
    // inside the file are not what the right-hand edge is holding.
    expect(view.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 0, durationMs: 3_000, sourceStartMs: 1_000 });

    // The file is 40s long and this clip starts 1s into it, so 39s is all the
    // tail there is, however far the pointer goes.
    cleanup();
    const second = timeline(config);
    drag(second.container.querySelector(".clip-handle--end")!, 200, 1_600);
    expect(second.clipsOn(STORY_TRACK_ID)[0].durationMs).toBe(39_000);
  });

  it("trims the head by dragging the left edge, moving the cut and the source together", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 4_000, durationMs: 6_000, sourceStartMs: 2_000 }]);
    const view = timeline(config);
    drag(view.container.querySelector(".clip-handle--start")!, 133, 250);
    // Three and a half seconds later on the ruler is three and a half seconds
    // later in the footage.
    expect(view.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 7_500, durationMs: 2_500, sourceStartMs: 5_500 });

    // Pulled the other way it stops where the file's own head is: only 2s of
    // footage exists before this clip's first frame.
    cleanup();
    const second = timeline(config);
    drag(second.container.querySelector(".clip-handle--start")!, 133, 0);
    expect(second.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 2_000, durationMs: 8_000, sourceStartMs: 0 });
  });

  it("abandons a drag on Escape and writes nothing", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 2_000, durationMs: 4_000 }]);
    const view = timeline(config);
    fireEvent(view.container.querySelector(".timeline-clip")!, pointerEvent("pointerdown", 100));
    fireEvent(window, pointerEvent("pointermove", 400));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent(window, pointerEvent("pointerup", 400));
    expect(view.onChange).not.toHaveBeenCalled();
  });

  it("refuses to drag or trim anything on a locked track", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 2_000, durationMs: 4_000 }]);
    const locked = parseProjectConfig({ ...config, timeline: { tracks: config.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, locked: true } : track) } });
    const view = timeline(locked);
    drag(view.container.querySelector(".timeline-clip")!, 100, 400);
    expect(view.onChange).not.toHaveBeenCalled();
    // The handles are not merely inert, they are absent: a control that cannot
    // do anything is worse than no control at all.
    expect(view.container.querySelector(".clip-handle")).toBeNull();
    expect(view.container.querySelector(".clip-delete")).toBeNull();
  });

  it("removes a clip from its track with the control on the clip itself", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [
      { startMs: 0, durationMs: 4_000, label: "Opening" },
      { startMs: 8_000, durationMs: 4_000, label: "Closing" },
    ]);
    const view = timeline(config);
    fireEvent.click(screen.getByRole("button", { name: "Delete Opening" }));
    expect(view.clipsOn(STORY_TRACK_ID).map((clip) => clip.label)).toEqual(["Closing"]);
    expect(parseProjectConfig(view.written()!)).toBeTruthy();
  });

  it("keeps a clip's place in the source when it is duplicated", () => {
    // Otherwise every copy replays the head of the file, which is the same five
    // seconds the original already showed.
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), { startMs: 0, durationMs: 6_000, sourceStartMs: 12_000 });
    const onChange = vi.fn();
    render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const next = wrote(onChange.mock.calls[0][0], config);
    const clips = next.timeline.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    const copy = clips.find((clip) => clip.id !== "clip-macro")!;
    expect(copy.sourceStartMs).toBe(12_000);
    expect(copy.durationMs).toBe(6_000);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("records the length the media panel actually measured onto the asset", async () => {
    /* Held in state and fed back in, exactly as ProjectWorkspace holds it: two
       files are measured here, and each measurement has to survive the other. */
    const seen: ProjectConfig[] = [];
    function Harness({ initial }: { initial: ProjectConfig }) {
      const [config, setConfig] = useState(initial);
      useEffect(() => { seen.push(config); }, [config]);
      return createElement(TimelineView, { config, folderPath: "C:\\Measured Project", onChange: setConfig, onOpenGenerator: () => undefined });
    }
    await withFakeDecoder({ seconds: 40, width: 1920, height: 1080 }, async () => {
      render(createElement(Harness, { initial: projectWithMedia() }));
      fireEvent.click(screen.getByRole("button", { name: "Media" }));
      await waitFor(() => expect(seen.at(-1)!.assets.every((asset) => asset.durationMs !== null)).toBe(true), { timeout: 8_000 });
    });
    const final = seen.at(-1)!;
    const video = final.assets.find((asset) => asset.kind === "video")!;
    expect(video.durationMs).toBe(40_000);
    expect(video.width).toBe(1920);
    expect(video.height).toBe(1080);
    // Sound has no picture but it does have a length, and the timeline needs it.
    expect(final.assets.find((asset) => asset.kind === "audio")!.durationMs).toBe(40_000);
    expect(parseProjectConfig(final)).toBeTruthy();
    // Measuring is not editing: once every file is known, it stops writing.
    const settled = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.length).toBe(settled);
    // Longer than the wait above: a decode that never finishes has to fail this
    // test on its assertion, not by timing the test out before its cleanup runs.
  }, 20_000);

  it("keeps a measurement that lands before the one before it has come back down", async () => {
    /* The race the queue never covered. Two files finish decoding one after the
       other; each finish flushes. The flush used to rebuild the whole config
       from the `config` prop of the render it ran in, so the second flush —
       running before the first write had returned as a new prop — rebuilt from
       the config that still knew nothing and dropped the first measurement.
       Here the holder deliberately never feeds anything back, which is that
       window at its widest, and both measurements still have to survive. */
    const config = projectWithMedia();
    const onChange = vi.fn();
    await withStagedDecoder({ seconds: 40, width: 1920, height: 1080 }, async (stage) => {
      render(createElement(TimelineView, { config, folderPath: "C:\\Staged Project", onChange, onOpenGenerator: () => undefined }));
      fireEvent.click(screen.getByRole("button", { name: "Media" }));
      await stage.opened(2);
      await stage.settle(0);
      await stage.settle(1);
    });
    // Two files, two separate writes: one write for both would mean the second
    // decode never landed and the test is proving nothing.
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    /* Fold every write onto the config the view was given, in the order it
       asked for them — which is all a holder does with them. A write that
       carries a whole config replaces what came before it; an updater is
       applied to it. */
    const folded = onChange.mock.calls.reduce(
      (current: ProjectConfig, call) => typeof call[0] === "function" ? (call[0] as (value: ProjectConfig) => ProjectConfig)(current) : call[0] as ProjectConfig,
      config,
    );
    expect(folded.assets.map((asset) => [asset.name, asset.durationMs])).toEqual([["Macro footage", 40_000], ["Room tone", 40_000]]);
    expect(folded.assets.find((asset) => asset.kind === "video")!.width).toBe(1920);
    expect(parseProjectConfig(folded)).toBeTruthy();
  }, 20_000);

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
      expect(save().title).toBe("Everything is already saved");

      fireEvent.click(screen.getByRole("button", { name: "Media" }));
      // The panel prints the length it read, so this waits on the measurement
      // itself rather than on a guess at how long a decode takes.
      await waitFor(() => expect(screen.getAllByText(/40\.0s/).length).toBe(2), { timeout: 8_000 });
      expect(save().disabled).toBe(true);
      expect(save().title).toBe("Everything is already saved");

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

  it("keeps the transport on the timeline, with one timecode and one reason", () => {
    const empty = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container, rerender } = render(createElement(TimelineView, { config: empty, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenGenerator: () => undefined }));

    // It sits in the timeline toolbar now, not under the program monitor.
    expect(container.querySelector(".monitor-transport")).toBeNull();
    expect(container.querySelector(".timeline-toolbar .timeline-transport")).not.toBeNull();
    /* The transport is the three controls and NOTHING else. The clock and the
       format used to ride inside it, which pushed the buttons off to one side
       of whatever the cluster happened to measure — and the cluster has to be
       centred on the picture above it, which only works if its own contents are
       symmetrical. They live beside the heading now instead; jsdom lays nothing
       out, so what is pinned here is the arrangement the CSS centres, and the
       measured geometry is recorded against --video-centre-shift. */
    expect(Array.from(container.querySelectorAll(".timeline-transport > *")).map((el) => el.getAttribute("aria-label")))
      .toEqual(["Go to beginning", "Play", "Step forward one second"]);
    const lead = container.querySelector(".timeline-toolbar__lead")!;
    expect(lead.querySelector("h2")!.textContent).toBe("Timeline");
    expect(lead.querySelector(".transport-time")).not.toBeNull();
    expect(lead.querySelector(".transport-format")).not.toBeNull();
    // Reading order left to right: what this panel is, where it stands, what it
    // is. The heading has to come first or the clock is a label on nothing.
    expect(Array.from(lead.children).map((el) => el.tagName)).toEqual(["H2", "STRONG", "SPAN"]);
    // the playhead time is printed once. The toolbar used to print it beside
    // the heading while the monitor printed it again, which reads as two clocks.
    expect(container.textContent!.match(/\d\d:\d\d:\d\d:\d\d/g)).toHaveLength(1);
    // Pixels, not the id: "1080p" names one edge and leaves the other a guess.
    expect(container.querySelector(".transport-format")!.textContent).toBe("1920 × 1080 · 24 fps");

    // An empty timeline has nothing to play, and every control says so rather
    // than only going grey.
    for (const label of ["Go to beginning", "Play", "Step forward one second"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled, label).toBe(true);
      expect(button.title, label).toBe("Nothing to play yet — add or generate a scene first.");
    }

    // With a clip on the timeline they come alive, and Space still plays.
    const config = parseProjectConfig(completeFixture);
    rerender(createElement(TimelineView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenGenerator: () => undefined }));
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(container.querySelector(".timeline-view")!, { code: "Space" });
    expect(screen.getByRole("button", { name: "Pause" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).not.toBeNull();
  });

  it("does not delete a selected clip from a locked track", () => {
    const config = parseProjectConfig(completeFixture);
    const firstTrackWithClip = config.timeline.tracks.find((track) => track.clips.length > 0)!;
    const locked = { ...config, timeline: { tracks: config.timeline.tracks.map((track) => track.id === firstTrackWithClip.id ? { ...track, locked: true } : track) } };
    const onChange = vi.fn();
    const { container } = render(createElement(TimelineView, { config: locked, folderPath: "C:\Locked Project", onChange, onOpenGenerator: () => undefined }));
    const timeline = container.querySelector(".timeline-view")!;
    fireEvent.keyDown(timeline, { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
    // Still disabled — and now it says why, rather than keeping the enabled
    // wording while being unclickable.
    const deleteButton = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toBe("This clip’s track is locked");
  });

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
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(document.querySelector(".debug-prompt-dialog .compiled-prompt__text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Debug Prompt" }));
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
    expect(within(screen.getByRole("combobox", { name: "Start frame for this scene" })).getByRole("option", { name: "Lamp photograph" })).toBeTruthy();
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

  it("disables Split while the playhead sits outside the selected clip", () => {
    const config = parseProjectConfig(completeFixture);
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\Timeline Project", onChange: () => undefined, onOpenGenerator: () => undefined }));
    const split = () => screen.getByRole("button", { name: "Split" }) as HTMLButtonElement;
    // The playhead starts at the head of the first clip, where splitSelected
    // returns early — so the button must not look live.
    expect(split().disabled).toBe(true);
    expect(split().title).toBe("Move the playhead inside the selected clip to split it");
    // Scrubbing inside the selected timeline clip makes it a real split. Scene
    // cards now open Generator scenes and are no longer aliases for clips.
    fireEvent.wheel(container.querySelector(".timeline-grid")!, { deltaY: 100, deltaMode: 0 });
    expect(split().disabled).toBe(false);
    expect(split().title).toBe("Split at playhead");
  });

  it("keeps a half-written shot line when you visit another tab and come back", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "generator",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    const line = () => screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement;
    openShot(1);
    fireEvent.change(line(), { target: { value: "a slow push across the launch pad" } });
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    await screen.findByRole("heading", { name: "Timeline", level: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Generator" }));
    await screen.findByRole("heading", { name: "Generator" });
    /* The trip unmounted the generator, so the panel is back on the scene and
       the card is where the words have to have survived. */
    expect(screen.getByRole("button", { name: "Shot 1 of First scene" }).textContent)
      .toContain("a slow push across the launch pad");
    openShot(1);
    /* Switching tabs unmounts the generator. The words are no longer typed into
       a composer the parent has to hold on its behalf — every keystroke lands on
       the scene itself, so the project carries them across the trip. Losing the
       user's own half-written words is the one thing this app must never do. */
    expect(line().value).toBe("a slow push across the launch pad");
  });

  it("does not bind an audio-tagged reference a new shot's prompt would drop", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, references: [
      { id: "ref-audio", kind: "text", name: "Score idea", description: "Sparse piano.", content: "Sparse piano.", intendedUse: ["audio"], createdAt: fresh.createdAt },
    ] });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Add a scene" }));
    // It would take a binding slot and then be dropped by the compiler, so the
    // shot would claim a reference its prompt never mentions.
    expect(onChange.mock.calls[0][0].generationJobs[0].referenceIds).toEqual([]);
  });

  it("says why Duplicate and Delete are unavailable, not just that they are", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    render(createElement(TimelineView, { config, folderPath: "C:\Timeline Project", onChange: () => undefined, onOpenGenerator: () => undefined }));
    for (const label of ["Duplicate", "Delete"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(`Select a clip to ${label.toLowerCase()} it`);
    }
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
      fireEvent.click(screen.getByRole("button", { name: /Add a reference/ }));
      const dialog = screen.getByRole("dialog", { name: "Add a reference" });
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

  it("makes timelines longer than one minute horizontally scrollable at a readable scale", () => {
    const short = createProjectConfig({ name: "Short", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 60 });
    const view = render(createElement(TimelineView, { config: short, folderPath: "C:\\Short", onChange: () => undefined, onOpenGenerator: () => undefined }));
    expect((view.container.querySelector(".timeline-grid") as HTMLElement).style.width).toBe("100%");
    expect(view.container.querySelector(".timeline-grid-scroll--wide")).toBeNull();

    const long = createProjectConfig({ name: "Long", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 120 });
    view.rerender(createElement(TimelineView, { config: long, folderPath: "C:\\Long", onChange: () => undefined, onOpenGenerator: () => undefined }));
    expect((view.container.querySelector(".timeline-grid") as HTMLElement).style.width).toBe("200%");
    expect(view.container.querySelector(".timeline-grid-scroll--wide")).toBeTruthy();
  });

  it("lays references out as a scrolling main area beside a full-height inspector", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container } = render(createElement(ReferencesView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined }));
    const view = container.querySelector(".references-view")!;
    expect(Array.from(view.children).slice(0, 2).map((element) => element.className)).toEqual(["references-main", "reference-inspector"]);
    expect(container.querySelector(".references-heading__actions")).toBeNull();
    expect(screen.getByRole("button", { name: /Add a reference/ })).not.toBeNull();
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
    const button = screen.getByRole("button", { name: "Debug Prompt" });
    if (button.getAttribute("aria-expanded") === "false") fireEvent.click(button);
  };

  /** Adds one setting to one shot: choose the setting, then choose its value.
   *  Settings are added one at a time now, rather than laid out as a wall of
   *  every term the vocabulary holds. */
  function addSetting(shotNumber: number, group: string, value: string) {
    fireEvent.change(screen.getByRole("combobox", { name: `Add a setting to shot ${shotNumber}` }), { target: { value: group } });
    fireEvent.change(screen.getByRole("combobox", { name: new RegExp(`^Value for .* on shot ${shotNumber}$`) }), { target: { value } });
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
      expect(screen.getByRole("button", { name: "Add a scene" })).not.toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Add a scene" }));

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
      fireEvent.change(screen.getByRole("textbox", { name: `Describe shot ${shotNumber}` }), { target: { value: line } });
      next = onChange.mock.calls.at(-1)![0];
      rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    }

    openScene();
    openDebugPrompt();
    const compiled = document.querySelector(".compiled-prompt__text")!.textContent!;
    expect(compiled).toContain("[Shot 1] Live-action, cinematic, A quiet product film.");
    expect(compiled).toContain("[Shot 2] (cut at 3s) she stops at the doorway.");
    expect(compiled).toContain("[Shot 3] (cut at 6.5s) the door opens");
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
    const speed = within(menu).getByRole("option", { name: /^Movement speed/ }) as HTMLOptionElement;
    expect(speed.disabled).toBe(true);
    expect(speed.textContent).toContain("needs a camera movement first");
    // The look belongs to the whole scene, so it is not offered per shot — it is
    // on the scene's own panel instead.
    expect(within(menu).queryByRole("option", { name: "Look" })).toBeNull();
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
    expect((screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement).value).toBe("A quiet product film");
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
    expect((screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("combobox", { name: "Add a setting to shot 1" }) as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByText(/It can be changed once it finishes/)).toBeNull();
  });

  it("drops a reference into a line, cites it as a subject, and changes its smart chip", () => {
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
    openShot(1);

    // Dragged out of the palette and dropped onto the line.
    const drop = (referenceId: string) => {
      const field = screen.getByRole("textbox", { name: "Describe shot 1" });
      const event = createEvent.drop(field);
      Object.defineProperty(event, "dataTransfer", { value: { getData: (type: string) => type === REFERENCE_DRAG_TYPE ? referenceId : "", types: [REFERENCE_DRAG_TYPE] } });
      fireEvent(field, event);
    };
    drop("ref-woman");
    let next = onChange.mock.calls.at(-1)![0];
    // Writing it into the line is what binds it to the scene, which is what
    // gives it a subject number and a place in reference_paths.
    expect(next.generationJobs[0].referenceIds).toEqual(["ref-woman"]);
    show(next);

    fireEvent.change(screen.getByRole("textbox", { name: "Describe shot 1" }), { target: { value: "[Reference 1] walks towards the camera on " } });
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    drop("ref-street");
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].referenceIds).toEqual(["ref-woman", "ref-street"]);
    show(next);

    // What the user reads in the field is "Reference N"; what is stored is the
    // reference's id, so a rename or a reorder cannot re-point the sentence.
    expect((screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement).value)
      .toBe("[Reference 1] walks towards the camera on [Reference 2]");
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
    const token = screen.getByRole("combobox", { name: "Reference 1 · Red-haired woman — choose another reference" });
    expect(token.closest(".shot-action-editor")).not.toBeNull();
    expect(screen.queryByText("Every reference in the line can be swapped for another:")).toBeNull();
    expect([...token.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Reference 1 · Red-haired woman", "Reference 2 · City street", "Take it out of the line",
    ]);
    fireEvent.change(token, { target: { value: "ref-street" } });
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    expect(next.generationJobs[0].shots[0].action).toBe("@[ref:ref-street] walks towards the camera on @[ref:ref-street]");
    openScene();
    expect(compiled()).toContain("<Subject 2> walks towards the camera on <Subject 2>");
  });

  it("keeps a word off the citation wherever in the line it is dropped", () => {
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

    /* Each case drops the same reference at a different caret offset into the
       same untouched line, so the only variable is where it landed. */
    const dropAt = (caret: number): string => {
      let config = start;
      const onChange = vi.fn((next: ProjectConfig) => { config = parseProjectConfig(next); });
      const view = () => createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: start.generationJobs[0].id });
      const app = render(view());
      openShot(1);
      const field = screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement;
      field.setSelectionRange(caret, caret);
      const event = createEvent.drop(field);
      Object.defineProperty(event, "dataTransfer", { value: { getData: (type: string) => type === REFERENCE_DRAG_TYPE ? "ref-woman" : "", types: [REFERENCE_DRAG_TYPE] } });
      fireEvent(field, event);
      app.unmount();
      return config.generationJobs[0].shots![0].action;
    };

    const line = "walks towards the camera and stops.";
    expect(dropAt(0)).toBe(`@[ref:ref-woman] ${line}`);
    expect(dropAt(line.length)).toBe(`${line} @[ref:ref-woman]`);
    /* Between two words, from either side of the space that separates them:
       one space each side, never two and never none. */
    expect(dropAt("walks towards ".length)).toBe("walks towards @[ref:ref-woman] the camera and stops.");
    expect(dropAt("walks towards".length)).toBe("walks towards @[ref:ref-woman] the camera and stops.");
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
      fireEvent.change(screen.getByRole(role, { name }), { target: { value } });
      show();
    };
    const press = (name: string) => { fireEvent.click(screen.getByRole("button", { name })); show(); };
    /* Every control below belongs to one shot or to the scene, and the panel
       shows one of those at a time — so the test opens what it is about to set,
       exactly as the user would. */
    const shot = (shotNumber: number) => { openShot(shotNumber, "First scene"); show(); };
    const scene = () => { openScene("First scene"); show(); };
    const dropReference = (referenceId: string, shotNumber: number) => {
      const field = screen.getByRole("textbox", { name: `Describe shot ${shotNumber}` });
      const event = createEvent.drop(field);
      Object.defineProperty(event, "dataTransfer", { value: { getData: (type: string) => type === REFERENCE_DRAG_TYPE ? referenceId : "", types: [REFERENCE_DRAG_TYPE] } });
      fireEvent(field, event);
      show();
    };

    set("slider", "First scene length in seconds", "12");
    press("Add a shot to First scene");
    press("Add a shot to First scene");

    // The street is dropped FIRST and the woman second, but the numbering
    // follows the project's reference order once both are bound — which is the
    // order reference_paths is built in, so <Subject 1> is <Picture 1>.
    shot(1);
    dropReference("ref-street", 1);
    dropReference("ref-woman", 1);
    set("textbox", "Describe shot 1", "[Reference 1] walks towards the camera on [Reference 2]");
    shot(2);
    set("spinbutton", "Shot 2 starts at, in seconds", "4.5");
    set("textbox", "Describe shot 2", "she stops at a doorway and looks up");
    shot(3);
    set("spinbutton", "Shot 3 starts at, in seconds", "9");
    set("textbox", "Describe shot 3", "the door opens and light spills across [Reference 2]");

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

    // What the field shows is "Reference N"; what is stored is the id, so a
    // rename or a reorder cannot re-point the sentence.
    shot(1);
    expect((screen.getByRole("textbox", { name: "Describe shot 1" }) as HTMLTextAreaElement).value)
      .toBe("[Reference 1] walks towards the camera on [Reference 2]");
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
      "[Shot 2] (cut at 4.5s) Medium close-up, she stops at a doorway and looks up.",
      "[Shot 3] (cut at 9s) the door opens and light spills across <Subject 2>. The shot features <Subject 2>, matching the definitions above.",
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
    const token = document.querySelector(".reference-smart-chip") as HTMLSelectElement;
    expect([...token.options].map((option) => option.textContent))
      .toEqual(["Reference 1 · Red-haired woman", "Reference 2 · City street", "Take it out of the line"]);
    fireEvent.change(token, { target: { value: "ref-street" } });
    show();
    scene();
    expect(document.querySelector(".compiled-prompt__text")!.textContent)
      .toContain("[Shot 1] <Subject 2> walks towards the camera on <Subject 2>.");
  });

  it("labels a cancelled scene as cancelled instead of queued, on the card and on its line", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "cancelled", stage: "failed" }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
    // The card's picture is the placeholder that says why there is no picture.
    expect(screen.getByRole("img", { name: "Shot 1 — Cancelled" })).not.toBeNull();
    expect(screen.getByText("CANCELLED")).not.toBeNull();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(document.querySelector(".job-progress-block")).toBeNull();
    expect(screen.queryByText("Waiting in queue")).toBeNull();
  });
});
