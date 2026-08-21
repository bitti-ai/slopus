// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
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

  it("says why there is no picture rather than showing an empty stage as though it were one", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    // The preview is the same player the timeline uses, and in a browser there
    // is no project folder for it to read the footage from.
    expect(screen.getByText(/Playback needs the desktop app/i)).toBeTruthy();
    expect(document.querySelector("canvas")).toBeNull();
    // The controls are there and are honest about what they can do: there IS
    // something on this timeline, so play is offered.
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Watch fullscreen" })).toBeTruthy();
  });

  it("states the real duration of the planned file", () => {
    render(<ExportView config={project([clip("a", 0, 2_000), clip("b", 2_000, 1_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("00:03.000")).toBeTruthy();
    expect(screen.getByText("72 frames at 24 fps")).toBeTruthy();
    /* The frame size is named where it is CHOSEN — in the resolution select —
       rather than repeated in a summary row beside it. */
    expect((screen.getByLabelText("Resolution") as HTMLSelectElement).selectedOptions[0].textContent).toBe("1920 × 1080");
  });

  it("says outright that a timeline with no audio clips produces no sound", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("no audio clips on the timeline")).toBeTruthy();
  });

  it("blocks on an empty timeline rather than offering to render nothing", () => {
    render(<ExportView config={project([])} folderPath="/tmp/project" />);
    expect(screen.getByRole("alert").textContent).toContain("no video clips");
    expect(screen.getByText(/nothing on the timeline yet/i)).toBeTruthy();
    // Nothing to play, and the transport says so instead of sitting live.
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("puts the one control the screen exists for beside its title", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    const heading = container.querySelector(".export-heading")!;
    expect(within(heading as HTMLElement).getByRole("button", { name: /export video/i })).toBeTruthy();
  });

  it("says none of the prose it used to carry about how exporting works", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    for (const gone of ["True of this export", "opens your computer", "this project’s original size"]) {
      expect(container.textContent, gone).not.toContain(gone);
    }
    // And none of the summary rows that repeated a setting back at the user.
    for (const row of ["Clips", "Frame", "Bitrate"]) {
      expect(within(container.querySelector(".export-summary") as HTMLElement).queryByText(row)).toBeNull();
    }
  });
});

/* The screen used to size its own preview from whatever was under the playhead
   and to confirm a finished export with a panel in the bottom corner naming the
   path, the size, the codec and the compositor. */
describe("the shape of the export screen", () => {
  it("names its two panels after what they hold", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByRole("heading", { name: "Video" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Preview" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Export Settings" })).toBeNull();
  });

  it("gives the estimated size as a size and nothing else", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    const row = within(container.querySelector(".export-summary") as HTMLElement)
      .getByText("Estimated size").parentElement!;
    expect(row.querySelector("dd")!.textContent).toMatch(/^[\d.]+ [KMG]?B$/);
    expect(row.querySelector("dd small")).toBeNull();
  });

  /* A portrait still on the timeline used to make this box tall and the next
     video clip shrank it back, because the stage had no size of its own and
     took the intrinsic shape of whatever was playing. The export writes ONE
     frame size for the whole file. */
  it("sizes the stage from the export plan rather than from the media under the playhead", () => {
    const portrait = project([clip("a", 0, 2_000)]);
    portrait.assets[0] = { ...portrait.assets[0], kind: "image", mimeType: "image/png", width: 1080, height: 1920 };
    const { container } = render(<ExportView config={portrait} folderPath="/tmp/project" />);
    const stage = container.querySelector(".export-stage") as HTMLElement;
    // The project is 16:9 at 1080p; the picture inside it is not.
    expect(stage.style.aspectRatio).toBe("1920 / 1080");
  });

  it("says nothing about a finished export until there is one", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(container.querySelector(".export-toast")).toBeNull();
    // And the notification lives in the header, not at the foot of the settings
    // column where the old panel sat.
    expect(container.querySelector(".export-heading .export-toast-slot")).toBeTruthy();
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
