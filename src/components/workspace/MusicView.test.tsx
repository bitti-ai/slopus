// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MusicView } from "./MusicView";
import { createProjectConfig, type ProjectConfig } from "../../lib/project";
import { newSong } from "../../lib/music";
import { readMediaFileUrl } from "../../lib/persistence";
import { loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "../../lib/settings";

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
  const settings = loadGeneratorTemplateSettings();
  saveGeneratorTemplateSettings({ ...settings, templates: settings.templates.map((template) => template.id === "yue2" ? { ...template, paths: { ...template.paths, transformer: "C:/weights/yue2.safetensors" }, sources: {} } : template) });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
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
  fireEvent.click(screen.getByRole("button", { name: "Generate music" }));
  expect(generate).toHaveBeenCalledWith(latest.musicSongs![0].id, expect.objectContaining({ modelType: "yue2" }));
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
