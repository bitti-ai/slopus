// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import audioFixture from "../../../fixtures/project-v1-audio-mix.json";
import externalFixture from "../../../fixtures/project-v1-external-media.json";
import { createProjectConfig, parseProjectConfig, type ProjectConfig, type TimelineClip } from "../../lib/project";
import { ExportView } from "./ExportView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

const clip = (id: string, startMs: number, durationMs: number): TimelineClip => ({
  id, assetId: `asset-${id}`, trackId: "track-story", startMs, durationMs,
  sourceStartMs: 0, label: id, color: null, status: "approved",
});

function project(clips: TimelineClip[]): ProjectConfig {
  const base = createProjectConfig({
    name: "Northern Light", prompt: "A test", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30,
  });
  return {
    ...base,
    assets: clips.map((item) => ({
      id: item.assetId, kind: "video" as const, name: item.label,
      relativePath: `media/${item.id}.mp4`, mimeType: "video/mp4",
      durationMs: 10_000, width: 1920, height: 1080, createdAt: base.createdAt,
    })),
    timeline: {
      tracks: base.timeline.tracks.map((track) => ({ ...track, clips: clips.filter((item) => item.trackId === track.id) })),
    },
  };
}

/* These run in jsdom, which has neither WebCodecs nor a Tauri shell — the exact
   conditions the view has to be honest about rather than paper over. */
describe("the export view where nothing can encode", () => {
  it("refuses to offer an export it cannot perform, and says why", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    const button = screen.getByRole("button", { name: /export video/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const reasons = screen.getByRole("alert").textContent ?? "";
    expect(reasons).toContain("browser preview");
    expect(reasons).toContain("WebCodecs");
  });

  it("shows a labelled empty stage instead of a picture it cannot decode", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText(/labelled empty stage/i)).toBeTruthy();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("states the real duration, clip count and frame size of the planned file", () => {
    render(<ExportView config={project([clip("a", 0, 2_000), clip("b", 2_000, 1_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("00:03.000")).toBeTruthy();
    expect(screen.getByText("90 frames at 30 fps")).toBeTruthy();
    expect(screen.getByText("1920 × 1080")).toBeTruthy();
  });

  it("says outright that a timeline with no audio clips produces no sound", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("no audio clips on the timeline")).toBeTruthy();
  });

  it("blocks on an empty timeline rather than offering to render nothing", () => {
    render(<ExportView config={project([])} folderPath="/tmp/project" />);
    expect(screen.getByRole("alert").textContent).toContain("no video clips");
    expect(screen.getByText(/nothing on the timeline yet/i)).toBeTruthy();
  });
});

/* The other half of the media policy: video is NOT copied into the project, so
   a real timeline's clips carry an absolute source path and no relative one.
   The page has to plan such a project exactly as it plans any other — the
   previous build did, and then the run died on the first read. */
describe("the export view on media the project does not contain", () => {
  const external = () => parseProjectConfig(externalFixture);

  it("plans the external clip instead of calling it missing media", () => {
    render(<ExportView config={external()} folderPath="D:\\tmp\\news\\News broadcast" />);
    const reasons = screen.getByRole("alert").textContent ?? "";
    expect(reasons).not.toMatch(/not in this project/i);
    expect(reasons).not.toMatch(/no file recorded/i);
    expect(screen.getByText("00:12.000")).toBeTruthy();
    expect(screen.getByText("360 frames at 30 fps")).toBeTruthy();
  });
});

/* The mix is built whole in memory before the file is opened and held until the
   last frame — 23 MB a minute, 1.4 GB for an hour — and the panel that states
   bitrate, size estimate, compositor and codec said nothing at all about it. */
describe("what the page says the soundtrack will cost", () => {
  const withAudioSupport = (body: () => void) => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = { AudioEncoder: scope.AudioEncoder, AudioData: scope.AudioData, OfflineAudioContext: scope.OfflineAudioContext };
    // detectExportSupport asks for exactly these three; nothing here calls them.
    scope.AudioEncoder = class {};
    scope.AudioData = class {};
    scope.OfflineAudioContext = class {};
    try {
      body();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete scope[name];
        else scope[name] = value;
      }
    }
  };

  it("states the memory the mix holds, next to the bitrate and the size estimate", () => {
    withAudioSupport(() => {
      render(<ExportView config={parseProjectConfig(audioFixture)} folderPath="D:\\tmp\\harbour" />);
      // Two clips on an unmuted audio track; the third is on a muted one.
      expect(screen.getByText("AAC · 2 clips mixed")).toBeTruthy();
      expect(screen.getByText(/1\.5 MB of memory held while it renders/)).toBeTruthy();
    });
  });

  it("says nothing about a mix it is not going to make", () => {
    // No AudioEncoder here, so there is no mix and no memory to disclose —
    // stating a cost that will not be paid would be its own kind of lie.
    render(<ExportView config={parseProjectConfig(audioFixture)} folderPath="D:\\tmp\\harbour" />);
    expect(screen.getByText("this webview has no AudioEncoder")).toBeTruthy();
    expect(screen.queryByText(/of memory held while it renders/)).toBeNull();
  });
});

describe("what the page claims about the compositor", () => {
  it("does not promise WebGPU before anything has asked for an adapter", async () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    // jsdom has no navigator.gpu, so the settled answer is the 2D canvas with a
    // stated reason. What must never appear is a bare WebGPU promise.
    expect(await screen.findByText(/no navigator\.gpu/i)).toBeTruthy();
    expect(screen.queryByText("WebGPU")).toBeNull();
    // The heading no longer carries a prose paragraph; the compositor row is
    // where the settled answer is stated now.
    expect(document.body.textContent).toContain("2D canvas");
  });
});
