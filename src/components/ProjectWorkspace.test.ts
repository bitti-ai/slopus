// @vitest-environment jsdom

import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import { compileMiniMaxH3Prompt, createProjectConfig, parseProjectConfig, STORY_TRACK_ID, type ProjectAsset, type ProjectConfig } from "../lib/project";
import { formatDurationTimecode } from "./ProjectWorkspace";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { GeneratorView } from "./workspace/GeneratorView";
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

  it("keeps the transport on the timeline, with one timecode and one reason", () => {
    const empty = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container, rerender } = render(createElement(TimelineView, { config: empty, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenGenerator: () => undefined }));

    // It sits in the timeline toolbar now, not under the program monitor.
    expect(container.querySelector(".monitor-transport")).toBeNull();
    expect(container.querySelector(".timeline-toolbar .timeline-transport")).not.toBeNull();
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
    expect(screen.getByText("1 reference guides this shot")).not.toBeNull();
    expect(screen.queryByText("3 references guide this shot")).toBeNull();
    // Skipped references stay visible, each with its reason.
    expect(screen.getByText("Lead character")).not.toBeNull();
    expect(screen.getByText("Not described yet — not used by this shot")).not.toBeNull();
    expect(screen.getByText(/sound note/)).not.toBeNull();
  });

  it("renames a shot, and never saves it nameless", () => {
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const onChange = vi.fn();
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const field = screen.getByRole("textbox", { name: "Rename First scene" });
    fireEvent.change(field, { target: { value: "Clay on the wheel" } });
    expect(onChange.mock.calls[0][0].generationJobs[0].title).toBe("Clay on the wheel");
    // The schema has no room for an empty title, so an emptied field falls back.
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange.mock.calls[1][0].generationJobs[0].title).toBe("Untitled shot");
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
    expect(screen.queryByText("1 reference guides this shot")).toBeNull();
    expect(screen.getByText("No references used by this shot")).not.toBeNull();
    expect(screen.getByText("The video engine only follows the words above.")).not.toBeNull();
    // The claim that a text definition is written into the prompt must not
    // appear when nothing is written into it.
    expect(screen.queryByText(/text definitions are written into this shot/)).toBeNull();
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
    expect(document.querySelector(".job-refs")!.textContent).toContain("The text definition is written into this shot’s prompt.");
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

  /** Opens one tag group inside ONE picker and ticks one of its options. The
   *  generator shows two pickers at once — the shot being written and the shot
   *  selected — so every query here has to say which. */
  function pickTag(scope: HTMLElement, group: string, option: string) {
    fireEvent.click(within(scope).getByRole("button", { name: new RegExp(`^${group}`) }));
    fireEvent.click(within(scope).getByRole("button", { name: option, pressed: false }));
  }

  it("calls the authoring section “Describe the shot”, on a new shot and an old one", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    // With a shot selected this heading used to rename itself to "Write another
    // shot", which read as a footnote to the shot above rather than as the
    // place shots are made.
    for (const config of [parseProjectConfig({ ...fresh, generationJobs: [] }), fresh]) {
      const { unmount } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
      expect(screen.getByRole("heading", { name: "Describe the shot" })).not.toBeNull();
      expect(screen.queryByText("Write another shot")).toBeNull();
      // And it says which surface authors a shot and which one edits one, so
      // the dock at the bottom of the window is not mistaken for this.
      expect(document.querySelector(".generation-composer__lede")!.textContent).toContain("changing a shot that already exists");
      unmount();
    }
  });

  it("builds a new shot from tags as well as prose, and shows the prompt first", () => {
    localStorage.clear();
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const onChange = vi.fn();
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined }));
    fireEvent.change(container.querySelector(".generation-composer textarea")!, { target: { value: "hands shaping wet clay on a spinning wheel" } });

    const composer = container.querySelector(".generation-composer") as HTMLElement;
    pickTag(composer, "Camera movement", "Push in");
    // Speed and amplitude only mean something once a movement exists, so they
    // are offered only after one is chosen — the compiler drops them otherwise.
    pickTag(composer, "Movement speed", "Slow");

    // The compiled prompt is on screen BEFORE anything is committed, and the
    // words the user typed are still marked as theirs.
    expect(composer.querySelector(".compiled-prompt__text")!.textContent).toContain("Camera movement: push in, slow speed.");
    expect(composer.querySelector(".prompt-part--brief")!.textContent).toBe("hands shaping wet clay on a spinning wheel");
    expect([...composer.querySelectorAll(".prompt-part--tag")].map((part) => part.textContent)).toContain("push in, slow speed");
    // The tag terms are NOT dressed up as the user's own writing.
    expect(composer.querySelector(".prompt-part--brief")!.textContent).not.toContain("push in");

    fireEvent.click(screen.getByRole("button", { name: /Save as a draft|Generate/ }));
    const created = onChange.mock.calls[0][0].generationJobs[0];
    expect(created.shotTags).toEqual({ cameraMovement: ["push-in"], cameraSpeed: ["slow"] });
    expect(created.compiledPrompt).toContain("Camera movement: push in, slow speed.");
    // The whole config still validates, so this is a shot that can be saved.
    expect(parseProjectConfig(onChange.mock.calls[0][0])).toBeTruthy();
  });

  it("refuses movement speed until there is a movement for it to qualify", () => {
    localStorage.clear();
    const config = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
    // Not merely disabled — it says why, the way every other blocked control on
    // this screen does.
    const composer = container.querySelector(".generation-composer") as HTMLElement;
    const speed = within(composer).getByRole("button", { name: /^Movement speed/ }) as HTMLButtonElement;
    expect(speed.disabled).toBe(true);
    expect(speed.textContent).toContain("Needs a camera movement first");
  });

  it("reopens an existing shot's tags so they can be adjusted", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], shotTags: { lens: ["macro-lens"] } }] });
    const onChange = vi.fn();
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    // The saved tag is reported in the terms it puts in the prompt, not a
    // paraphrase of them.
    const shotTags = container.querySelector(".job-tags") as HTMLElement;
    expect(screen.getByText("1 tag shapes this shot")).not.toBeNull();
    expect(within(shotTags).getByRole("button", { name: /^Lens/ }).textContent).toContain("macro lens");
    expect(container.querySelector(".compiled-prompt__text")!.textContent).toContain("macro lens, A quiet product film");

    pickTag(shotTags, "Lens", "Telephoto");
    expect(onChange.mock.calls[0][0].generationJobs[0].shotTags).toEqual({ lens: ["telephoto-lens"] });
  });

  it("locks a running shot's tags, because the engine already has the prompt", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.4, shotTags: { lens: ["macro-lens"] } }] });
    const { container } = render(createElement(GeneratorView, { config, folderPath: "C:\\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined, selectedJobId: config.generationJobs[0].id }));
    const shotTags = container.querySelector(".job-tags") as HTMLElement;
    expect((within(shotTags).getByRole("button", { name: /^Lens/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Its tags can be changed once it finishes/)).not.toBeNull();
  });

  it("labels a cancelled preview as cancelled instead of queued", () => {
    const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const config = parseProjectConfig({ ...fresh, generationJobs: [{ ...fresh.generationJobs[0], status: "cancelled", stage: "failed" }] });
    render(createElement(GeneratorView, { config, folderPath: "C:\Ceramic Lamp", onChange: () => undefined, onOpenTimeline: () => undefined }));
    expect(screen.getByText("Generation cancelled")).not.toBeNull();
    expect(screen.queryByText("Waiting in queue")).toBeNull();
  });
});
