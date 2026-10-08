// @vitest-environment jsdom
/* The timeline editor on its own: the media and scene panels, drops, drags,
   trims, the transport, shortcuts, context menus and zoom. (Most of these used
   to live in ProjectWorkspace.test.ts; they test TimelineView, so they live
   beside it now.) */
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../../fixtures/project-v1-complete.json";
import { createProjectConfig, parseProjectConfig, STORY_TRACK_ID, type ProjectAsset, type ProjectConfig, type TimelineClip } from "../../lib/project";
import { TimelineView } from "./TimelineView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Runs `body` with a media stack that behaves like a browser's: the desktop
 *  shell serves the bytes, blob URLs exist, and a <video>/<audio> element
 *  reports the metadata of a file this long and this big. */
async function withFakeDecoder(file: { seconds: number; width: number; height: number }, body: () => Promise<void>) {
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

/** The same fake media stack, except that NOTHING settles on its own: each
 *  <video>/<audio> the panel opens waits until the test lands it. */
async function withStagedDecoder(file: { seconds: number; width: number; height: number }, body: (stage: {
  opened: (count: number) => Promise<void>;
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

/* jsdom has no DataTransfer, so the drag has to carry its own. Same contract as
   the browser's: setData during dragstart, types visible during dragover,
   getData on drop. */
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

/** A project carrying one importable clip of each kind. */
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

const laneAt = (container: HTMLElement, index: number) => container.querySelectorAll(".track-lane")[index];
const cardFor = (asset: ProjectAsset) => document.querySelector(`[data-asset-id="${asset.id}"]`) as HTMLElement;
const render_ = (config: ProjectConfig, onChange = vi.fn(), onOpenGenerator: (jobId?: string) => void = () => undefined) =>
  ({ ...render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator })), onChange });

function mediaPanel(config: ProjectConfig, onChange = vi.fn()) {
  const view = render_(config, onChange);
  fireEvent.click(screen.getByRole("tab", { name: "Media" }));
  return view;
}

const measuredVideo = (config: ProjectConfig, durationMs: number) => parseProjectConfig({
  ...config,
  assets: config.assets.map((asset) => asset.kind === "video" ? { ...asset, durationMs, width: 1920, height: 1080 } : asset),
});

const withClip = (config: ProjectConfig, clip: Partial<TimelineClip>) => parseProjectConfig({
  ...config,
  timeline: { tracks: config.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips: [{
    id: "clip-macro", assetId: config.assets[0].id, trackId: STORY_TRACK_ID,
    startMs: 0, durationMs: 40_000, sourceStartMs: 0, label: "Macro footage", color: null, status: "approved", ...clip,
  }] } : track) },
});

const withClips = (config: ProjectConfig, clips: Partial<TimelineClip>[], trackId = STORY_TRACK_ID) => parseProjectConfig({
  ...config,
  timeline: { tracks: config.timeline.tracks.map((track) => track.id === trackId ? { ...track, clips: clips.map((clip, index) => ({
    id: `clip-${index}`, assetId: config.assets[0].id, trackId,
    startMs: 0, durationMs: 4_000, sourceStartMs: 0, label: `Shot ${index + 1}`, color: null, status: "approved", ...clip,
  })) } : track) },
});

const LANE_WIDTH = 1000;
const LANE_RECT = { left: 0, width: LANE_WIDTH, top: 0, right: LANE_WIDTH, bottom: 56, height: 56, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;

function pointerEvent(type: string, clientX: number, clientY = 40) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ clientX, clientY, button: 0, pointerId: 1 })) {
    Object.defineProperty(event, key, { value });
  }
  return event;
}

/** Renders the timeline with every lane measured. */
function timeline(config: ProjectConfig) {
  const view = render_(config);
  for (const lane of view.container.querySelectorAll(".track-lane")) lane.getBoundingClientRect = () => LANE_RECT;
  const laneOf = (trackId: string) => view.container.querySelector(`[data-track-id="${trackId}"]`) as HTMLElement;
  const written = () => view.onChange.mock.calls.length ? wrote(view.onChange.mock.calls.at(-1)![0], config) : undefined;
  const clipsOn = (trackId: string) => written()?.timeline.tracks.find((track) => track.id === trackId)?.clips ?? [];
  return { ...view, laneOf, written, clipsOn };
}

/** One whole gesture: press on `grip`, move to `toX`, release. */
function drag(grip: Element, fromX: number, toX: number, clientY = 40) {
  fireEvent(grip, pointerEvent("pointerdown", fromX, clientY));
  fireEvent(window, pointerEvent("pointermove", toX, clientY));
  fireEvent(window, pointerEvent("pointerup", toX, clientY));
}

const overLane = (lane: HTMLElement) => {
  (document as unknown as { elementsFromPoint: () => Element[] }).elementsFromPoint = () => [lane];
};
const stopHitTesting = () => { delete (document as unknown as { elementsFromPoint?: unknown }).elementsFromPoint; };

/** A key press where the user is: inside the timeline view. */
const press = (container: HTMLElement, key: string, init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(container.querySelector(".timeline-view")!, { key, ...init });
const toolbarTime = (container: HTMLElement) => container.querySelector(".transport-time")!.textContent;

describe("the media and scene panels", () => {
  it("changes clip speed in Timing and splits using the retimed source position", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40000), { durationMs: 4000, sourceStartMs: 1000, playbackRate: 2 });
    const { container, onChange } = render_(config);
    const field = screen.getByRole("spinbutton", { name: "Clip speed" });
    expect((field as HTMLInputElement).value).toBe("200");
    fireEvent.change(field, { target: { value: "50" } });
    fireEvent.blur(field);
    const changed = wrote(onChange.mock.calls.at(-1)![0], config).timeline.tracks.flatMap((track) => track.clips)[0];
    expect(changed.playbackRate).toBe(0.5);
    expect(changed.durationMs).toBe(16000);
    // This harness retains its input snapshot; split the original 2x clip.
    onChange.mockClear();
    press(container, "ArrowRight", { shiftKey: true });
    press(container, "k", { ctrlKey: true });
    const split = wrote(onChange.mock.calls.at(-1)![0], config).timeline.tracks.flatMap((track) => track.clips);
    expect(split[1].sourceStartMs).toBe(Math.round(1000 + split[0].durationMs * 2));
    expect(split[1].playbackRate).toBe(2);
  });
  it("switches the media panel between grid and list, and remembers which", () => {
    const { container } = mediaPanel(projectWithMedia());
    expect(container.querySelector(".media-grid--grid")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(container.querySelector(".media-grid--list")).not.toBeNull();
    const choice = localStorage.getItem("slopus.media-layout.v1");
    cleanup();
    if (choice !== null) localStorage.setItem("slopus.media-layout.v1", choice);
    const second = mediaPanel(projectWithMedia());
    expect(second.container.querySelector(".media-grid--list")).not.toBeNull();
  });

  it("keeps imported media in Media and lists Generator scenes even before generation", () => {
    const config = withClip(projectWithMedia(), { durationMs: 5_000 });
    const { container } = render_(config);
    expect(screen.getByRole("tablist", { name: "Scenes and media" })).toBeTruthy();
    expect(container.querySelector(".scene-list")!.textContent).toContain("First scene");
    expect(container.querySelector(".scene-list")!.textContent).not.toContain("Macro footage");
    expect(container.querySelector(".scene-card__thumb")).not.toBeNull();
    expect(container.querySelector(".scene-card__thumb .shot-thumb")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Media" }));
    const media = container.querySelector(".media-grid")! as HTMLElement;
    expect(screen.getByRole("button", { name: "Import" })).not.toBeNull();
    expect(within(media).getByText("Macro footage")).not.toBeNull();
    expect(within(media).getByText("Room tone")).not.toBeNull();
  });

  it("heads both views with one toolbar, marks the open scene and the chosen media card, and says when there is no media", () => {
    const config = projectWithMedia();
    const job = config.generationJobs[0];
    const { container } = render(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange: vi.fn(), onOpenGenerator: () => undefined, openSceneId: job.id }));
    expect(container.querySelectorAll(".scene-panel .ui-pane-header")).toHaveLength(1);
    expect(container.querySelector(".scene-panel .ui-pane-header__title")).toBeNull();
    const scene = container.querySelector(`[data-scene-id="${job.id}"]`)!;
    expect(scene.classList.contains("is-selected")).toBe(true);
    expect(scene.querySelector(".scene-card__status")).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Media" }));
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.focus(cardFor(config.assets[1]));
    expect(cardFor(config.assets[1]).classList.contains("is-selected")).toBe(true);
    expect(cardFor(config.assets[0]).classList.contains("is-selected")).toBe(false);
    cleanup();
    const empty = mediaPanel(parseProjectConfig({ ...config, assets: [] })).container.querySelector(".media-grid") as HTMLElement;
    expect(within(empty).getByText("No media yet")).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "Import media" })).toBeTruthy();
  });

  it("offers Add scene as a plain button that opens the unstarted draft", () => {
    const opened = vi.fn();
    const config = projectWithMedia();
    render_(config, vi.fn(), opened);
    const add = screen.getByRole("button", { name: "Add scene" });
    expect(add.classList.contains("secondary-button")).toBe(true);
    fireEvent.click(add);
    expect(opened).toHaveBeenCalledWith(config.generationJobs.find((job) => job.status === "draft")?.id);
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
      expect(button).toHaveProperty("disabled", true);
      await act(async () => { finish(); await pending; });
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.mocked(invoke).mockReset();
    }
  });

  it("removes project media and every timeline use of it, from the card's context menu or Delete", () => {
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
    // No × on every card.
    expect(screen.queryByRole("button", { name: /^Remove Macro footage/ })).toBeNull();
    fireEvent.contextMenu(cardFor(config.assets[0]));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from project/ }));
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.assets.map((asset) => asset.id)).toEqual(["asset-room"]);
    expect(next.timeline.tracks.flatMap((track) => track.clips).some((clip) => clip.assetId === "asset-macro")).toBe(false);
    expect(parseProjectConfig(next)).toBeTruthy();

    fireEvent.keyDown(cardFor(config.assets[1]), { key: "Delete" });
    expect(wrote(onChange.mock.calls[1][0], config).assets.map((asset) => asset.id)).toEqual(["asset-macro"]);
  });
});

describe("waveforms and thumbnails on clips", () => {
  it("shows audio-only waveforms and a title strip naming each clip", () => {
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
    const { container, onChange } = render_(config);
    expect(container.querySelectorAll(".clip-audio-visualization")).toHaveLength(2);
    expect(container.querySelectorAll(".timeline-clip--audio-only")).toHaveLength(1);
    expect(Array.from(container.querySelectorAll(".timeline-clip__title")).map((title) => title.textContent)).toEqual(["Macro footage", "Room tone"]);
    fireEvent.click(screen.getByRole("button", { name: "Mute audio on Track 1" }));
    expect(wrote(onChange.mock.calls[0][0], config).timeline.tracks[0].muted).toBe(true);
  });

  it("colours clips by kind, with a glyph, an fx badge, and their own colour when they have one", () => {
    const config = withClips(projectWithMedia(), [
      { assetId: "asset-macro", sharpen: { amount: 50 } },
      { assetId: "asset-room", startMs: 5_000, color: "#123456", blur: { radius: 4, enabled: false } },
    ]);
    const { container } = render_(config);
    const [video, audio] = Array.from(container.querySelectorAll(".timeline-clip"));
    expect(video.classList.contains("timeline-clip--video")).toBe(true);
    expect(audio.classList.contains("timeline-clip--audio")).toBe(true);
    // A clip with no colour of its own takes its kind's rather than a blanket blue.
    expect((video.parentElement as HTMLElement).style.getPropertyValue("--clip-color")).toBe("");
    expect((audio.parentElement as HTMLElement).style.getPropertyValue("--clip-color")).toBe("#123456");
    expect(video.querySelector(".timeline-clip__strip svg")).not.toBeNull();
    expect(video.querySelector(".timeline-clip__fx")!.textContent).toBe("fx 1");
    expect(video.querySelector(".timeline-clip__fx--off")).toBeNull();
    expect(audio.querySelector(".timeline-clip__fx--off")).not.toBeNull();
    expect(audio.getAttribute("aria-label")).toContain("1 effects all off");
  });

  it("gives caption tracks their own kind and hatches locked lanes", () => {
    const base = projectWithMedia();
    const config: ProjectConfig = { ...base, timeline: { tracks: [
      { ...base.timeline.tracks[0], locked: true },
      { id: "track-c1", kind: "caption", name: "Captions", locked: false, muted: false, clips: [] },
    ] } };
    const { container } = render_(config);
    expect(Array.from(container.querySelectorAll(".track-label")).map((label) => label.textContent)).toEqual(["V1", "C1"]);
    expect(container.querySelector(".track-head--caption")).not.toBeNull();
    expect(container.querySelector(".track-lane--caption")).not.toBeNull();
    expect(container.querySelector(".track-lane--video")!.classList.contains("track-lane--locked")).toBe(true);
    expect((container.querySelector(".track-label") as HTMLElement).style.getPropertyValue("--track-kind")).toBe("var(--clip-video)");
  });

  it("labels tracks V1, V2… with 20px toggles beside an editable name", () => {
    const { container } = render_(projectWithMedia());
    expect(Array.from(container.querySelectorAll(".track-label")).map((label) => label.textContent)).toEqual(["V1", "V2", "V3"]);
    expect(container.querySelector(".track-kind")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Rename Track 1" })).toBeTruthy();
  });
});

describe("dropping onto the timeline", () => {
  it("drops an ungenerated Generator scene onto an audiovisual track as a valid draft clip", () => {
    const config = projectWithMedia();
    const { container, onChange } = render_(config);
    const scene = container.querySelector(".scene-card") as HTMLElement;
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(scene, { dataTransfer });
    fireEvent.drop(laneAt(container, 1), { dataTransfer });
    const next = wrote(onChange.mock.calls[0][0], config);
    const generatedAsset = next.assets.find((asset) => asset.id === "asset-job-initial-brief")!;
    const clip = next.timeline.tracks.flatMap((track) => track.clips).find((item) => item.assetId === generatedAsset.id)!;
    expect(generatedAsset.kind).toBe("generated");
    expect(clip.status).toBe("draft");
    expect(clip.label).toBe("First scene");
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("drops a video onto any audiovisual track", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange } = mediaPanel(config);
    const lane = laneAt(container, 1);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(video), { dataTransfer });
    fireEvent.dragOver(lane, { dataTransfer });
    fireEvent.drop(lane, { dataTransfer });
    const dropped = wrote(onChange.mock.calls[0][0], config).timeline.tracks[1].clips.find((clip) => clip.assetId === video.id)!;
    expect(dropped.label).toBe(video.name);
    expect(Number.isFinite(dropped.startMs)).toBe(true);
  });

  it("drops an audio-only file onto an audiovisual track", () => {
    const config = projectWithMedia();
    const sound = config.assets[1];
    const { container, onChange } = mediaPanel(config);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(sound), { dataTransfer });
    fireEvent.drop(laneAt(container, 2), { dataTransfer });
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.timeline.tracks[2].clips.map((clip) => clip.assetId)).toEqual([sound.id]);
    expect(parseProjectConfig(next)).toBeTruthy();
  });

  it("lands the dropped clip under the pointer and selects it", () => {
    const config = projectWithMedia();
    const video = config.assets[0];
    const { container, onChange, rerender } = mediaPanel(config);
    const lane = laneAt(container, 0) as HTMLElement;
    lane.getBoundingClientRect = () => ({ left: 100, width: 1000, top: 0, right: 1100, bottom: 56, height: 56, x: 100, y: 0, toJSON: () => ({}) });
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(video), { dataTransfer });
    const drop = createEvent.drop(lane, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: 350 });
    fireEvent(lane, drop);
    const next = wrote(onChange.mock.calls[0][0], config);
    expect(next.timeline.tracks.flatMap((track) => track.clips)[0].startMs).toBe(Math.round(0.25 * 30_000));
    rerender(createElement(TimelineView, { config: next, folderPath: "C:\\Ceramic Lamp", onChange, onOpenGenerator: () => undefined }));
    expect(container.querySelector(".timeline-clip.selected")!.getAttribute("aria-label")).toContain(video.name);
  });

  it("marks a locked lane as unavailable while media is being dragged", () => {
    const base = projectWithMedia();
    const config = { ...base, timeline: { tracks: base.timeline.tracks.map((track, index) => index === 1 ? { ...track, locked: true } : track) } };
    const { container } = mediaPanel(config);
    const rejected = () => Array.from(container.querySelectorAll(".track-lane--reject"));
    expect(rejected()).toHaveLength(0);
    const dataTransfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(config.assets[1]), { dataTransfer });
    expect(rejected()).toHaveLength(1);
    fireEvent.dragEnd(cardFor(config.assets[1]));
    expect(rejected()).toHaveLength(0);
  });

  it("drops a clip as long as the footage, and falls back to the stated default only when nothing measured it", () => {
    const known = measuredVideo(projectWithMedia(), 40_000);
    const first = mediaPanel(known);
    const transfer = fakeDataTransfer();
    fireEvent.dragStart(cardFor(known.assets[0]), { dataTransfer: transfer });
    fireEvent.drop(laneAt(first.container, 0), { dataTransfer: transfer });
    expect(wrote(first.onChange.mock.calls[0][0], known).timeline.tracks.flatMap((track) => track.clips)[0].durationMs).toBe(40_000);
    cleanup();
    const unknown = projectWithMedia();
    const second = mediaPanel(unknown);
    const transferTwo = fakeDataTransfer();
    fireEvent.dragStart(cardFor(unknown.assets[0]), { dataTransfer: transferTwo });
    fireEvent.drop(laneAt(second.container, 0), { dataTransfer: transferTwo });
    expect(wrote(second.onChange.mock.calls[0][0], unknown).timeline.tracks.flatMap((track) => track.clips)[0].durationMs).toBe(5_000);
  });
});

describe("the clip inspector", () => {
  it("uses an editable clip name as the heading, and property rows for timing", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), {});
    const { container, onChange } = render_(config);
    const heading = screen.getByRole("heading", { name: "Macro footage" });
    const name = within(heading).getByRole("textbox", { name: "Clip name" });
    expect((name as HTMLInputElement).value).toBe("Macro footage");
    // The clip heads the pane: no "Inspector" title, a kind chip and a meta line.
    const header = container.querySelector(".clip-inspector .ui-item-header") as HTMLElement;
    expect(header.contains(name)).toBe(true);
    expect(header.querySelector(".ui-item-header__chip")).not.toBeNull();
    expect(header.querySelector(".ui-item-header__meta")!.textContent).toBe("Video · V1 · 40.0 s");
    expect(within(container.querySelector(".clip-inspector") as HTMLElement).queryByText("Inspector")).toBeNull();
    expect(screen.getByRole("button", { name: /Timing/ }).textContent).toContain("00:00 → 40:00");
    // "Starts at" is text, not a read-only field.
    const starts = screen.getByText("Starts at").closest(".ui-prop-row")!;
    expect(starts.querySelector("input")).toBeNull();
    expect(starts.textContent).toContain("00:00:00:00");
    expect((screen.getByLabelText("Duration") as HTMLInputElement).value).toBe("00:00:40:00");

    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "8" } });
    expect(wrote(onChange.mock.calls[0][0], config).timeline.tracks.flatMap((track) => track.clips)[0].durationMs).toBe(8_000);
    fireEvent.change(name, { target: { value: "" } });
    expect(wrote(onChange.mock.calls.at(-1)![0], config).timeline.tracks.flatMap((track) => track.clips)[0].label).toBe("Untitled clip");
    // Transform rows have no spin buttons to speak of and reset to default.
    expect(container.querySelectorAll(".clip-inspector .ui-prop-row").length).toBeGreaterThanOrEqual(6);
  });

  it("resets a transform value from its row", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), { transform: { scale: 150, rotation: 0, positionX: 0, positionY: 0 } });
    const { onChange } = render_(config);
    expect(screen.getByRole("button", { name: /Transform/ }).textContent).toContain("1 changed");
    fireEvent.click(screen.getByRole("button", { name: "Reset Scale" }));
    expect(wrote(onChange.mock.calls[0][0], config).timeline.tracks.flatMap((track) => track.clips)[0].transform?.scale).toBe(100);
  });
});

describe("dragging clips on the timeline", () => {
  it("drags a clip along its own lane and writes where it landed", () => {
    const view = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 2_000, durationMs: 4_000 }]));
    drag(view.container.querySelector(".timeline-clip")!, 100, 300);
    expect(view.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 8_000, durationMs: 4_000 });
  });

  it("drags a clip onto another audiovisual track", () => {
    const view = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }]));
    overLane(view.laneOf("track-v2"));
    drag(view.container.querySelector(".timeline-clip")!, 20, 220);
    expect(view.clipsOn(STORY_TRACK_ID)).toHaveLength(0);
    expect(view.clipsOn("track-v2")[0]).toMatchObject({ startMs: 6_000, trackId: "track-v2" });
    stopHitTesting();
  });

  it("will not lay one clip over another, and snaps to the cut beside it", () => {
    const view = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }, { startMs: 12_000, durationMs: 4_000 }]));
    drag(view.container.querySelectorAll(".timeline-clip")[1], 400, 33);
    expect(view.clipsOn(STORY_TRACK_ID).map((clip) => [clip.startMs, clip.durationMs])).toEqual([[0, 4_000], [4_000, 4_000]]);
  });

  it("draws a snap line while an edge sits on a target, and clears it on release", () => {
    const view = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }, { startMs: 12_000, durationMs: 4_000 }]));
    fireEvent(view.container.querySelectorAll(".timeline-clip")[1], pointerEvent("pointerdown", 400));
    fireEvent(window, pointerEvent("pointermove", 135));
    expect(view.container.querySelector(".timeline-snap")!.textContent).toBe("snap · clip edge");
    fireEvent(window, pointerEvent("pointerup", 135));
    expect(view.container.querySelector(".timeline-snap")).toBeNull();
  });

  it("flags the playhead with its time while it is being scrubbed", () => {
    const { container } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    expect(container.querySelector(".timeline-playhead__flag")).toBeNull();
    fireEvent(container.querySelector(".timeline-playhead__head")!, pointerEvent("pointerdown", 0));
    expect(container.querySelector(".timeline-playhead__flag")!.textContent).toBe("00:00:00:00");
    fireEvent(window, pointerEvent("pointerup", 0));
    expect(container.querySelector(".timeline-playhead__flag")).toBeNull();
  });

  it("trims both ends, and never past the footage", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 6_000, sourceStartMs: 1_000 }]);
    const view = timeline(config);
    drag(view.container.querySelector(".clip-handle--end")!, 200, 100);
    expect(view.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 0, durationMs: 3_000, sourceStartMs: 1_000 });
    cleanup();
    const second = timeline(config);
    drag(second.container.querySelector(".clip-handle--end")!, 200, 1_600);
    expect(second.clipsOn(STORY_TRACK_ID)[0].durationMs).toBe(39_000);
    cleanup();
    const head = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 4_000, durationMs: 6_000, sourceStartMs: 2_000 }]));
    drag(head.container.querySelector(".clip-handle--start")!, 133, 250);
    expect(head.clipsOn(STORY_TRACK_ID)[0]).toMatchObject({ startMs: 7_500, durationMs: 2_500, sourceStartMs: 5_500 });
  });

  it("abandons a drag on Escape and writes nothing", () => {
    const view = timeline(withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 2_000, durationMs: 4_000 }]));
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
    expect(view.container.querySelector(".clip-handle")).toBeNull();
  });
});

describe("editing commands", () => {
  const twoClips = () => withClips(measuredVideo(projectWithMedia(), 40_000), [
    { startMs: 0, durationMs: 4_000, label: "Opening" },
    { startMs: 8_000, durationMs: 4_000, label: "Closing" },
  ]);

  it("deletes a clip from its context menu, with no × on the clip", () => {
    const view = timeline(twoClips());
    expect(view.container.querySelector(".clip-delete")).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Opening,/ }));
    const menu = screen.getByRole("menu", { name: "Opening actions" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.replace(/(Ctrl\+.|F2|Delete)$/, "").trim()))
      .toEqual(["Cut", "Copy", "Paste", "Split at playhead", "Duplicate", "Rename", "Delete"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    expect(view.clipsOn(STORY_TRACK_ID).map((clip) => clip.label)).toEqual(["Closing"]);
  });

  it("deletes the selected clip with the Delete key, but not from a locked track", () => {
    const view = timeline(twoClips());
    press(view.container, "Delete");
    expect(view.clipsOn(STORY_TRACK_ID).map((clip) => clip.label)).toEqual(["Closing"]);
    cleanup();
    const config = parseProjectConfig(completeFixture);
    const firstTrackWithClip = config.timeline.tracks.find((track) => track.clips.length > 0)!;
    const locked = { ...config, timeline: { tracks: config.timeline.tracks.map((track) => track.id === firstTrackWithClip.id ? { ...track, locked: true } : track) } };
    const second = render_(locked);
    press(second.container, "Delete");
    expect(second.onChange).not.toHaveBeenCalled();
    const deleteButton = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.getAttribute("data-tooltip")).toBe("This clip’s track is locked");
  });

  it("keeps a clip's place in the source when it is duplicated (Ctrl+D)", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), { startMs: 0, durationMs: 6_000, sourceStartMs: 12_000 });
    const { container, onChange } = render_(config);
    press(container, "d", { ctrlKey: true });
    const clips = wrote(onChange.mock.calls[0][0], config).timeline.tracks.flatMap((track) => track.clips);
    expect(clips).toHaveLength(2);
    const copy = clips.find((clip) => clip.id !== "clip-macro")!;
    expect(copy).toMatchObject({ sourceStartMs: 12_000, durationMs: 6_000, startMs: 6_000 });
  });

  it("copies and pastes a clip at the playhead", () => {
    const view = timeline(twoClips());
    press(view.container, "End");
    press(view.container, "c", { ctrlKey: true });
    press(view.container, "v", { ctrlKey: true });
    const clips = view.clipsOn(STORY_TRACK_ID);
    expect(clips).toHaveLength(3);
    expect(clips[2]).toMatchObject({ label: "Opening", startMs: 12_000, durationMs: 4_000 });
  });

  it("splits the selected clip at the playhead with Ctrl+K, once the playhead is inside it", () => {
    const config = parseProjectConfig(completeFixture);
    const { container, onChange } = render_(config);
    const split = () => screen.getByRole("button", { name: "Split" }) as HTMLButtonElement;
    expect(split().disabled).toBe(true);
    expect(split().getAttribute("data-tooltip")).toBe("Move the playhead inside the selected clip to split it");
    press(container, "ArrowRight", { shiftKey: true });
    expect(split().disabled).toBe(false);
    expect(split().getAttribute("data-tooltip")).toBe("Split at playhead");
    expect(split().getAttribute("data-tooltip-shortcut")).toBe("Ctrl+K");
    press(container, "k", { ctrlKey: true });
    const clips = wrote(onChange.mock.calls[0][0], config).timeline.tracks.flatMap((track) => track.clips);
    expect(clips.length).toBe(config.timeline.tracks.flatMap((track) => track.clips).length + 1);
  });

  it("says why Duplicate and Delete are unavailable, not just that they are", () => {
    render_(createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 }));
    for (const label of ["Duplicate", "Delete"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("data-tooltip")).toBe(`Select a clip to ${label.toLowerCase()} it`);
    }
  });
});

describe("the transport and the playhead", () => {
  it("moves the playhead on playback ticks before React commits, and keeps paused seeks and zoom aligned", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("timeline-grid-scroll") ? 1180 : 0;
    });
    try {
      const { container } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
      const marker = container.querySelector<HTMLElement>(".timeline-playhead")!;
      expect(marker.style.transform).toBe("translateX(0px)");
      fireEvent.click(screen.getByRole("button", { name: "Play" }));
      const advance = (ms: number, expectedOffset: number) => act(() => {
        now += ms;
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(now));
        // Inside act, React has not committed the scheduled state update yet.
        expect(marker.style.transform).toBe(`translateX(${expectedOffset}px)`);
      });
      advance(1000, 25);
      expect(toolbarTime(container)).toBe("00:00:01:00");
      advance(1000, 50);
      expect(screen.getByRole("button", { name: "Pause" })).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      advance(1000, 50);
      press(container, "ArrowRight", { shiftKey: true });
      expect(marker.style.transform).toBe("translateX(75px)");
      press(container, "=");
      expect(marker.style.transform).toBe("translateX(93.75px)");
      press(container, "j");
      advance(1000, 62.5);
      press(container, "k");
      press(container, "Home");
      expect(marker.style.transform).toBe("translateX(0px)");
    } finally {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("is five flat controls in the NLE order, off with a reason when there is nothing to play", () => {
    const empty = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container, rerender } = render_(empty);
    expect(Array.from(container.querySelectorAll(".timeline-transport > button")).map((el) => el.getAttribute("aria-label")))
      .toEqual(["Go to start", "Previous frame", "Play", "Next frame", "Go to end"]);
    const lead = container.querySelector(".timeline-toolbar__lead")!;
    expect(lead.querySelector("h2")!.textContent).toBe("Timeline");
    expect(container.querySelector(".transport-format")!.textContent).toBe("1920 × 1080 · 24 fps");
    for (const label of ["Go to start", "Play", "Go to end"]) {
      const button = screen.getByRole("button", { name: label }) as HTMLButtonElement;
      expect(button.disabled, label).toBe(true);
      expect(button.getAttribute("data-tooltip"), label).toBe("Nothing to play yet");
    }
    expect(container.querySelector(".play-button")!.className).not.toContain("accent");

    const config = parseProjectConfig(completeFixture);
    rerender(createElement(TimelineView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenGenerator: () => undefined }));
    expect(screen.getByRole("button", { name: "Play" }).getAttribute("data-tooltip-shortcut")).toBe("Space");
    press(container, " ");
    expect(screen.getByRole("button", { name: "Pause" })).not.toBeNull();
    press(container, "k");
    expect(screen.getByRole("button", { name: "Play" })).not.toBeNull();
    press(container, "l");
    press(container, "l");
    expect(container.querySelector(".transport-rate")!.textContent).toBe("2×");
    press(container, "j");
    expect(container.querySelector(".transport-rate")!.textContent).toBe("−1×");
  });

  it("prints HH:MM:SS:FF at the project rate and steps by frames, seconds and cuts", () => {
    const config = withClips(measuredVideo(projectWithMedia(), 40_000), [{ startMs: 0, durationMs: 4_000 }, { startMs: 6_000, durationMs: 2_000 }]);
    const { container } = render_(config);
    expect(toolbarTime(container)).toBe("00:00:00:00");
    press(container, "ArrowRight");
    press(container, "ArrowRight");
    expect(toolbarTime(container)).toBe("00:00:00:02");
    press(container, "ArrowRight", { shiftKey: true });
    expect(toolbarTime(container)).toBe("00:00:01:02");
    press(container, "ArrowDown");
    expect(toolbarTime(container)).toBe("00:00:04:00");
    press(container, "ArrowDown");
    expect(toolbarTime(container)).toBe("00:00:06:00");
    press(container, "ArrowUp");
    expect(toolbarTime(container)).toBe("00:00:04:00");
    press(container, "End");
    expect(toolbarTime(container)).toBe("00:00:08:00");
    press(container, "Home");
    expect(toolbarTime(container)).toBe("00:00:00:00");
  });

  it("seeks to a typed timecode on Enter", () => {
    const { container } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    fireEvent.click(container.querySelector(".transport-time")!);
    const field = screen.getByRole("textbox", { name: "Go to time" });
    fireEvent.change(field, { target: { value: "00:00:12:05" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(toolbarTime(container)).toBe("00:00:12:05");
  });

  it("marks in and out points and shades the range on the ruler", () => {
    const { container } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    press(container, "ArrowRight", { shiftKey: true });
    press(container, "i");
    press(container, "ArrowRight", { shiftKey: true });
    press(container, "ArrowRight", { shiftKey: true });
    press(container, "o");
    const range = container.querySelector(".time-ruler__range") as HTMLElement;
    expect(range.style.left).toBe(`${(1000 / 40_000) * 100}%`);
    expect(range.style.width).toBe(`${(2000 / 40_000) * 100}%`);
    expect(screen.getByLabelText("In to out").textContent).toBe("00:00:02:00");
    expect(container.querySelector(".timeline-range")).not.toBeNull();
    fireEvent.contextMenu(container.querySelector(".time-ruler")!);
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear in and out/ }));
    expect(container.querySelector(".time-ruler__range")).toBeNull();
  });

  it("does not bind undo: Ctrl+Z belongs to the project", () => {
    const config = withClip(measuredVideo(projectWithMedia(), 40_000), {});
    const { container, onChange } = render_(config);
    press(container, "z", { ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("zoom and the wheel", () => {
  /** jsdom lays nothing out: give the scroll area a width so the lanes can be
   *  sized in pixels. 1180px less the 180px header column is 1000px of lane. */
  function withViewport(width: number, body: () => void) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() { return (this as HTMLElement).classList.contains("timeline-grid-scroll") ? width : 0; },
    });
    try { body(); } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    }
  }
  const laneWidth = (container: HTMLElement) => (container.querySelector(".timeline-grid") as HTMLElement).style.width;

  it("opens with up to a minute in view and scrolls anything longer", () => {
    withViewport(1180, () => {
      const short = render_(createProjectConfig({ name: "Short", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 }));
      expect(laneWidth(short.container)).toBe("calc(var(--track-column) + 1000px)");
      cleanup();
      const long = render_(createProjectConfig({ name: "Long", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 120 }));
      expect(laneWidth(long.container)).toBe("calc(var(--track-column) + 2000px)");
    });
  });

  it("zooms with the = and − keys and Ctrl+wheel, and never out past the whole film", () => {
    withViewport(1180, () => {
      const { container } = render_(createProjectConfig({ name: "Long", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 120 }));
      press(container, "=");
      expect(laneWidth(container)).toBe("calc(var(--track-column) + 2500px)");
      for (let step = 0; step < 8; step += 1) press(container, "-");
      expect(laneWidth(container)).toBe("calc(var(--track-column) + 1000px)");
      fireEvent.wheel(container.querySelector(".timeline-grid-scroll")!, { deltaY: -100, ctrlKey: true });
      expect(Number(/\+ ([\d.]+)px/.exec(laneWidth(container))![1])).toBeGreaterThan(1000);
    });
  });

  it("leaves a plain wheel to scroll the tracks instead of scrubbing", () => {
    const { container } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    const wheel = createEvent.wheel(container.querySelector(".timeline-grid-scroll")!, { deltaY: 100 });
    fireEvent(container.querySelector(".timeline-grid-scroll")!, wheel);
    expect(wheel.defaultPrevented).toBe(false);
    expect(toolbarTime(container)).toBe("00:00:00:00");
  });

  it("collapses the side panes from the toolbar and remembers it", () => {
    const { container } = render_(projectWithMedia());
    fireEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(container.querySelector(".clip-inspector")).toBeNull();
    expect(container.querySelector(".edit-panels--no-inspector")).not.toBeNull();
    cleanup();
    const again = render_(projectWithMedia());
    expect(again.container.querySelector(".clip-inspector")).toBeNull();
    expect(screen.getAllByRole("separator", { name: /Resize/ }).map((splitter) => splitter.getAttribute("aria-label")))
      .toEqual(["Resize media panel", "Resize timeline", "Resize track headers"]);
  });
});

describe("the program monitor", () => {
  it("magnifies the preview up to 400% and returns to Fit without editing the timeline", () => {
    const { container, onChange } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    const stage = container.querySelector<HTMLElement>(".program-stage")!;
    const canvas = container.querySelector<HTMLElement>(".program-canvas")!;
    Object.defineProperties(canvas, { clientWidth: { value: 960 }, clientHeight: { value: 540 } });
    fireEvent.click(screen.getByRole("combobox", { name: "Monitor zoom" }));
    fireEvent.click(screen.getByRole("option", { name: "200%" }));
    expect(stage.style.width).toBe("3840px");
    expect(stage.style.height).toBe("2160px");
    expect(canvas.scrollLeft).toBe(1440);
    expect(canvas.scrollTop).toBe(810);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in preview" }));
    expect(stage.style.width).toBe("7680px");
    expect((screen.getByRole("button", { name: "Zoom in preview" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out preview" }));
    expect(stage.style.width).toBe("5760px");
    fireEvent.click(screen.getByRole("combobox", { name: "Monitor zoom" }));
    fireEvent.click(screen.getByRole("option", { name: "25%" }));
    expect((screen.getByRole("button", { name: "Zoom out preview" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("combobox", { name: "Monitor zoom" }));
    fireEvent.click(screen.getByRole("option", { name: "Fit" }));
    expect(stage.style.width).toBe("");
    expect(stage.style.height).toBe("");
    expect(canvas.scrollLeft).toBe(0);
    expect(canvas.scrollTop).toBe(0);
    expect(canvas.classList.contains("program-canvas--zoomed")).toBe(false);
    expect(toolbarTime(container)).toBe("00:00:00:00");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("zooms around the pointer with Ctrl+wheel and leaves plain wheel scrolling available", () => {
    const { container, onChange } = render_(withClip(measuredVideo(projectWithMedia(), 40_000), {}));
    const canvas = container.querySelector<HTMLElement>(".program-canvas")!;
    const stage = container.querySelector<HTMLElement>(".program-stage")!;
    Object.defineProperties(canvas, { clientWidth: { value: 960 }, clientHeight: { value: 540 } });
    const wheel = createEvent.wheel(canvas, { deltaY: -100, ctrlKey: true, clientX: 240, clientY: 135 });
    fireEvent(canvas, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(stage.style.width).toBe("1440px");
    expect(canvas.scrollLeft).toBe(120);
    expect(canvas.scrollTop).toBe(67.5);
    const plainWheel = createEvent.wheel(canvas, { deltaY: 100 });
    fireEvent(canvas, plainWheel);
    expect(plainWheel.defaultPrevented).toBe(false);
    expect(stage.style.width).toBe("1440px");
    fireEvent.wheel(canvas, { deltaY: 100, ctrlKey: true, clientX: 240, clientY: 135 });
    expect(stage.style.width).toBe("960px");
    expect(canvas.scrollLeft).toBe(0);
    expect(canvas.scrollTop).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a muted line on an empty timeline and a footer with time, duration, zoom and safe areas", () => {
    const { container } = render_(projectWithMedia());
    const empty = container.querySelector(".program-empty") as HTMLElement;
    expect(within(empty).getByText("Nothing on the timeline yet")).toBeTruthy();
    expect(within(empty).getByText("Drop media on a track, or generate a scene.")).toBeTruthy();
    expect(within(empty).getByRole("button", { name: "Import media" })).toBeTruthy();
    expect(container.querySelector(".program-panel h2:not(.sr-only), .program-panel header")).toBeNull();
    const footer = container.querySelector(".program-footer") as HTMLElement;
    expect(within(footer).queryByText("Playhead")).toBeNull();
    expect(within(footer).getByText("Duration")).toBeTruthy();
    expect(within(footer).queryByText("In–out")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Monitor zoom" }).textContent).toContain("Fit");
    fireEvent.click(screen.getByRole("button", { name: "Safe areas" }));
    expect(container.querySelector(".program-safe")).not.toBeNull();
    fireEvent.click(screen.getByRole("combobox", { name: "Monitor zoom" }));
    fireEvent.click(screen.getByRole("option", { name: "50%" }));
    expect((container.querySelector(".program-stage") as HTMLElement).style.width).toBe("960px");
  });
});

describe("measuring media", () => {
  it("records the length the media panel actually measured onto the asset", async () => {
    const seen: ProjectConfig[] = [];
    function Harness({ initial }: { initial: ProjectConfig }) {
      const [config, setConfig] = useState(initial);
      useEffect(() => { seen.push(config); }, [config]);
      return createElement(TimelineView, { config, folderPath: "C:\\Measured Project", onChange: setConfig, onOpenGenerator: () => undefined });
    }
    await withFakeDecoder({ seconds: 40, width: 1920, height: 1080 }, async () => {
      render(createElement(Harness, { initial: projectWithMedia() }));
      fireEvent.click(screen.getByRole("tab", { name: "Media" }));
      await waitFor(() => expect(seen.at(-1)!.assets.every((asset) => asset.durationMs !== null)).toBe(true), { timeout: 8_000 });
    });
    const final = seen.at(-1)!;
    expect(final.assets.find((asset) => asset.kind === "video")!.durationMs).toBe(40_000);
    expect(final.assets.find((asset) => asset.kind === "audio")!.durationMs).toBe(40_000);
    const settled = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.length).toBe(settled);
  }, 20_000);

  it("keeps a measurement that lands before the one before it has come back down", async () => {
    const config = projectWithMedia();
    const onChange = vi.fn();
    await withStagedDecoder({ seconds: 40, width: 1920, height: 1080 }, async (stage) => {
      render(createElement(TimelineView, { config, folderPath: "C:\\Staged Project", onChange, onOpenGenerator: () => undefined }));
      fireEvent.click(screen.getByRole("tab", { name: "Media" }));
      await stage.opened(2);
      await stage.settle(0);
      await stage.settle(1);
    });
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(2);
    const folded = onChange.mock.calls.reduce(
      (current: ProjectConfig, call) => typeof call[0] === "function" ? (call[0] as (value: ProjectConfig) => ProjectConfig)(current) : call[0] as ProjectConfig,
      config,
    );
    expect(folded.assets.map((asset) => [asset.name, asset.durationMs])).toEqual([["Macro footage", 40_000], ["Room tone", 40_000]]);
  }, 20_000);
});
