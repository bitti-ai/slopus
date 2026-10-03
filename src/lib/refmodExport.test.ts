import { describe, expect, it, vi } from "vitest";
import type { ProjectReference } from "./project";
import { refmodExportBlocker, refmodExportRequest } from "./refmodExport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const reference = (patch: Partial<ProjectReference> = {}): ProjectReference => ({
  id: "ref-hero", kind: "text", name: "Hero", description: "A traveler", intendedUse: [], createdAt: "2026-01-01T00:00:00.000Z", ...patch,
});
const images = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `image-${index}`, name: `Image ${index}`, relativePath: `references/${index}.png` }));

describe("refmod export", () => {
  it("needs raw media, at most nine images and no attached refmods", () => {
    expect(refmodExportBlocker(reference())).toBe("Add an image, video or sound to export a refmod.");
    expect(refmodExportBlocker(reference({ kind: "video", video: { startSeconds: 0, includeAudio: true } }))).toContain("Add an image");
    expect(refmodExportBlocker(reference({ images: images(10) }))).toBe("Refmod export supports up to nine images.");
    expect(refmodExportBlocker(reference({ images: images(1), refmods: [{ id: "mod", name: "Mod", sourcePath: "D:/mod.safetensors", strength: 1, copies: 1 }] })))
      .toBe("This reference already uses refmods.");
    expect(refmodExportBlocker(reference({ images: images(9) }))).toBeNull();
    expect(refmodExportBlocker(reference({ kind: "video", sourcePath: "D:/walk.mp4" }))).toBeNull();
    expect(refmodExportBlocker(reference({ kind: "audio", sourcePath: "D:/voice.wav" }))).toBeNull();
  });

  it("sends images first, then the trimmed clip or the sound", () => {
    const clip = refmodExportRequest("C:/project", reference({
      kind: "video", sourcePath: "D:/walk.mp4", images: images(2), video: { startSeconds: 1.5, durationSeconds: 4, includeAudio: false },
    }), "refmod-1");
    expect(clip).toMatchObject({
      jobId: "refmod-1", referencePaths: ["C:/project/references/0.png", "C:/project/references/1.png"],
      referenceVideos: [{ name: "Hero", sourcePath: "D:/walk.mp4", startSeconds: 1.5, durationSeconds: 4, includeAudio: false }],
    });
    expect(clip.referenceAudios).toBeUndefined();
    const sound = refmodExportRequest("C:/project", reference({ kind: "audio", sourcePath: "D:/voice.wav", audio: { startSeconds: 2, durationSeconds: 6 } }), "refmod-2");
    expect(sound).toMatchObject({ referencePaths: [], referenceAudios: [{ sourcePath: "D:/voice.wav", startSeconds: 2, durationSeconds: 6 }] });
    expect(sound.referenceVideos).toBeUndefined();
    // Frames mode exports the selected stills rather than the clip.
    const frames = refmodExportRequest("C:/project", reference({ kind: "video", sourcePath: "D:/walk.mp4", video: { startSeconds: 0, includeAudio: true, mode: "frames", frames: images(1) } }), "refmod-3");
    expect(frames.referencePaths).toEqual(["C:/project/references/0.png"]);
    expect(frames.referenceVideos).toBeUndefined();
  });
});
