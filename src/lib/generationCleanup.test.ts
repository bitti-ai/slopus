import { describe, expect, it, vi } from "vitest";
import { createProjectConfig, generationAssetId, type ProjectAsset } from "./project";
import { generatedFilePaths, removeUnusedGenerationAssets } from "./generationCleanup";
import { ProjectSession } from "./projectSession";
import { newSong } from "./music";

vi.mock("./diagnostics", async importOriginal => ({ ...await importOriginal<typeof import("./diagnostics")>(), writeDiagnostic: vi.fn() }));

const config = () => createProjectConfig({ name: "Cleanup", prompt: "A scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
const asset = (id: string, kind: ProjectAsset["kind"] = "generated"): ProjectAsset => ({ id, kind, name: id, mimeType: kind === "audio" ? "audio/wav" : "video/mp4",
  relativePath: `media/generated/${id}.${kind === "audio" ? "wav" : "mp4"}`, createdAt: new Date().toISOString() });

describe("generated file cleanup", () => {
  it("removes unneeded scene and song assets but preserves timeline and video source uses", () => {
    const previous = config(), id = generationAssetId(previous.generationJobs[0].id);
    previous.assets = [asset(id), asset("song", "audio")];
    previous.musicSongs = [{ ...newSong(), assetId: "song" }];
    const next = { ...previous, generationJobs: [], musicSongs: [] };
    expect(removeUnusedGenerationAssets(next, previous).assets).toEqual([]);
    const clip = { id: "clip", trackId: next.timeline.tracks[0].id, assetId: id, startMs: 0, durationMs: 1000, sourceStartMs: 0, label: "Scene", status: "generated" as const };
    next.timeline.tracks[0].clips = [clip];
    next.videos = [{ id: "video", title: "Video", sceneIds: [], prompt: "", createdAt: previous.createdAt, musicSource: { kind: "asset", id: "song" } }];
    expect(removeUnusedGenerationAssets(next, previous).assets).toEqual(previous.assets);
  });

  it("collects nested image sources, take latents, shared segments and album covers", () => {
    expect([...generatedFilePaths({ assets: [{ relativePath: "media/generated/a.png", imageGeneration: { scene: { sourceImage: { relativePath: "media/generated/source.png" } } } }],
      generationJobs: [{ generationHistory: { versions: [{ originalLatentRelativePath: "latents/base.safetensors", media: { sceneSegments: [{ latentRelativePath: "latents/shared.safetensors" }] } }] } }],
      musicSongs: [{ coverRelativePath: "media/generated/cover.jpg" }], sourcePath: "C:/external.wav", relativePath: "media/imported/source.png" })].sort())
      .toEqual(["latents/base.safetensors", "latents/shared.safetensors", "media/generated/a.png", "media/generated/cover.jpg", "media/generated/source.png"]);
  });

  it("makes deletion permanent at save, including while the write is pending", async () => {
    const initial = config(); initial.assets = [asset("song", "audio")];
    let finish!: () => void;
    const writer = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const session = new ProjectSession({ folderPath: "C:/cleanup", config: initial }, writer);
    session.edit(current => ({ ...current, assets: [] }));
    expect(session.undo()).toBe(true);
    expect(session.redo()).toBe(true);
    const saving = session.save();
    expect(session.undo()).toBe(false);
    session.edit(current => ({ ...current, name: "New name" }));
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    finish(); await saving;
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().config.assets).toEqual([]);
    await session.discard();
    expect(session.getSnapshot().config.assets).toEqual([]);
  });

  it("retries deferred cleanup after queued work releases its input files", async () => {
    const initial = config(); initial.assets = [asset("song", "audio")];
    let protectedPaths = [initial.assets[0].relativePath!];
    const writer = vi.fn(async () => undefined);
    const session = new ProjectSession({ folderPath: "C:/cleanup", config: initial }, writer, () => protectedPaths);
    session.edit(current => ({ ...current, assets: [] }));
    await session.save();
    expect(writer).toHaveBeenLastCalledWith(expect.anything(), protectedPaths);
    await session.flushGeneratedCleanup();
    expect(writer).toHaveBeenCalledTimes(1);
    protectedPaths = [];
    await session.flushGeneratedCleanup();
    expect(writer).toHaveBeenCalledTimes(2);
  });

  it("keeps files recoverable after a failed save but cannot undo a later successful deletion", async () => {
    const initial = config(); initial.assets = [asset("song", "audio")];
    const writer = vi.fn().mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(undefined);
    const session = new ProjectSession({ folderPath: "C:/cleanup", config: initial }, writer);
    session.edit(current => ({ ...current, assets: [] }));
    await expect(session.save()).rejects.toThrow("Disk full");
    await session.discard();
    expect(session.getSnapshot().config.assets).toEqual(initial.assets);
    session.edit(current => ({ ...current, assets: [] }));
    await session.save();
    expect(session.undo()).toBe(false);
  });
});
