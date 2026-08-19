// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectConfig, type TimelineClip } from "../../lib/project";
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

  it("says outright that the file will have no sound", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("video only — see below")).toBeTruthy();
  });

  it("blocks on an empty timeline rather than offering to render nothing", () => {
    render(<ExportView config={project([])} folderPath="/tmp/project" />);
    expect(screen.getByRole("alert").textContent).toContain("no video clips");
    expect(screen.getByText(/nothing on the timeline yet/i)).toBeTruthy();
  });
});
