import { describe, expect, it } from "vitest";
import { createProjectConfig, parseProjectConfig, type ProjectAsset } from "./project";
import { moveSong, musicFolderLabel, musicSettingsForModel, musicSettingsSchema, newMusicFolder, newSong, songReference } from "./music";

describe("music projects", () => {
  it("persists folders and song moves without moving or rewriting generated audio", () => {
    const parent = newMusicFolder("Jazz", null), child = newMusicFolder("Piano", parent.id);
    const song = { ...newSong("yue2", 32, parent.id), assetId: "audio-1" };
    const config = { ...createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 }), musicFolders: [parent, child], musicSongs: [song] };
    const moved = moveSong(config, song.id, child.id);
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(moved)));
    expect(saved.musicFolders).toEqual([parent, child]);
    expect(saved.musicSongs![0]).toMatchObject({ folderId: child.id, assetId: "audio-1" });
    expect(musicFolderLabel(saved.musicFolders!, child.id)).toBe("Jazz / Piano");
    expect(moveSong(saved, song.id, "missing")).toBe(saved);
    expect(moveSong(saved, song.id, null).musicSongs![0].folderId).toBeNull();
  });
  it("round-trips songs and preserves older projects without songs", () => {
    const config = createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).musicSongs).toBeUndefined();
    const song = { ...newSong(), style: "Jazz", settings: { ...musicSettingsSchema.parse({}), lyrics: "[Verse]\nHome again" } };
    expect(parseProjectConfig(JSON.parse(JSON.stringify({ ...config, musicSongs: [song] })))).toMatchObject({ musicSongs: [song] });
  });
  it("removes incompatible controls when switching generators", () => {
    const source = musicSettingsSchema.parse({ lyrics: "Sing", duration: 12, planning: "off", temperature: 0.7, top_p: 0.8, top_k: 80, semantic_guidance: 2, flow_guidance: 1.8 });
    expect(musicSettingsForModel(source, "minimax_music3")).toMatchObject({ lyrics: "Sing", duration: 12, planning: "full", temperature: 1, top_p: 0.95, top_k: 80, semantic_guidance: 2, flow_guidance: 1.8 });
    expect(musicSettingsForModel(source, "yue2").flow_guidance).toBe(0);
  });
  it("creates an audio reference trimmed to the supported length", () => {
    const asset: ProjectAsset = { id: "audio", kind: "audio", name: "Song", relativePath: "media/generated/song.wav", durationMs: 30000, mimeType: "audio/wav", createdAt: new Date().toISOString() };
    expect(songReference(newSong(), asset)).toMatchObject({ kind: "audio", relativePath: asset.relativePath, intendedUse: ["audio"], audio: { startSeconds: 0, durationSeconds: 15 } });
    expect(() => songReference(newSong(), { ...asset, durationMs: 1000 })).toThrow(/two seconds/);
  });
});
