// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPortal } from "react-dom";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { createProjectConfig } from "../lib/project";
import { newSong } from "../lib/music";
import { readMediaFileUrl } from "../lib/persistence";
import { notifyPreviewPlayback } from "../lib/mediaPlayback";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../lib/persistence", async (original) => ({ ...await original<typeof import("../lib/persistence")>(),
  readMediaFileUrl: vi.fn(async (_, asset) => `blob:${asset.relativePath}`),
}));
// Exercise workspace media-event routing, including React portals used by shot popouts.
vi.mock("./workspace/GeneratorView", () => ({ GeneratorView: () => <><video aria-label="Shot" />{createPortal(<video aria-label="Popout" />, document.body)}</> }));
vi.mock("./workspace/TimelineView", () => ({ TimelineView: () => <audio aria-label="Timeline preview" /> }));
vi.mock("./workspace/ExportView", () => ({ ExportView: () => <video aria-label="Export preview" /> }));
vi.mock("./workspace/ReferencesView", () => ({ ReferencesView: () => <div>References page</div> }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
  vi.mocked(readMediaFileUrl).mockImplementation(async (_, asset) => `blob:${asset.relativePath}`);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function workspace() {
  const songs = ["First", "Second"].map((title) => ({ ...newSong(), title, assetId: title, status: "completed" as const }));
  const config = { ...createProjectConfig({ name: "Music test", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 }),
    musicSongs: songs, assets: songs.map((song) => ({ id: song.assetId, kind: "audio" as const, name: song.title,
      relativePath: `media/${song.title}.wav`, durationMs: 30000, mimeType: "audio/wav", createdAt: song.createdAt })) };
  return render(<ProjectWorkspace project={{ folderPath: "C:/Music", config }} initialView="music" onBack={() => {}} onSave={async () => {}} />);
}

async function start() {
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  const audio = document.querySelector<HTMLAudioElement>(".music-view audio")!;
  await waitFor(() => expect(audio).toHaveAttribute("src", "blob:media/First.wav"));
  fireEvent.canPlay(audio);
  expect(screen.getByRole("tab", { name: "Music Playing" })).toBeInTheDocument();
  return audio;
}

it("keeps music and its playlist alive across tabs, preserves position and stops on project exit", async () => {
  const view = workspace();
  const audio = await start();
  audio.currentTime = 12;
  fireEvent.timeUpdate(audio);
  vi.mocked(audio.pause).mockClear();
  fireEvent.click(screen.getByRole("tab", { name: "References" }));
  expect(audio).toBeInTheDocument();
  expect(audio).not.toBeVisible();
  expect(audio.pause).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Music Playing" })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByText("2 songs")).not.toBeVisible();
  fireEvent.click(screen.getByRole("tab", { name: "Music Playing" }));
  expect(document.querySelector(".music-view audio")).toBe(audio);
  expect(audio.currentTime).toBe(12);
  expect(screen.getByRole("button", { name: "Pause music" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Video" }));
  fireEvent.ended(audio);
  await waitFor(() => expect(audio).toHaveAttribute("src", "blob:media/Second.wav"));
  fireEvent.canPlay(audio);
  expect(screen.getByRole("tab", { name: "Music Playing" })).toBeInTheDocument();
  vi.mocked(audio.pause).mockClear();
  view.unmount();
  expect(audio.pause).toHaveBeenCalled();
});

it.each([["Timeline", "Timeline preview"], ["Video", "Shot"], ["Video", "Popout"], ["Export", "Export preview"], ["Export", "Music export playback"]])(
  "pauses background music when %s playback starts (%s), then allows manual resume", async (tab, preview) => {
    workspace();
    const audio = await start();
    audio.currentTime = 7;
    fireEvent.click(screen.getByRole("tab", { name: tab }));
    if (preview === "Export preview") fireEvent.click(within(screen.getByRole("tablist", { name: "Export type" })).getByRole("tab", { name: "Video" }));
    expect(screen.getByRole("tab", { name: "Music Playing" })).toBeInTheDocument();
    fireEvent.play(screen.getByLabelText(preview));
    const musicTab = within(screen.getByRole("tablist", { name: "Project views" })).getByRole("tab", { name: "Music" });
    expect(within(musicTab).queryByRole("img", { name: "Playing" })).not.toBeInTheDocument();
    expect(audio.currentTime).toBe(7);
    fireEvent.click(musicTab);
    expect(screen.getByRole("button", { name: "Play music" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play music" }));
    expect(screen.getByRole("tab", { name: "Music Playing" })).toBeInTheDocument();
  },
);

it("cancels pending autoplay and late playback/ended events when another player takes over", async () => {
  let loaded!: (url: string) => void;
  vi.mocked(readMediaFileUrl).mockImplementationOnce(() => new Promise((resolve) => { loaded = resolve; }));
  workspace();
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  const audio = document.querySelector<HTMLAudioElement>(".music-view audio")!;
  act(() => notifyPreviewPlayback());
  await act(async () => loaded("blob:media/First.wav"));
  fireEvent.canPlay(audio);
  expect(audio.play).not.toHaveBeenCalled();
  fireEvent.play(audio);
  fireEvent.ended(audio);
  expect(screen.getByRole("tab", { name: "Music" })).toBeInTheDocument();
  expect(audio).toHaveAttribute("src", "blob:media/First.wav");
  expect(readMediaFileUrl).toHaveBeenCalledTimes(1);
});
