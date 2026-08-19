// @vitest-environment jsdom

import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { compileMiniMaxH3Prompt, createProjectConfig, parseProjectConfig, STORY_TRACK_ID, type ProjectAsset, type ProjectConfig, type ProjectRecord, type TimelineClip } from "../lib/project";
import { formatDurationTimecode } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GeneratorView } from "./workspace/GeneratorView";
import { REFERENCE_DRAG_TYPE } from "./workspace/SceneEditor";
import { ReferencesView } from "./workspace/ReferencesView";
import { TimelineView } from "./workspace/TimelineView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

/** Runs `body` with the app believing it is inside the desktop shell, so the
 *  REAL Tauri import path executes instead of the browser fallback. */
async function asDesktopApp(importedImage: { name: string; relativePath: string }, body: () => void | Promise<void>) {
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
  URL.createObjectURL = () => "blob:polstudio-test";
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
  URL.createObjectURL = () => "blob:polstudio-test";
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

  it("surfaces native save failures in the workspace", async () => {
    render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Portable Launch Film", config: parseProjectConfig(completeFixture) },
      onBack: () => undefined,
      onSave: async () => { throw new Error("The original project file is locked."); },
    }));
    // Save is the only save state left in the topbar — the standing "All
    // changes saved" pill is gone — so it is off until there is something to
    // write. Make an edit first, or the click lands on a disabled button.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Opening shot, retimed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t save project");
    expect(alert.textContent).toContain("The original project file is locked.");
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
    expect(screen.getAllByText("DRAFT").length).toBe(1);
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
  const laneFor = (container: HTMLElement, config: ProjectConfig, kind: "video" | "audio") =>
    container.querySelectorAll(".track-lane")[config.timeline.tracks.findIndex((track) => track.kind === kind)];
  const cardFor = (asset: ProjectAsset) => screen.getByTitle(new RegExp(`^${asset.name} —`));

  function mediaPanel(config: ProjectConfig, onChange = vi.fn()) {
    const view = render(createElement(TimelineView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Media" }));
    return { ...view, onChange };
  }

  it("switches the media panel between grid and list, and remembers which", () => {
    localStorage.removeItem("polstudio.media-layout.v1");
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

  it("drops a video from the media panel onto a video track, and refuses the audio track", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange } = mediaPanel(config);
    const card = screen.getByTitle(new RegExp(`^${video.name} —`));
    const lanes = container.querySelectorAll(".track-lane");
    const videoLane = lanes[config.timeline.tracks.findIndex((track) => track.kind === "video")];
    const audioLane = lanes[config.timeline.tracks.findIndex((track) => track.kind === "audio")];

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(audioLane, { dataTransfer });
    fireEvent.drop(audioLane, { dataTransfer });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.dragOver(videoLane, { dataTransfer });
    fireEvent.drop(videoLane, { dataTransfer });
    const next = onChange.mock.calls[0][0] as ProjectConfig;
    const track = next.timeline.tracks.find((item) => item.kind === "video")!;
    const dropped = track.clips.find((clip) => clip.assetId === video.id)!;
    expect(dropped.label).toBe(video.name);
    // A zero-width lane in jsdom must still yield a real start time, not NaN.
    expect(Number.isFinite(dropped.startMs)).toBe(true);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("drops a sound onto an audio track, and refuses every video track", () => {
    const config = projectWithMedia();
    const sound = config.assets[1];
    const { container, onChange } = mediaPanel(config);

    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(sound), { dataTransfer });
    // Video and audio are separated in BOTH directions. The video test beside
    // this one only proved the video half; a sound landing on a video track
    // makes a clip with a picture track and no picture.
    fireEvent.dragOver(laneFor(container, config, "video"), { dataTransfer });
    fireEvent.drop(laneFor(container, config, "video"), { dataTransfer });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.drop(laneFor(container, config, "audio"), { dataTransfer });
    const next = onChange.mock.calls[0][0] as ProjectConfig;
    const audioTrack = next.timeline.tracks.find((track) => track.kind === "audio")!;
    expect(audioTrack.clips.map((clip) => clip.assetId)).toEqual([sound.id]);
    expect(next.timeline.tracks.filter((track) => track.kind === "video").every((track) => track.clips.length === 0)).toBe(true);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("lands the dropped clip under the pointer and selects it", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange, rerender } = mediaPanel(config);
    const lane = laneFor(container, config, "video") as HTMLElement;
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

    const next = onChange.mock.calls[0][0] as ProjectConfig;
    const dropped = next.timeline.tracks.flatMap((track) => track.clips)[0];
    // A quarter of the way along a 30-second canvas, not pinned to zero.
    expect(dropped.startMs).toBe(Math.round(0.25 * 30_000));
    expect(parseProjectConfig(next)).toBeTruthy();

    // Dropping something and then having to find it again is a fair definition
    // of a broken drop, so the new clip arrives selected.
    rerender(createElement(TimelineView, { config: next, folderPath: "C:\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    const clip = container.querySelector(".timeline-clip.selected");
    expect(clip).not.toBeNull();
    expect(clip!.textContent).toContain(video.name);
  });

  it("marks the lanes that cannot take what is being dragged", () => {
    const config = projectWithMedia();
    const { container } = mediaPanel(config);
    const rejected = () => Array.from(container.querySelectorAll(".track-lane--reject"));

    expect(rejected()).toHaveLength(0);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(config.assets[1]), { dataTransfer });
    // Every video track, for the whole drag — not only the one under the
    // pointer. A dark lane on its own says nothing the user can act on.
    expect(rejected()).toHaveLength(config.timeline.tracks.filter((track) => track.kind === "video").length);
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

  const droppedClip = (calls: { mock: { calls: unknown[][] } }) =>
    ((calls.mock.calls[0][0] as ProjectConfig).timeline.tracks.flatMap((track) => track.clips))[0];

  it("drops a clip as long as the footage, and falls back to the stated default only when nothing measured it", () => {
    /* B3: every dropped clip used to be five seconds, forever — a 40-second
       rush included, with no way anywhere in the app to change it. */
    const known = measuredVideo(projectWithMedia(), 40_000);
    const first = mediaPanel(known);
    const transfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(known.assets[0]), { dataTransfer: transfer });
    fireEvent.drop(laneFor(first.container, known, "video"), { dataTransfer: transfer });
    expect(droppedClip(first.onChange).durationMs).toBe(40_000);
    expect(parseProjectConfig(first.onChange.mock.calls[0][0] as ProjectConfig)).toBeTruthy();
    cleanup();

    // Nothing has decoded this one, so there is no length to honour and the
    // documented stand-in is what lands.
    const unknown = projectWithMedia();
    const second = mediaPanel(unknown);
    const transferTwo = fakeDataTransfer();
    fireEvent.dragStart(cardFor(unknown.assets[0]), { dataTransfer: transferTwo });
    fireEvent.drop(laneFor(second.container, unknown, "video"), { dataTransfer: transferTwo });
    expect(droppedClip(second.onChange).durationMs).toBe(5_000);
  });

  it("retimes the selected clip from the Lasts field, and will not run past the footage", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), {});
    const onChange = vi.fn();
    render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    const lasts = screen.getByTitle(/^How long this clip lasts/) as HTMLInputElement;
    // It was readOnly, which made the only stated way to fix a clip's length a
    // field that could not be typed into.
    expect(lasts.readOnly).toBe(false);
    expect(lasts.value).toBe("00:40:00");
    const lastDuration = () => (onChange.mock.calls.at(-1)![0] as ProjectConfig).timeline.tracks.flatMap((track) => track.clips)[0].durationMs;

    // Plain seconds, and the minutes:seconds:frames the field itself prints.
    fireEvent.change(lasts, { target: { value: "8" } });
    expect(lastDuration()).toBe(8_000);
    fireEvent.change(lasts, { target: { value: "00:12:15" } });
    expect(lastDuration()).toBe(12_500);
    expect(parseProjectConfig(onChange.mock.calls.at(-1)![0] as ProjectConfig)).toBeTruthy();

    // Half-typed text is not a length, and must not be turned into one.
    const before = onChange.mock.calls.length;
    fireEvent.change(lasts, { target: { value: "00:" } });
    expect(onChange.mock.calls.length).toBe(before);
    expect(lasts.value).toBe("00:");

    // Clamped at both ends: a clip cannot be nothing, and cannot play footage
    // the file does not have.
    fireEvent.change(lasts, { target: { value: "0" } });
    expect(lastDuration()).toBe(33);
    fireEvent.change(lasts, { target: { value: "90" } });
    expect(lastDuration()).toBe(40_000);
    expect(parseProjectConfig(onChange.mock.calls.at(-1)![0] as ProjectConfig)).toBeTruthy();

    // Off the field, the clip's own length is what it shows again.
    fireEvent.blur(lasts);
    expect(lasts.value).toBe("00:40:00");
  });

  it("keeps a clip's place in the source when it is duplicated", () => {
    // Otherwise every copy replays the head of the file, which is the same five
    // seconds the original already showed.
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), { startMs: 0, durationMs: 6_000, sourceStartMs: 12_000 });
    const onChange = vi.fn();
    render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    const next = onChange.mock.calls[0][0] as ProjectConfig;
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
    expect(container.querySelector(".transport-format")!.textContent).toBe("1080P · 30 fps");

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

  it("inserts only a completed job with a real output into the first video track", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "completed", stage: "completed", progress: 1, outputRelativePath: "media/generated/first-scene.mp4" }] });
    const onChange = vi.fn();
    const onOpenTimeline = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenTimeline, selectedJobId: config.generationJobs[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Insert into Track 1, Video" }));
    const next = onChange.mock.calls[0][0];
    expect(next.assets[0].relativePath).toBe("media/generated/first-scene.mp4");
    expect(next.timeline.tracks.find((track: { id: string }) => track.id === STORY_TRACK_ID).clips).toHaveLength(1);
    expect(onOpenTimeline).toHaveBeenCalledOnce();
  });

  it("counts only the references that actually reach the compiled prompt", () => {
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
    expect(screen.getByText("1 reference guides this scene")).not.toBeNull();
    expect(screen.queryByText("3 references guide this scene")).toBeNull();
    // Skipped references stay visible, each with its reason.
    expect(screen.getByText("Lead character")).not.toBeNull();
    expect(screen.getByText("Not described yet — not used by this scene")).not.toBeNull();
    expect(screen.getByText(/sound note/)).not.toBeNull();
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

  it("links and unlinks a reference to the selected shot", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const createdAt = fresh.createdAt;
    const references = [
      { id: "ref-lamp", kind: "text", name: "Lamp silhouette", description: "Matte cream ceramic, tapered neck.", content: "Matte cream ceramic, tapered neck.", intendedUse: ["product"], createdAt },
      { id: "ref-light", kind: "text", name: "Window light", description: "Soft north light, long shadows.", content: "Soft north light, long shadows.", intendedUse: ["style"], createdAt },
    ];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-lamp"] }] });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Every reference in the project is offered, bound or not.
    const lamp = screen.getByRole("checkbox", { name: /Lamp silhouette/ }) as HTMLInputElement;
    const light = screen.getByRole("checkbox", { name: /Window light/ }) as HTMLInputElement;
    expect(lamp.checked).toBe(true);
    expect(light.checked).toBe(false);

    fireEvent.click(light);
    expect(onChange.mock.calls[0][0].generationJobs[0].referenceIds).toEqual(["ref-lamp", "ref-light"]);

    fireEvent.click(lamp);
    expect(onChange.mock.calls[1][0].generationJobs[0].referenceIds).toEqual([]);
  });

  it("shows each reference's own picture in the generator, and invents none", async () => {
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

    const tiles = () => [...container.querySelectorAll(".job-refs .ref-mini")];
    await waitFor(() => expect(tiles()).toHaveLength(2));
    /* The index-keyed class is what made the stand-in look deliberate. */
    expect(container.querySelector("[class*='ref-mini--']")).toBeNull();

    /* The image reference goes through the same component References uses, so
       outside the desktop shell it says which state it is in — loading, or the
       file is not where the project says — instead of drawing something. */
    const drawn = tiles().filter((tile) => tile.querySelector("img, .reference-image-fallback"));
    expect(drawn).toHaveLength(1);
    expect(drawn[0].parentElement!.textContent).toContain("Lamp photograph");

    /* Both tiles are hidden from the checkbox's own name: the name is the next
       node inside the same <label>, and announcing it twice is what an alt
       text here would cost. */
    expect(tiles().every((tile) => tile.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Lamp photograph/ })).not.toBeNull();
  });

  it("locks a running shot’s references, because the engine already has them", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const references = [{ id: "ref-lamp", kind: "text", name: "Lamp silhouette", description: "Matte cream ceramic.", content: "Matte cream ceramic.", intendedUse: ["product"], createdAt: fresh.createdAt }];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.4, referenceIds: ["ref-lamp"] }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect((screen.getByRole("checkbox", { name: /Lamp silhouette/ }) as HTMLInputElement).disabled).toBe(true);
  });

  it("tells the user the engine only follows the words when every bound reference is skipped", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const references = [{ id: "ref-blank", kind: "text", name: "Lead character", description: "", content: null, intendedUse: ["character"], createdAt: fresh.createdAt }];
    const config = parseProjectConfig({ ...fresh, references, generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-blank"] }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(screen.queryByText("1 reference guides this scene")).toBeNull();
    expect(screen.getByText("No references used by this scene")).not.toBeNull();
    expect(screen.getByText("The video engine only follows the words above.")).not.toBeNull();
    // The claim that a text definition is written into the prompt must not
    // appear when nothing is written into it.
    expect(screen.queryByText(/text definitions are written into this scene/)).toBeNull();
  });

  it("disables Split while the playhead sits outside the selected clip", () => {
    const config = parseProjectConfig(completeFixture);
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\Timeline Project", onChange: () => undefined, onOpenGenerator: () => undefined }));
    const split = () => screen.getByRole("button", { name: "Split" }) as HTMLButtonElement;
    // The playhead starts at the head of the first clip, where splitSelected
    // returns early — so the button must not look live.
    expect(split().disabled).toBe(true);
    expect(split().title).toBe("Move the playhead inside the selected clip to split it");
    // Choosing a scene puts the playhead inside it, which is a real split.
    fireEvent.click(container.querySelector(".scene-card")!);
    expect(split().disabled).toBe(false);
    expect(split().title).toBe("Split at playhead");
  });

  it("keeps half-written composer text when you visit another tab and come back", async () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container } = render(createElement(ProjectWorkspace, {
      project: { folderPath: "C:\\Ceramic Lamp", config }, initialView: "generator",
      onBack: () => undefined, onSave: async () => undefined,
    }));
    const composer = () => container.querySelector(".generation-composer textarea") as HTMLTextAreaElement;
    fireEvent.change(composer(), { target: { value: "a slow push across the launch pad" } });
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    await screen.findByRole("heading", { name: "Timeline", level: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Generator" }));
    await screen.findByRole("heading", { name: "Generator" });
    // Switching tabs unmounts the generator. Losing the user's own half-written
    // words is the one thing this app must never do.
    expect(composer().value).toBe("a slow push across the launch pad");
  });

  it("does not bind an audio-tagged reference a new shot's prompt would drop", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, references: [
      { id: "ref-audio", kind: "text", name: "Score idea", description: "Sparse piano.", content: "Sparse piano.", intendedUse: ["audio"], createdAt: fresh.createdAt },
    ] });
    const onChange = vi.fn();
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined }));
    fireEvent.change(container.querySelector(".generation-composer textarea")!, { target: { value: "a slow push across the pad" } });
    fireEvent.click(screen.getByRole("button", { name: /Save as a draft|Generate/ }));
    // It would take a binding slot and then be dropped by the compiler, so the
    // shot would claim a reference its prompt never mentions.
    expect(onChange.mock.calls[0][0].generationJobs[0].referenceIds).toEqual([]);
  });

  it("describes only the route the bound references actually take", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({
      ...fresh,
      references: [{ id: "ref-text", kind: "text", name: "Mara", description: "Calm architect.", content: "Calm architect.", intendedUse: ["character"], createdAt: fresh.createdAt }],
      generationJobs: [{ ...fresh.generationJobs[0], referenceIds: ["ref-text"] }],
    });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: fresh.generationJobs[0].id }));
    expect(document.querySelector(".job-refs")!.textContent).toContain("The text definition is written into this scene’s prompt.");
    // The composer hint says the same thing about the same references. Scoping
    // this to .job-refs hid a second copy of the claim that was still wrong.
    expect(container.querySelector(".generation-composer__hint")!.textContent).toContain("The text definition is written into the prompt.");
    // No image exists anywhere in this project, so NOTHING on the screen may
    // claim something is sent to the engine as an asset.
    expect(container.textContent).not.toContain("images are sent to the video engine");
    expect(container.textContent).not.toContain("Images are sent to the video engine");
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
    await asDesktopApp({ name: "IMG_4821", relativePath: "references/IMG_4821.jpg" }, async () => {
      render(createElement(ReferencesView, { config, folderPath: "C:\\Ceramic Lamp", onChange }));
      fireEvent.click(screen.getByRole("button", { name: "Add image" }));
      await waitFor(() => expect(onChange).toHaveBeenCalled());
    });

    const imported = onChange.mock.calls[0][0].references[0];
    expect(imported.relativePath).toBe("references/IMG_4821.jpg");
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
    // definition. Three sentences here once said exactly that while the card
    // beside them correctly said the file was sent.
    cleanup();
    const withImport = onChange.mock.calls[0][0];
    expect(withImport.references[0].relativePath).toBeTruthy();
    const { container } = render(createElement(ReferencesView, { config: withImport, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined }));
    const screenText = container.textContent ?? "";
    for (const staleRule of ["you’ve described", "described references", "skipped", "is skipped until you write"]) {
      expect(screenText, `stale binding rule on screen: ${staleRule}`).not.toContain(staleRule);
    }
    expect(screenText).toContain("An image counts as soon as you import it");
    expect(screenText).toContain("Not described yet — the picture is sent, but nothing tells the engine what to keep.");
  });

  /** Adds one setting to one shot: choose the setting, then choose its value.
   *  Settings are added one at a time now, rather than laid out as a wall of
   *  every term the vocabulary holds. */
  function addSetting(shotNumber: number, group: string, value: string) {
    fireEvent.change(screen.getByRole("combobox", { name: `Add a setting to shot ${shotNumber}` }), { target: { value: group } });
    fireEvent.change(screen.getByRole("combobox", { name: new RegExp(`^Value for .* on shot ${shotNumber}$`) }), { target: { value } });
  }

  const lampProject = () => createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });

  it("calls the rail Scenes, drops the eyebrow, and offers no way back to the timeline from the header", () => {
    const fresh = lampProject();
    for (const config of [parseProjectConfig({ ...fresh, generationJobs: [] }), fresh]) {
      const { container, unmount } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
      expect(screen.getByRole("complementary", { name: "Scenes" })).not.toBeNull();
      expect(container.querySelector(".generator-heading .eyebrow")).toBeNull();
      expect(screen.queryByRole("button", { name: "View timeline" })).toBeNull();
      // A new scene is still started from this page, and it says so.
      expect(screen.getByRole("heading", { name: "Start another scene" })).not.toBeNull();
      expect(document.querySelector(".generation-composer__lede")!.textContent).toContain("changing a scene that already exists");
      unmount();
    }
  });

  it("splits a scene into three shots on the bar, each with its own line and cut", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const { rerender } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Two more shots, and the scene stretched to hold them.
    fireEvent.click(screen.getByRole("button", { name: "Add a shot" }));
    let next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].shots).toHaveLength(2);
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    fireEvent.click(screen.getByRole("button", { name: "Add a shot" }));
    next = onChange.mock.calls.at(-1)![0];
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    fireEvent.change(screen.getByRole("slider", { name: "Scene length in seconds" }), { target: { value: "9" } });
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].durationSeconds).toBe(9);
    rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));

    // Each cut is set on the bar, and the second and third lines are written.
    for (const [shotNumber, startSeconds, line] of [[2, 3, "she stops at the doorway"], [3, 6.5, "the door opens"]] as const) {
      fireEvent.change(screen.getByRole("spinbutton", { name: `Shot ${shotNumber} starts at, in seconds` }), { target: { value: String(startSeconds) } });
      next = onChange.mock.calls.at(-1)![0];
      rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
      fireEvent.change(screen.getByRole("textbox", { name: `What happens in shot ${shotNumber}` }), { target: { value: line } });
      next = onChange.mock.calls.at(-1)![0];
      rerender(createElement(GeneratorView, { config: parseProjectConfig(next), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    }

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
    const length = () => screen.getByRole("slider", { name: "Scene length in seconds" }) as HTMLInputElement;
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
    // A scene of no length has no frames to render, and the screen says so in
    // words rather than leaving a grey button with no explanation.
    app.rerender(createElement(GeneratorView, { config: parseProjectConfig(emptied), folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect(screen.getByText(/nought seconds long, so there are no frames to render/)).not.toBeNull();
  });

  it("adds a setting to one shot and takes it off again, without touching the other shot", () => {
    const config = lampProject();
    const onChange = vi.fn();
    const { rerender } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
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
    const prompt = document.querySelector(".compiled-prompt__text")!;
    expect(prompt.textContent).toContain("Camera movement: push in, slow speed.");
    expect([...document.querySelectorAll(".prompt-part--tag")].map((part) => part.textContent)).toContain("push in, slow speed");
    expect(document.querySelector(".prompt-part--brief")!.textContent).not.toContain("push in");

    fireEvent.click(screen.getByRole("button", { name: "Remove Camera movement: Push in from shot 1" }));
    expect(onChange.mock.calls.at(-1)![0].generationJobs[0].shots[0].settings).toEqual({ cameraSpeed: ["slow"] });
  });

  it("refuses movement speed until there is a movement for it to qualify", () => {
    const config = lampProject();
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    // Not merely disabled — it says why, the way every other blocked control on
    // this screen does.
    const menu = screen.getByRole("combobox", { name: "Add a setting to shot 1" });
    const speed = within(menu).getByRole("option", { name: /^Movement speed/ }) as HTMLOptionElement;
    expect(speed.disabled).toBe(true);
    expect(speed.textContent).toContain("needs a camera movement first");
    // The look belongs to the whole scene, so it is not offered per shot.
    expect(within(menu).queryByRole("option", { name: "Look" })).toBeNull();
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
    expect((screen.getByRole("textbox", { name: "What happens in shot 1" }) as HTMLTextAreaElement).value).toBe("A quiet product film");
    expect(screen.getByText("macro lens")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "What happens in shot 2" })).toBeNull();
    expect(document.querySelector(".compiled-prompt__text")!.textContent).toContain("macro lens, A quiet product film");
    // Its length is the one it was always generated at, said out loud.
    expect(screen.getByText("6.0 seconds, one shot")).not.toBeNull();

    // The first edit moves the tags onto the shot, and clears the legacy copy
    // so the two can never disagree.
    addSetting(1, "lighting", "soft-light");
    const next = onChange.mock.calls.at(-1)![0].generationJobs[0];
    expect(next.shots[0].settings).toEqual({ lens: ["macro-lens"], lighting: ["soft-light"] });
    expect(next.shotTags).toBeNull();
    expect(parseProjectConfig(onChange.mock.calls.at(-1)![0])).toBeTruthy();
  });

  it("locks a running scene, because the engine already has the prompt", () => {
    const fresh = lampProject();
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.4 }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    expect((screen.getByRole("textbox", { name: "What happens in shot 1" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("combobox", { name: "Add a setting to shot 1" }) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("slider", { name: "Scene length in seconds" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/It can be changed once it finishes/)).not.toBeNull();
  });

  it("drops a reference into a line, cites it as a subject, and swaps it for another", () => {
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

    // Dragged out of the palette and dropped onto the line.
    const drop = (referenceId: string) => {
      const field = screen.getByRole("textbox", { name: "What happens in shot 1" });
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

    fireEvent.change(screen.getByRole("textbox", { name: "What happens in shot 1" }), { target: { value: "[Reference 1] walks towards the camera on " } });
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    drop("ref-street");
    next = onChange.mock.calls.at(-1)![0];
    expect(next.generationJobs[0].referenceIds).toEqual(["ref-woman", "ref-street"]);
    show(next);

    // What the user reads in the field is "Reference N"; what is stored is the
    // reference's id, so a rename or a reorder cannot re-point the sentence.
    expect((screen.getByRole("textbox", { name: "What happens in shot 1" }) as HTMLTextAreaElement).value)
      .toBe("[Reference 1] walks towards the camera on [Reference 2]");
    expect(next.generationJobs[0].shots[0].action).toBe("@[ref:ref-woman] walks towards the camera on @[ref:ref-street]");
    const compiled = () => document.querySelector(".compiled-prompt__text")!.textContent!;
    expect(compiled()).toContain("<Subject 1> walks towards the camera on <Subject 2>");
    expect(compiled()).not.toContain("@[ref:");
    // The citation is PolStudio's format, not something the user typed.
    expect([...document.querySelectorAll(".prompt-part--frame")].map((part) => part.textContent)).toContain("<Subject 1>");
    expect(document.querySelector(".prompt-part--brief")!.textContent).not.toContain("<Subject");

    // Clicking the first reference in the line offers every other one.
    const token = screen.getByRole("combobox", { name: "Reference 1 · Red-haired woman — choose another reference" });
    expect([...token.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "Reference 1 · Red-haired woman", "Reference 2 · City street", "Take it out of the line",
    ]);
    fireEvent.change(token, { target: { value: "ref-street" } });
    next = onChange.mock.calls.at(-1)![0];
    show(next);
    expect(next.generationJobs[0].shots[0].action).toBe("@[ref:ref-street] walks towards the camera on @[ref:ref-street]");
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
      const field = screen.getByRole("textbox", { name: "What happens in shot 1" }) as HTMLTextAreaElement;
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
    const dropReference = (referenceId: string, shotNumber: number) => {
      const field = screen.getByRole("textbox", { name: `What happens in shot ${shotNumber}` });
      const event = createEvent.drop(field);
      Object.defineProperty(event, "dataTransfer", { value: { getData: (type: string) => type === REFERENCE_DRAG_TYPE ? referenceId : "", types: [REFERENCE_DRAG_TYPE] } });
      fireEvent(field, event);
      show();
    };

    set("slider", "Scene length in seconds", "12");
    press("Add a shot");
    press("Add a shot");

    // The street is dropped FIRST and the woman second, but the numbering
    // follows the project's reference order once both are bound — which is the
    // order reference_paths is built in, so <Subject 1> is <Picture 1>.
    dropReference("ref-street", 1);
    dropReference("ref-woman", 1);
    set("textbox", "What happens in shot 1", "[Reference 1] walks towards the camera on [Reference 2]");
    set("spinbutton", "Shot 2 starts at, in seconds", "4.5");
    set("textbox", "What happens in shot 2", "she stops at a doorway and looks up");
    set("spinbutton", "Shot 3 starts at, in seconds", "9");
    set("textbox", "What happens in shot 3", "the door opens and light spills across [Reference 2]");

    set("combobox", "Add a setting to shot 1", "cameraMovement");
    set("combobox", "Value for Camera movement on shot 1", "push-in");
    set("combobox", "Add a setting to shot 1", "cameraSpeed");
    set("combobox", "Value for Movement speed on shot 1", "slow");
    set("combobox", "Add a setting to shot 2", "shotSize");
    set("combobox", "Value for Shot size on shot 2", "medium-close-up");
    set("combobox", "The look of this scene", "live-action-cinematic");
    set("textbox", "The sound of this scene", "Rain on cobbles, distant traffic, her boots on stone.");
    set("textbox", "The music of this scene", "Low sustained cello, slow tempo, swelling in the last two seconds.");

    // What the field shows is "Reference N"; what is stored is the id, so a
    // rename or a reorder cannot re-point the sentence.
    expect((screen.getByRole("textbox", { name: "What happens in shot 1" }) as HTMLTextAreaElement).value)
      .toBe("[Reference 1] walks towards the camera on [Reference 2]");
    expect(config.generationJobs[0].shots![0].action).toBe("@[ref:ref-woman] walks towards the camera on @[ref:ref-street]");
    expect(config.generationJobs[0].durationSeconds).toBe(12);
    expect(config.generationJobs[0].shots!.map((shot) => shot.startSeconds)).toEqual([0, 4.5, 9]);

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
    const token = document.querySelector(".shot-readback__token") as HTMLSelectElement;
    expect([...token.options].map((option) => option.textContent))
      .toEqual(["Reference 1 · Red-haired woman", "Reference 2 · City street", "Take it out of the line"]);
    fireEvent.change(token, { target: { value: "ref-street" } });
    show();
    expect(document.querySelector(".compiled-prompt__text")!.textContent)
      .toContain("[Shot 1] <Subject 2> walks towards the camera on <Subject 2>.");
  });

  it("labels a cancelled preview as cancelled instead of queued", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "cancelled", stage: "failed" }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
    expect(screen.getByText("Generation cancelled")).not.toBeNull();
    expect(screen.queryByText("Waiting in queue")).toBeNull();
  });
});
