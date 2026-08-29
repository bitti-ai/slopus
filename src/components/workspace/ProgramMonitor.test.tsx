// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, STORY_TRACK_ID, type ProjectConfig, type TimelineClip } from "../../lib/project";
import { ProgramMonitor } from "./ProgramMonitor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

/* jsdom decodes nothing: it has no media pipeline, so no test here can prove a
   frame reached the screen. What it CAN prove is everything around the picture
   — which clip the playhead is over, which file that clip's element is pointed
   at, and what the monitor says when there is no picture to show. The decode
   itself is the webview's, and the one thing PolStudio does not implement. */

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
  it("shows move, scale, and rotate widgets after the timeline picture is selected", () => {
    const config = project([clip()]);
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
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
});
