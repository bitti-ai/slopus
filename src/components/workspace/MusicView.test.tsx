// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MusicView } from "./MusicView";
import { createProjectConfig, type ProjectConfig } from "../../lib/project";
import { newMusicFolder, newSong } from "../../lib/music";
import { readMediaFileUrl } from "../../lib/persistence";
import { loadGeneratorTemplateSettings, musicTemplates, saveGeneratorTemplateSettings } from "../../lib/settings";

vi.mock("../../lib/persistence", async (original) => ({ ...await original<typeof import("../../lib/persistence")>(), isTauri: () => true, readMediaFileUrl: vi.fn(async () => "blob:song") }));
let latest: ProjectConfig;
const generate = vi.fn();
const createConfig = () => createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
function Harness({ initial = createConfig() }: { initial?: ProjectConfig }) {
  const [config, setConfig] = useState(initial); latest = config;
  return <MusicView config={config} folderPath="C:/Music" onChange={setConfig} onGenerate={generate} onCancel={() => {}} workItems={[]} />;
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(readMediaFileUrl).mockResolvedValue("blob:song");
  const settings = loadGeneratorTemplateSettings();
  saveGeneratorTemplateSettings({ ...settings, templates: settings.templates.map((template) => template.id === "yue2" ? { ...template, paths: { ...template.paths, transformer: "C:/weights/yue2.safetensors" }, sources: {} } : template) });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
});

it("creates songs in the browsed folder and moves them between folders by drag and drop", () => {
  render(<Harness />);
  const createFolder = (name: string) => {
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
  };
  createFolder("Jazz");
  fireEvent.click(screen.getAllByRole("button", { name: "New song" })[0]);
  const jazz = latest.musicFolders![0];
  expect(latest.musicSongs![0].folderId).toBe(jazz.id);
  createFolder("Piano");
  fireEvent.click(screen.getAllByRole("button", { name: "New song" })[0]);
  const piano = latest.musicFolders![1], song = latest.musicSongs![1];
  expect(piano.parentId).toBe(jazz.id);
  expect(song.folderId).toBe(piano.id);
  const data = new Map<string, string>();
  const dataTransfer = { effectAllowed: "", dropEffect: "", types: ["application/x-slopus-music-song"],
    setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
  fireEvent.dragStart(screen.getByRole("listitem"), { dataTransfer });
  const destination = within(screen.getByRole("navigation", { name: "Music folders" })).getByRole("button", { name: "Jazz" });
  fireEvent.dragOver(destination, { dataTransfer });
  expect(destination).toHaveAttribute("data-drop-target", "true");
  fireEvent.drop(destination, { dataTransfer });
  expect(latest.musicSongs![1].folderId).toBe(jazz.id);
  expect(screen.getByText("This folder is empty")).toBeInTheDocument();
  fireEvent.click(destination);
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  fireEvent.dragStart(screen.getAllByRole("listitem")[1], { dataTransfer });
  fireEvent.drop(within(screen.getByRole("navigation", { name: "Music folders" })).getByRole("button", { name: "Your music" }), { dataTransfer });
  expect(latest.musicSongs![1].folderId).toBeNull();
});

it("automatically plays the next generated song in the starting folder even after browsing elsewhere", async () => {
  const jazz = newMusicFolder("Jazz", null), other = newMusicFolder("Other", null);
  const songs = [
    { ...newSong("yue2", 32, jazz.id), title: "First", assetId: "first" },
    { ...newSong("yue2", 32, jazz.id), title: "Draft" },
    { ...newSong("yue2", 32, jazz.id), title: "Second", assetId: "second" },
    { ...newSong("yue2", 32, other.id), title: "Elsewhere", assetId: "other" },
  ];
  const assets = songs.flatMap((song) => song.assetId ? [{ id: song.assetId, kind: "audio" as const, name: song.title,
    relativePath: `media/${song.assetId}.wav`, durationMs: 30000, mimeType: "audio/wav", createdAt: song.createdAt }] : []);
  vi.mocked(readMediaFileUrl).mockImplementation(async (_, asset) => `blob:${asset.relativePath}`);
  const { container } = render(<Harness initial={{ ...createConfig(), musicFolders: [jazz, other], musicSongs: songs, assets }} />);
  const folders = within(screen.getByRole("navigation", { name: "Music folders" }));
  fireEvent.click(folders.getByRole("button", { name: "Jazz" }));
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  const audio = container.querySelector("audio")!;
  await waitFor(() => expect(audio).toHaveAttribute("src", "blob:media/first.wav"));
  fireEvent.canPlay(audio);
  fireEvent.click(folders.getByRole("button", { name: "Other" }));
  fireEvent.ended(audio);
  await waitFor(() => expect(audio).toHaveAttribute("src", "blob:media/second.wav"));
  fireEvent.canPlay(audio);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
  fireEvent.ended(audio);
  expect(readMediaFileUrl).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Select Elsewhere" })).toBeInTheDocument();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("adds songs, edits lyrics and style, switches layout and queues the selected song", () => {
  render(<Harness />);
  fireEvent.click(screen.getAllByRole("button", { name: "New song" })[0]);
  fireEvent.change(screen.getByLabelText("Song title"), { target: { value: "Night drive" } });
  fireEvent.change(screen.getByLabelText("Music style"), { target: { value: "Synth pop" } });
  fireEvent.change(screen.getByLabelText("Music lyrics"), { target: { value: "[Verse]\nCity lights" } });
  expect(latest.musicSongs![0]).toMatchObject({ title: "Night drive", style: "Synth pop", settings: { lyrics: "[Verse]\nCity lights" } });
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  expect(screen.getByRole("list", { name: "Songs" })).toHaveClass("music-songs--list");
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(generate).toHaveBeenCalledWith(latest.musicSongs![0].id, expect.objectContaining({ modelType: "yue2" }));
});

it("shows missing downloads in the shared selector and status bar, outside the inspector", () => {
  saveGeneratorTemplateSettings({ ...loadGeneratorTemplateSettings(), templates: musicTemplates() });
  render(<Harness initial={{ ...createConfig(), musicSongs: [{ ...newSong(), style: "Jazz" }] }} />);
  const toolbar = screen.getByRole("toolbar", { name: "Music tools" });
  expect(within(toolbar).getByText("Generator:")).toBeInTheDocument();
  expect(within(toolbar).getByRole("img", { name: "Model weights missing" })).toHaveAttribute("data-tooltip", expect.stringContaining("Settings"));
  expect(screen.getByLabelText("Music status")).toHaveTextContent("Download or select music model weights");
  const inspector = screen.getByRole("complementary", { name: "Song settings" });
  expect(within(inspector).queryByText(/Download or select/)).not.toBeInTheDocument();
  expect(within(inspector).getByRole("button", { name: "Generate" })).toBeDisabled();
  expect(within(inspector).getByRole("button", { name: "Generate" })).toHaveClass("primary-button");
  const selector = within(toolbar).getByRole("combobox", { name: "Generator" });
  expect(selector).toHaveClass("generator-template");
  fireEvent.click(selector);
  expect(screen.getAllByRole("option").every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(screen.getAllByText("Download in Settings")).toHaveLength(2);
});

it("plays generated audio and creates a reference for the context-clicked song", async () => {
  const first = { ...newSong(), title: "First", status: "completed" as const, assetId: "song-a" };
  const second = { ...newSong(), title: "Second", status: "completed" as const, assetId: "song-b" };
  const config = { ...createConfig(), musicSongs: [first, second], assets: [first, second].map((song) => ({ id: song.assetId, kind: "audio" as const, name: song.title, relativePath: `media/${song.assetId}.wav`, durationMs: 30000, mimeType: "audio/wav", createdAt: song.createdAt })) };
  const { container } = render(<Harness initial={config} />);
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "blob:song"));
  fireEvent.canPlay(container.querySelector("audio")!);
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  fireEvent.play(container.querySelector("audio")!);
  expect(screen.getByRole("button", { name: "Pause music" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Select Second" }));
  expect(readMediaFileUrl).toHaveBeenCalledTimes(1);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Select First" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Create Reference" }));
  expect(latest.references.at(-1)).toMatchObject({ kind: "audio", name: "First", relativePath: "media/song-a.wav", audio: { startSeconds: 0, durationSeconds: 15 } });
});
