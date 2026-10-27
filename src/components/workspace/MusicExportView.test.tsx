// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { MusicExportView } from "./MusicExportView";
import { createProjectConfig } from "../../lib/project";
import { newSong } from "../../lib/music";
import { musicExportSupport } from "../../lib/musicExport";
import { startMusicExportJob } from "../../lib/exportJob";
import { readMediaFileUrl } from "../../lib/persistence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/persistence", () => ({ isTauri: () => true, readMediaFileUrl: vi.fn(async () => "blob:music") }));
vi.mock("../../lib/musicExport", async (original) => ({ ...await original<typeof import("../../lib/musicExport")>(), musicExportSupport: vi.fn(async () => true) }));
vi.mock("../../lib/exportJob", () => ({ startMusicExportJob: vi.fn(), useExportJob: () => ({ status: "completed", progress: null, outcome: null }), isExportActive: () => false,
  dismissExportOutcome: vi.fn(), exportFraction: () => 0, cancelExportJob: vi.fn() }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.mocked(musicExportSupport).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValue("D:/song.m4a");
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function config() {
  const config = createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  config.musicFolders = [{ id: "jazz", name: "Jazz" }];
  config.musicSongs = [{ ...newSong(), title: "Draft" }, { ...newSong("yue2", 32, "jazz"), title: "Evening", assetId: "audio" }, { ...newSong(), title: "Morning", assetId: "second" }];
  config.assets = ["audio", "second"].map((id) => ({ id, kind: "audio", name: id, mimeType: "audio/wav", relativePath: `media/${id}.wav`, createdAt: config.createdAt, durationMs: 30000 }));
  return config;
}

it("exports the selected generated song and format, remembering preferences", async () => {
  const project = config();
  render(<MusicExportView config={project} folderPath="D:/Music" />);
  expect(screen.queryByRole("button", { name: /Export song Draft/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export song Jazz / Evening" })).toHaveAttribute("aria-pressed", "true");
  await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Export song Morning" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  fireEvent.click(screen.getByRole("option", { name: "M4A · AAC" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Bitrate" }));
  fireEvent.click(screen.getByRole("option", { name: "256 kbps" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(startMusicExportJob).toHaveBeenCalledWith(expect.objectContaining({ title: "Morning", asset: project.assets[1], settings: { format: "m4a", bitrate: 256000 }, destination: "D:/song.m4a" })));
  expect(invoke).toHaveBeenCalledWith("choose_music_export_destination", { suggestedName: "Morning", format: "m4a" });
  expect(JSON.parse(localStorage.getItem("slopus.music-export.v1")!)).toEqual({ format: "m4a", bitrate: 256000 });
  expect(readMediaFileUrl).toHaveBeenCalledWith("D:/Music", project.assets[1], "audio/wav");
});

it("disables unsupported encoders and does not queue when the save dialog is cancelled", async () => {
  vi.mocked(musicExportSupport).mockImplementation(async (format) => format === "wav");
  vi.mocked(invoke).mockResolvedValue(null);
  render(<MusicExportView config={config()} folderPath="D:/Music" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  expect(screen.getByRole("option", { name: /M4A/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("option", { name: /WebM/ })).toHaveAttribute("aria-disabled", "true");
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Format" }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(startMusicExportJob).not.toHaveBeenCalled();
});

it.each(["mp3", "flac"] as const)("exports %s with the correct destination and bitrate controls", async (format) => {
  vi.mocked(invoke).mockResolvedValue(`D:/song.${format}`);
  render(<MusicExportView config={config()} folderPath="D:/Music" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled());
  fireEvent.click(screen.getByRole("combobox", { name: "Format" }));
  fireEvent.click(screen.getByRole("option", { name: format === "mp3" ? "MP3" : "FLAC · Lossless" }));
  if (format === "mp3") expect(screen.getByRole("combobox", { name: "Bitrate" })).toBeInTheDocument();
  else expect(screen.queryByRole("combobox", { name: "Bitrate" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Export…" }));
  await waitFor(() => expect(startMusicExportJob).toHaveBeenCalledWith(expect.objectContaining({ settings: { format, bitrate: 192000 }, destination: `D:/song.${format}` })));
  expect(invoke).toHaveBeenCalledWith("choose_music_export_destination", { suggestedName: "Evening", format });
});

it("has an empty state for drafts and stops preview playback on unmount", async () => {
  const draft = config(); draft.assets = [];
  const empty = render(<MusicExportView config={draft} folderPath="D:/Music" />);
  expect(screen.getByText("No music to export yet")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  empty.unmount();
  const view = render(<MusicExportView config={config()} folderPath="D:/Music" />);
  await waitFor(() => expect(screen.getByLabelText("Music export playback")).toHaveAttribute("src", "blob:music"));
  const audio = screen.getByLabelText("Music export playback") as HTMLAudioElement;
  vi.mocked(audio.pause).mockClear(); view.unmount();
  expect(audio.pause).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:music");
});
