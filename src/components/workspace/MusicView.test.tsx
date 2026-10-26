// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MusicView } from "./MusicView";
import { createProjectConfig, type ProjectConfig } from "../../lib/project";
import { newMusicFolder, newSong, newSongVariation } from "../../lib/music";
import { readMediaFileUrl } from "../../lib/persistence";
import { loadGeneratorTemplateSettings, musicTemplates, saveGeneratorTemplateSettings } from "../../lib/settings";
import type { WorkItem } from "../../lib/workQueue";

vi.mock("../../lib/persistence", async (original) => ({ ...await original<typeof import("../../lib/persistence")>(), isTauri: () => true, readMediaFileUrl: vi.fn(async () => "blob:song") }));
let latest: ProjectConfig;
const generate = vi.fn();
const createConfig = () => createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
function Harness({ initial = createConfig(), workItems = [] }: { initial?: ProjectConfig; workItems?: WorkItem[] }) {
  const [config, setConfig] = useState(initial); latest = config;
  return <MusicView config={config} folderPath="C:/Music" onChange={setConfig} onGenerate={generate} onCancel={() => {}} workItems={workItems} />;
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
  const destination = within(screen.getByRole("navigation", { name: "Music path" })).getByRole("button", { name: "Jazz" });
  fireEvent.dragOver(destination, { dataTransfer });
  expect(destination).toHaveAttribute("data-drop-target", "true");
  fireEvent.drop(destination, { dataTransfer });
  expect(latest.musicSongs![1].folderId).toBe(jazz.id);
  expect(screen.getByText("This folder is empty")).toBeInTheDocument();
  fireEvent.click(destination);
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  fireEvent.dragStart(screen.getAllByRole("button", { name: "Select New song" })[1].closest('[role="listitem"]')!, { dataTransfer });
  const root = within(screen.getByRole("navigation", { name: "Music path" })).getByRole("button", { name: "Music" });
  fireEvent.drop(root, { dataTransfer });
  expect(latest.musicSongs![1].folderId).toBeNull();
  fireEvent.click(root);
  fireEvent.dragStart(screen.getByRole("button", { name: "Select New song" }).closest('[role="listitem"]')!, { dataTransfer });
  const folderCard = screen.getByRole("button", { name: "Open Jazz" }).closest('[role="listitem"]')!;
  fireEvent.dragOver(folderCard, { dataTransfer });
  expect(folderCard).toHaveAttribute("data-drop-target", "true");
  fireEvent.drop(folderCard, { dataTransfer });
  expect(latest.musicSongs![1].folderId).toBe(jazz.id);
});

it.each(["Grid", "List"])("browses folders as %s items with a Music path header and only the current contents", (view) => {
  const parent = newMusicFolder("Jazz", null), child = newMusicFolder("Piano", parent.id);
  const rootSong = { ...newSong(), title: "Root song" }, nestedSong = { ...newSong("yue2", 32, child.id), title: "Piano song" };
  render(<Harness initial={{ ...createConfig(), musicFolders: [parent, child], musicSongs: [rootSong, nestedSong] }} />);
  fireEvent.click(screen.getByRole("button", { name: `${view} view` }));
  expect(screen.getByRole("heading", { name: "Music", level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Music contents" })).toHaveClass(`music-songs--${view.toLowerCase()}`);
  const folder = screen.getByRole("button", { name: "Open Jazz" });
  expect(folder).toHaveClass("music-song__select");
  expect(folder.querySelector(".music-song__art svg")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open Piano" })).not.toBeInTheDocument();
  fireEvent.click(folder);
  expect(screen.getByRole("heading", { name: "Music / Jazz", level: 2 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Select Root song" })).not.toBeInTheDocument();
  expect(screen.queryByText("This folder is empty")).not.toBeInTheDocument();
  expect(screen.getAllByRole("listitem")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open Piano" }));
  expect(screen.getByRole("heading", { name: "Music / Jazz / Piano", level: 2 })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select Piano song" })).toBeInTheDocument();
  const path = within(screen.getByRole("navigation", { name: "Music path" }));
  fireEvent.click(path.getByRole("button", { name: "Music" }));
  expect(screen.getByRole("button", { name: "Select Root song" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Music folders" })).not.toBeInTheDocument();
});

it("creates songs and folders from the library and song context menus in the current folder", () => {
  render(<Harness />);
  fireEvent.contextMenu(screen.getByLabelText("Music library"));
  fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
  fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "Jazz" } });
  fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
  fireEvent.keyDown(screen.getByLabelText("Music library"), { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "New song" }));
  expect(latest.musicSongs![0].folderId).toBe(latest.musicFolders![0].id);
  fireEvent.click(screen.getByRole("button", { name: "List view" }));
  fireEvent.contextMenu(screen.getByRole("listitem"));
  expect(screen.getByRole("menuitem", { name: "New folder" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "New song" }));
  expect(latest.musicSongs).toHaveLength(2);
  expect(latest.musicSongs![1].folderId).toBe(latest.musicFolders![0].id);
});

it("removes the context-clicked folder and moves its contents to the parent", () => {
  const parent = newMusicFolder("Jazz", null), folder = newMusicFolder("Piano", parent.id), child = newMusicFolder("Solo", folder.id);
  const song = newSong("yue2", 32, folder.id), nested = newSong("yue2", 32, child.id);
  render(<Harness initial={{ ...createConfig(), musicFolders: [parent, folder, child], musicSongs: [song, nested] }} />);
  const navigation = within(screen.getByRole("navigation", { name: "Music path" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Jazz" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Piano" }));
  fireEvent.keyDown(navigation.getByRole("button", { name: "Piano" }), { key: "ContextMenu" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove folder" }));
  expect(latest.musicFolders).toEqual([parent, { ...child, parentId: parent.id }]);
  expect(latest.musicSongs).toEqual([{ ...song, folderId: parent.id }, nested]);
  expect(navigation.getByRole("button", { name: "Jazz" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Open Solo" })).toBeInTheDocument();
  fireEvent.contextMenu(navigation.getByRole("button", { name: "Music" }));
  expect(screen.queryByRole("menuitem", { name: "Remove folder" })).not.toBeInTheDocument();
});

it("removes the context-clicked playing song, stops playback and preserves timeline media", async () => {
  const first = { ...newSong(), title: "First", assetId: "audio" }, second = { ...newSong(), title: "Second" };
  const asset = { id: "audio", kind: "audio" as const, mimeType: "audio/wav", name: "First", relativePath: "media/first.wav", durationMs: 30000, createdAt: first.createdAt };
  const config = { ...createConfig(), musicSongs: [first, second], assets: [asset] };
  const { container } = render(<Harness initial={config} />);
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "blob:song"));
  fireEvent.click(screen.getByRole("button", { name: "Select Second" }));
  fireEvent.contextMenu(screen.getByRole("button", { name: "Select First" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove song" }));
  expect(latest.musicSongs).toEqual([second]);
  expect(latest.assets).toEqual(config.assets);
  expect(latest.timeline).toEqual(config.timeline);
  expect(screen.getByLabelText("Song title")).toHaveValue("Second");
  await waitFor(() => expect(container.querySelector("audio")).not.toHaveAttribute("src"));
  expect(screen.getByRole("button", { name: "Next song" })).toBeDisabled();
});

it("disables removal for a song with active generation", () => {
  const song = newSong();
  render(<Harness initial={{ ...createConfig(), musicSongs: [song] }} workItems={[{ sceneId: song.id, status: "queued", detail: "Waiting", progress: 0 } as WorkItem]} />);
  fireEvent.contextMenu(screen.getByRole("listitem"));
  expect(screen.getByRole("menuitem", { name: "Remove song" })).toBeDisabled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove song" }));
  expect(latest.musicSongs).toEqual([song]);
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
  const path = within(screen.getByRole("navigation", { name: "Music path" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Jazz" }));
  fireEvent.click(screen.getByRole("button", { name: "Play First" }));
  const audio = container.querySelector("audio")!;
  await waitFor(() => expect(audio).toHaveAttribute("src", "blob:media/first.wav"));
  fireEvent.canPlay(audio);
  fireEvent.click(path.getByRole("button", { name: "Music" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Other" }));
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
  expect(screen.getByRole("list", { name: "Music contents" })).toHaveClass("music-songs--list");
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

it("selects the new song returned by generation while keeping the original visible", () => {
  const original = { ...newSong(), title: "Evening", style: "Jazz", status: "completed" as const, assetId: "original" };
  const variation = newSongVariation(original, [original]);
  function VariationHarness() {
    const [config, setConfig] = useState<ProjectConfig>({ ...createConfig(), musicSongs: [original] });
    return <MusicView config={config} folderPath="C:/Music" onChange={setConfig} workItems={[]} onCancel={() => {}}
      onGenerate={() => { setConfig((current) => ({ ...current, musicSongs: [...current.musicSongs!, variation] })); return variation.id; }} />;
  }
  render(<VariationHarness />);
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(screen.getByRole("button", { name: "Select Evening (2)" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Select Evening" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByLabelText("Song title")).toHaveValue("Evening (2)");
});

it.each([
  ["Music style", "Acoustic folk"], ["Music lyrics", "[Verse]\nA new day"], ["Music seed", "12"],
  ["Music steps", "16"], ["Song duration", "45"], ["Song title", "Morning"],
])("creates one selected draft when editing %s on generated music", (label, value) => {
  const folder = newMusicFolder("Jazz", null);
  const original = { ...newSong("yue2", 32, folder.id), title: "Evening", style: "Jazz", status: "completed" as const, assetId: "original" };
  original.generation = { generatorId: original.generatorId, style: original.style, settings: { ...original.settings }, steps: original.steps, seed: 42 };
  const asset = { id: "original", kind: "audio" as const, name: "Evening", relativePath: "media/evening.wav", durationMs: 30000, mimeType: "audio/wav", createdAt: original.createdAt };
  render(<Harness initial={{ ...createConfig(), musicFolders: [folder], musicSongs: [original], assets: [asset] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Open Jazz" }));
  // Focusing and committing an unchanged number must not create a copy.
  fireEvent.blur(screen.getByLabelText("Music steps"));
  expect(latest.musicSongs).toEqual([original]);
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  expect(latest.musicSongs).toHaveLength(2);
  expect(latest.musicSongs![0]).toEqual(original);
  const draft = latest.musicSongs![1];
  expect(draft.id).not.toBe(original.id);
  expect(draft).toMatchObject({ folderId: folder.id, status: "draft", assetId: null, generation: null, error: null });
  expect(screen.getByRole("button", { name: `Select ${draft.title}` })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText(label)).toHaveValue(["Music seed", "Music steps", "Song duration"].includes(label) ? Number(value) : value);
  fireEvent.change(screen.getByLabelText("Music style"), { target: { value: "Acoustic folk with strings" } });
  fireEvent.change(screen.getByLabelText("Music lyrics"), { target: { value: "Keep writing" } });
  expect(latest.musicSongs).toHaveLength(2);
  expect(latest.musicSongs![0]).toEqual(original);
  expect(latest.musicSongs![1]).toMatchObject({ id: draft.id, style: "Acoustic folk with strings", settings: { lyrics: "Keep writing" } });
  expect(latest.assets).toEqual([asset]);
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(generate).toHaveBeenCalledWith(draft.id, expect.objectContaining({ id: "yue2" }));
});

it("copies generated music to a draft when changing its generator", () => {
  const settings = loadGeneratorTemplateSettings(), source = settings.templates.find((template) => template.id === "yue2")!;
  saveGeneratorTemplateSettings({ ...settings, templates: [...settings.templates, { ...source, id: "other-music", name: "Other music generator", defaultSteps: 16 }] });
  const original = { ...newSong(), title: "Evening", style: "Jazz", status: "completed" as const, assetId: "original" };
  render(<Harness initial={{ ...createConfig(), musicSongs: [original] }} />);
  fireEvent.click(screen.getByRole("combobox", { name: "Generator" }));
  fireEvent.click(screen.getByRole("option", { name: /Other music generator/ }));
  expect(latest.musicSongs).toHaveLength(2);
  expect(latest.musicSongs![0]).toEqual(original);
  expect(latest.musicSongs![1]).toMatchObject({ generatorId: "other-music", steps: 16, status: "draft", assetId: null });
});

it.each(["Grid", "List"])("distinguishes playable songs from drafts and missing audio in %s view", (view) => {
  const original = { ...newSong(), title: "Evening", status: "completed" as const, assetId: "original" };
  const draft = newSongVariation(original, [original]);
  const missing = { ...newSong(), title: "Missing", status: "completed" as const, assetId: "missing" };
  const asset = { id: "original", kind: "audio" as const, name: "Evening", relativePath: "media/evening.wav", durationMs: 30000, mimeType: "audio/wav", createdAt: original.createdAt };
  render(<Harness initial={{ ...createConfig(), musicSongs: [original, draft, missing], assets: [asset] }} />);
  fireEvent.click(screen.getByRole("button", { name: `${view} view` }));
  const readyCard = screen.getByRole("button", { name: "Select Evening" }).closest('[role="listitem"]')!;
  const draftCard = screen.getByRole("button", { name: "Select Evening (2)" }).closest('[role="listitem"]')!;
  expect(readyCard).toHaveClass("music-song--playable");
  expect(within(readyCard as HTMLElement).getByText("Ready · 0:30")).toBeInTheDocument();
  expect(within(readyCard as HTMLElement).getByRole("button", { name: "Play Evening" })).toBeEnabled();
  expect(draftCard).toHaveClass("music-song--draft");
  expect(within(draftCard as HTMLElement).getByText("Draft · Not generated")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Play Evening (2)" })).not.toBeInTheDocument();
  expect(screen.getByText("Audio unavailable")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Play Missing" })).not.toBeInTheDocument();
});

it("keeps the original audio playing when editing creates a draft", async () => {
  const original = { ...newSong(), title: "Evening", style: "Jazz", status: "completed" as const, assetId: "original" };
  const asset = { id: "original", kind: "audio" as const, name: "Evening", relativePath: "media/evening.wav", durationMs: 30000, mimeType: "audio/wav", createdAt: original.createdAt };
  const { container } = render(<Harness initial={{ ...createConfig(), musicSongs: [original], assets: [asset] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Play Evening" }));
  await waitFor(() => expect(container.querySelector("audio")).toHaveAttribute("src", "blob:song"));
  fireEvent.canPlay(container.querySelector("audio")!);
  fireEvent.play(container.querySelector("audio")!);
  const pauses = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;
  fireEvent.change(screen.getByLabelText("Music lyrics"), { target: { value: "New lyrics" } });
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalledTimes(pauses);
  expect(readMediaFileUrl).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Pause music" })).toBeEnabled();
  expect(latest.musicSongs![0]).toEqual(original);
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
