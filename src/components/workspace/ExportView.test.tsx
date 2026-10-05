// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import audioFixture from "../../../fixtures/project-v1-audio-mix.json";
import externalFixture from "../../../fixtures/project-v1-external-media.json";
import { createProjectConfig, parseProjectConfig, type ProjectConfig, type TimelineClip } from "../../lib/project";
import { resetExportJobForTests, setExportJobForTests } from "../../lib/exportJob";
import { ExportView } from "./ExportView";
import { chooseOption, optionNames } from "./comboTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
  cleanup();
  act(() => resetExportJobForTests());
});

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

const exportButton = () => screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;

/* These run in jsdom, which has neither WebCodecs nor a Tauri shell — the exact
   conditions the view has to be honest about rather than paper over. */
describe("the export view where nothing can encode", () => {
  it("refuses to offer an export it cannot perform, and says why", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(exportButton().disabled).toBe(true);
    const reasons = screen.getByRole("alert").textContent ?? "";
    expect(reasons).toContain("browser preview");
    expect(reasons).toContain("WebCodecs");
  });

  it("says why there is no picture rather than showing an empty stage as though it were one", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText(/Playback needs the desktop app/i)).toBeTruthy();
    expect(document.querySelector("canvas")?.style.visibility).toBe("hidden");
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
  });

  it("states the real duration of the planned file", () => {
    render(<ExportView config={project([clip("a", 0, 2_000), clip("b", 2_000, 1_000)])} folderPath="/tmp/project" />);
    expect(within(screen.getByText("Duration").parentElement!).getByText("00:03.000")).toBeTruthy();
    expect(screen.getByText("72 frames at 24 fps")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Resolution" }).textContent).toContain("1920 × 1080");
  });

  it("offers the project's own frame and then the standard delivery sizes", () => {
    const config = project([clip("a", 0, 2_000)]);
    config.settings.resolution = "1344p";
    render(<ExportView config={config} folderPath="/tmp/project" />);
    const resolution = screen.getByRole("combobox", { name: "Resolution" });
    expect(optionNames(resolution)).toEqual(["2432 × 1344 (project)", "1280 × 720", "1920 × 1080", "2560 × 1440", "3840 × 2160"]);
    chooseOption(resolution, "3840 × 2160");
    expect(screen.getByText(/3840 × 2160/)).toBeTruthy();
  });

  it("says outright that a timeline with no audio clips produces no sound", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("no audio clips on the timeline")).toBeTruthy();
  });

  it("blocks on an empty timeline rather than offering to render nothing", () => {
    render(<ExportView config={project([])} folderPath="/tmp/project" />);
    expect(screen.getByRole("alert").textContent).toContain("no video clips");
    expect(screen.getByText("Nothing on the timeline yet")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes a setting through its combo box", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Frame rate" }));
    fireEvent.click(screen.getByRole("option", { name: "30 fps" }));
    expect(screen.getByText("60 frames at 30 fps")).toBeTruthy();
    const upscaler = screen.getByRole("combobox", { name: "Upscaler" });
    expect(optionNames(upscaler)).toEqual(["None", "Real-ESRGAN", "SeedVR2"]);
    chooseOption(upscaler, "SeedVR2");
    expect(upscaler.textContent).toContain("SeedVR2");
  });
});

describe("the shape of the export screen", () => {
  it("is a docked form: preview, a resizable settings pane, and the actions at its foot", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" onClose={() => undefined} />);
    expect(screen.getByRole("region", { name: "Video preview" })).toBeTruthy();
    const pane = screen.getByRole("region", { name: "Export settings" });
    // No title header: the pane opens on its first section.
    expect(within(pane).queryByRole("heading")).toBeNull();
    expect(pane.querySelector(".ui-prop-section")).toBe(pane.querySelector(".export-settings__scroll")!.firstElementChild);
    expect(within(pane).getByRole("button", { name: /Output/ }).getAttribute("aria-expanded")).toBe("true");
    expect(within(pane).getByRole("button", { name: /Summary/ })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize export settings" }).getAttribute("aria-valuenow")).toBe("340");
    expect(container.querySelector(".export-footer")).toBeNull();
    const foot = pane.querySelector(".export-settings__foot") as HTMLElement;
    expect(within(foot).getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Export"]);
    // No hero title on the page, and labels in sentence case.
    expect(container.querySelector("h1")?.classList.contains("sr-only")).toBe(true);
    expect(screen.getByText("Save to")).toBeTruthy();
    expect(screen.queryByText("Container & codec")).toBeNull();
  });

  it("gives the estimated size as a size and nothing else", () => {
    const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    const row = within(container.querySelector(".export-summary") as HTMLElement).getByText("Estimated size").parentElement!;
    expect(row.querySelector("dd")!.textContent).toMatch(/^[\d.]+ [KMG]?B$/);
    expect(row.querySelector("dd small")).toBeNull();
  });

  it("sizes the picture from the export plan rather than from the media under the playhead", () => {
    const portrait = project([clip("a", 0, 2_000)]);
    portrait.assets[0] = { ...portrait.assets[0], kind: "image", mimeType: "image/png", width: 1080, height: 1920 };
    const { container } = render(<ExportView config={portrait} folderPath="/tmp/project" />);
    expect((container.querySelector(".export-picture") as HTMLElement).style.aspectRatio).toBe("1920 / 1080");
  });

  it("puts a fixed transport bar under the picture while windowed", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
      const stage = container.querySelector(".export-stage") as HTMLElement;
      const controls = screen.getByRole("group", { name: "Video playback controls" });
      // Under the screen that holds the picture, not inset in a padded frame.
      expect(controls.previousElementSibling?.classList.contains("export-screen")).toBe(true);
      expect(controls.previousElementSibling?.firstElementChild?.classList.contains("export-picture")).toBe(true);
      expect(stage.parentElement?.classList.contains("export-preview")).toBe(true);
      expect(stage.parentElement?.children).toHaveLength(1);
      expect(Array.from(controls.querySelectorAll("button")).map((button) => button.getAttribute("aria-label")))
        .toEqual(["Go to start", "Previous frame", "Play", "Next frame", "Go to end", "Full screen"]);
      // Windowed, nothing hides: the pointer resting changes nothing.
      fireEvent.pointerMove(stage);
      act(() => vi.advanceTimersByTime(2_000));
      expect(stage.classList.contains("export-stage--controls-visible")).toBe(false);
      expect(controls.textContent).toContain("00:00:00:00 / 00:00:02:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps one frame at a time and prints the frame it landed on", () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    expect(screen.getByRole("group", { name: "Video playback controls" }).textContent).toContain("00:00:00:02 /");
    fireEvent.click(screen.getByRole("button", { name: "Go to end" }));
    expect(screen.getByRole("group", { name: "Video playback controls" }).textContent).toContain("00:00:01:23 /");
  });
});

describe("a run in progress and a finished one", () => {
  it("shows percent, time remaining and the frame being encoded", () => {
    act(() => setExportJobForTests({
      folderPath: "/tmp/project",
      destination: "C:\\Videos\\Northern Light.mp4",
      progress: { phase: "rendering", framesDone: 30, frameCount: 72, detail: "Rendering frame 30 of 72." },
      remainingMs: 72_000,
    }));
    render(<ExportView config={project([clip("a", 0, 3_000)])} folderPath="/tmp/project" />);
    expect(screen.getByRole("status").textContent).toContain("42% · 1:12 remaining · Encoding frame 30 of 72");
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Queue export" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("keeps saying where the file went until it is dismissed", () => {
    act(() => setExportJobForTests({
      folderPath: "/tmp/project",
      outcome: { kind: "saved", path: "C:\\Videos\\Northern Light.mp4", bytes: 1_000, audioProblems: [], audioShortfalls: [] },
    }));
    render(<ExportView config={project([clip("a", 0, 3_000)])} folderPath="/tmp/project" />);
    expect(screen.getByText("Exported to C:\\Videos\\Northern Light.mp4")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in folder" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Exported to/)).toBeNull();
  });

  it("does not claim another project's run", () => {
    act(() => setExportJobForTests({
      folderPath: "/tmp/other",
      progress: { phase: "rendering", framesDone: 1, frameCount: 10, detail: "" },
    }));
    render(<ExportView config={project([clip("a", 0, 3_000)])} folderPath="/tmp/project" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).not.toContain("Another project is exporting");
  });
});

describe("where the file goes", () => {
  it("shows the default destination Rust proposes before any dialog", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockImplementation(async (command: string) => (
      command === "default_export_destination" ? { path: "C:\\Users\\NN\\Videos\\Northern Light.mp4", exists: false } : null
    ) as never);
    try {
      render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
      await waitFor(() => expect(screen.getByText("C:\\Users\\NN\\Videos\\Northern Light.mp4")).toBeTruthy());
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("default_export_destination", { suggestedName: "Northern Light.mp4" });
      expect(screen.getByRole("button", { name: "Browse…" })).toBeTruthy();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      vi.mocked(invoke).mockReset();
    }
  });
});

describe("the export view on media the project does not contain", () => {
  const external = () => parseProjectConfig(externalFixture);

  it("plans the external clip instead of calling it missing media", () => {
    render(<ExportView config={external()} folderPath="D:\\tmp\\news\\News broadcast" />);
    const reasons = screen.getByRole("alert").textContent ?? "";
    expect(reasons).not.toMatch(/not in this project/i);
    expect(reasons).not.toMatch(/no file recorded/i);
    expect(within(screen.getByText("Duration").parentElement!).getByText("00:12.000")).toBeTruthy();
    expect(screen.getByText("360 frames at 30 fps")).toBeTruthy();
  });
});

describe("what the page says the soundtrack will cost", () => {
  const withAudioSupport = (body: () => void) => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const saved = { AudioEncoder: scope.AudioEncoder, AudioData: scope.AudioData, OfflineAudioContext: scope.OfflineAudioContext };
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
      expect(screen.getByText("AAC · 2 clips mixed")).toBeTruthy();
      expect(screen.getByText(/1\.5 MB of memory held while it renders/)).toBeTruthy();
    });
  });

  it("says nothing about a mix it is not going to make", () => {
    render(<ExportView config={parseProjectConfig(audioFixture)} folderPath="D:\\tmp\\harbour" />);
    expect(screen.getByText("this webview has no AudioEncoder")).toBeTruthy();
    expect(screen.queryByText(/of memory held while it renders/)).toBeNull();
  });
});

describe("what the page claims about the compositor", () => {
  it("does not promise WebGPU before anything has asked for an adapter", async () => {
    render(<ExportView config={project([clip("a", 0, 2_000)])} folderPath="/tmp/project" />);
    expect(await screen.findByText(/no navigator\.gpu/i)).toBeTruthy();
    expect(screen.queryByText("WebGPU")).toBeNull();
    expect(document.body.textContent).toContain("2D canvas");
  });
});
