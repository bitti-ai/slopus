// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, STORY_TRACK_ID, type ProjectConfig, type TimelineClip } from "../../lib/project";
import { ProgramMonitor } from "./ProgramMonitor";
import { PreviewSources } from "../../lib/exportPipeline";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => { vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/* jsdom decodes nothing: it has no media pipeline, so no test here can prove a
   frame reached the screen. What it CAN prove is everything around the picture
   — which clip the playhead is over, which file that clip's element is pointed
   at, and what the monitor says when there is no picture to show. The decode
   itself is the webview's, and the one thing Slopus does not implement. */

const clip = (over: Partial<TimelineClip> = {}): TimelineClip => ({
  id: "clip-1", assetId: "asset-macro", trackId: STORY_TRACK_ID,
  startMs: 2_000, durationMs: 4_000, sourceStartMs: 8_000,
  label: "Macro footage", color: null, status: "approved", ...over,
});

const project = (clips: TimelineClip[]): ProjectConfig => {
  const fresh = createProjectConfig({ name: "Ceramic lamp", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
  return parseProjectConfig({
    ...fresh,
    assets: [{
      id: "asset-macro", kind: "video", name: "Macro footage", sourcePath: "D:/rushes/macro.mp4",
      mimeType: "video/mp4", durationMs: 40_000, width: 1920, height: 1080, createdAt: fresh.createdAt,
    }],
    timeline: { tracks: fresh.timeline.tracks.map((track) => track.id === STORY_TRACK_ID ? { ...track, clips } : track) },
  });
};

const monitor = (config: ProjectConfig, playheadMs: number) => render(
  <ProgramMonitor
    config={config}
    folderPath="C:\\Ceramic Lamp"
    playheadMs={playheadMs}
    playing={false}
    onSeek={() => undefined}
    onPlayingChange={() => undefined}
  />,
);

describe("the program monitor", () => {
  it.each([false, true])("prepares the next trim before a cut and promotes its decoder without seeking (same asset: %s)", async (sameAsset) => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const read = vi.spyOn(PreviewSources.prototype, "url").mockImplementation(async (asset) => `blob:${asset.id}`);
    const playingElements = new WeakSet<HTMLMediaElement>();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
      playingElements.add(this);
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { playingElements.delete(this); });
    vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) { return !playingElements.has(this); });
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    const seek = vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set");
    let now = 0, nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
    const cancel = vi.fn((id: number) => frames.delete(id));
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const first = clip({ startMs: 0, durationMs: 1_000, sourceStartMs: 0 });
    const second = clip({ id: "clip-2", assetId: sameAsset ? first.assetId : "second-asset", startMs: 1_000, sourceStartMs: 8_000 });
    const config = project([first, second]);
    if (!sameAsset) config.assets.push({ ...config.assets[0], id: "second-asset", sourcePath: "D:/second.mp4" });
    const positions = vi.fn();
    function Harness() {
      const [position, setPosition] = useState(0);
      return <ProgramMonitor config={config} folderPath="C:\\Film" playheadMs={position} playing
        onSeek={(value) => { positions(value); setPosition(value); }} onPlayingChange={() => undefined} />;
    }
    const view = render(<Harness />);
    await act(async () => undefined);
    const incoming = view.container.querySelector<HTMLVideoElement>('[data-clip-id="clip-2"] video')!;
    expect(incoming.currentTime).toBe(8);
    expect(incoming.paused).toBe(true);
    expect(incoming.muted).toBe(true);
    expect(incoming.parentElement!.style.visibility).toBe("hidden");
    fireEvent.loadedData(incoming);
    const reads = read.mock.calls.length;
    seek.mockClear(); play.mockClear(); cancel.mockClear();
    // The display tick falls just past the cut. Keep that residual time and
    // start the frame already decoded at the trim, without another seek/load.
    await act(async () => {
      now = 1_016;
      const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback(now));
    });
    expect(positions).toHaveBeenLastCalledWith(1_016);
    expect(cancel).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-clip-id="clip-2"] video')).toBe(incoming);
    expect(incoming.parentElement!.style.visibility).toBe("visible");
    expect(incoming.paused).toBe(false);
    expect(incoming.muted).toBe(false);
    expect(seek).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(screen.queryByText(/Loading/)).toBeNull();
    expect(view.container.querySelectorAll("video")).toHaveLength(1);
  });

  it("keeps upcoming media silent through a gap and applies the latest scrub after a pending seek", async () => {
    vi.spyOn(PreviewSources.prototype, "url").mockImplementation(async (asset) => `blob:${asset.id}`);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    let seeking = false;
    vi.spyOn(HTMLMediaElement.prototype, "seeking", "get").mockImplementation(() => seeking);
    const config = project([clip()]);
    const props = { config, folderPath: "C:\\Film", playing: false, onSeek: vi.fn(), onPlayingChange: vi.fn() };
    const view = render(<ProgramMonitor {...props} playheadMs={0} />);
    await act(async () => undefined);
    const video = view.container.querySelector("video")!;
    expect(video.currentTime).toBe(8);
    expect(video.muted).toBe(true);
    expect(video.parentElement!.style.visibility).toBe("hidden");
    view.rerender(<ProgramMonitor {...props} playheadMs={3_000} />);
    expect(video.currentTime).toBe(9);
    seeking = true;
    view.rerender(<ProgramMonitor {...props} playheadMs={4_000} />);
    view.rerender(<ProgramMonitor {...props} playheadMs={5_000} />);
    expect(video.currentTime).toBe(9);
    seeking = false;
    fireEvent.seeked(video);
    expect(video.currentTime).toBe(11);
    expect(view.container.querySelector("video")).toBe(video);
  });

  it.each([0, 2_000])("continues the longer track at its timeline position after the foreground ends (source offset %i)", async (sourceStartMs) => {
    vi.spyOn(PreviewSources.prototype, "url").mockImplementation(async (asset) => `blob:${asset.id}`);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const ready = new WeakSet<HTMLMediaElement>();
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockImplementation(function (this: HTMLMediaElement) {
      return ready.has(this) ? 4 : 0;
    });
    let now = 0;
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const advance = async (ms: number) => {
      await act(async () => {
        now += ms;
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(now));
      });
    };
    const config = project([clip({ startMs: 0, sourceStartMs: 0, look: { opacity: 50, temperature: 0 } })]);
    config.assets.push({ ...config.assets[0], id: "asset-long", sourcePath: "D:/rushes/long.mp4" });
    config.timeline.tracks.push({
      ...config.timeline.tracks.find((track) => track.id === STORY_TRACK_ID)!,
      id: "long-track",
      clips: [clip({ id: "long-clip", assetId: "asset-long", trackId: "long-track", startMs: 0, durationMs: 10_000, sourceStartMs })],
    });
    const onPlayingChange = vi.fn();
    function Harness() {
      const [playhead, setPlayhead] = useState(0);
      const [playing, setPlaying] = useState(true);
      return <ProgramMonitor config={config} folderPath="C:\\Film" playheadMs={playhead} playing={playing}
        onSeek={setPlayhead} onPlayingChange={(value) => { onPlayingChange(value); setPlaying(value); }} />;
    }
    const { container } = render(<Harness />);
    await act(async () => undefined);
    const video = container.querySelector<HTMLVideoElement>('[data-clip-id="long-clip"] video')!;
    expect(container.querySelectorAll("video")).toHaveLength(2);
    for (const element of container.querySelectorAll("video")) {
      ready.add(element);
      fireEvent.loadedMetadata(element);
      fireEvent.loadedData(element);
    }

    await advance(4_000);
    expect(video.getAttribute("src")).toBe("blob:asset-long");
    expect(container.querySelectorAll("video")).toHaveLength(1);
    // Promoting the lower layer must preserve its existing decoder and src.
    expect(container.querySelector('[data-clip-id="long-clip"] video')).toBe(video);
    await advance(500);
    expect(video.currentTime).toBe((4_500 + sourceStartMs) / 1000);
    expect(onPlayingChange).not.toHaveBeenCalled();

    await advance(5_000);
    expect(video.isConnected).toBe(true);
    expect(onPlayingChange).not.toHaveBeenCalled();
    await advance(500);
    expect(onPlayingChange).toHaveBeenCalledWith(false);
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows move, scale, and rotate widgets after the timeline picture is selected", () => {
    const config = project([clip()]);
    function Harness() {
      // The clip already being selected on the timeline must not show handles;
      // the click on the picture below is the explicit direct-edit action.
      const [selected, setSelected] = useState<string | null>("clip-1");
      return <ProgramMonitor
        config={config}
        folderPath="C:\\Ceramic Lamp"
        playheadMs={3_000}
        playing={false}
        onSeek={() => undefined}
        onPlayingChange={() => undefined}
        selectedClipId={selected}
        onSelectClip={setSelected}
        onTransformChange={() => undefined}
      />;
    }
    const { container } = render(<Harness />);
    expect(screen.queryByRole("group", { name: "Transform Macro footage" })).toBeNull();
    fireEvent.click(container.querySelector(".program-picture")!);
    expect(screen.getByRole("group", { name: "Transform Macro footage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scale clip" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotate clip" })).toBeTruthy();
  });

  it("shows a gap as the empty frame it will be exported as, and says nothing about it", () => {
    const { container } = monitor(project([clip()]), 9_000);
    // No element for a clip that is not there, and no panel over the picture
    // either: the background colour IS the answer, and it is the same colour
    // the encoder writes for those frames.
    expect(document.querySelector("video")).toBeNull();
    expect(container.querySelector(".program-note")).toBeNull();
    expect((container.querySelector(".program-picture") as HTMLElement).style.backgroundColor).toBeTruthy();
  });

  it("is honest that the browser preview cannot read the project's footage", () => {
    // The clip IS under the playhead here; what is missing is the desktop shell
    // that reads files, and saying so beats a black rectangle.
    monitor(project([clip()]), 3_000);
    expect(screen.getByText(/Playback needs the desktop app/)).toBeTruthy();
  });

  it("waits for the file rather than claiming a picture it has not got", () => {
    // With a Tauri shell present the read is attempted; the mocked invoke never
    // resolves to bytes, so the monitor stays on "loading" instead of showing
    // an empty frame as though that were the shot.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    monitor(project([clip()]), 3_000);
    expect(screen.getByText(/Loading Macro footage/)).toBeTruthy();
  });

  it("shows nothing at all over an empty timeline", () => {
    const { container } = monitor(project([]), 0);
    expect(container.querySelector(".program-note")).toBeNull();
    expect(container.querySelector(".program-picture")).not.toBeNull();
  });

  it("advances from its local animation clock when renders are delayed", () => {
    const frames: FrameRequestCallback[] = [];
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onSeek = vi.fn();
    render(<ProgramMonitor
      config={project([clip({ startMs: 0, sourceStartMs: 0 })])}
      folderPath="C:\\Ceramic Lamp"
      playheadMs={0}
      playing
      onSeek={onSeek}
      onPlayingChange={() => undefined}
    />);

    act(() => { now = 16; frames.shift()?.(now); });
    act(() => { now = 32; frames.shift()?.(now); });
    expect(onSeek.mock.calls.map(([position]) => position)).toEqual([16, 32]);
  });

  it("preserves fractional display ticks instead of accumulating rounding drift", () => {
    let nextFrame: FrameRequestCallback | undefined;
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const config = project([clip({ startMs: 0, sourceStartMs: 0 })]);
    const onSeek = vi.fn();
    function Harness() {
      const [position, setPosition] = useState(0);
      return <ProgramMonitor config={config} folderPath="C:\\Film" playheadMs={position} playing
        onSeek={(value) => { onSeek(value); setPosition(value); }} onPlayingChange={() => undefined} />;
    }
    render(<Harness />);
    for (let frame = 1; frame <= 60; frame++) {
      act(() => { now = frame * 1000 / 60; nextFrame?.(now); });
    }
    expect(onSeek).toHaveBeenLastCalledWith(1000);
  });
});
