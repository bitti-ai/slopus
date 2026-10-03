import { describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig } from "./project";
import { ProjectSession } from "./projectSession";
import { addReferenceImageAssets } from "./referenceImageAssets";

const project = () => createProjectConfig({ name: "Imported images", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });

describe("reference images in the image bar", () => {
  it("registers legacy images, attachments and saved frames, but not icons, video, audio or refmods", () => {
    const config = project();
    const base = { description: "", intendedUse: [], createdAt: config.createdAt };
    config.references = [
      { ...base, id: "legacy", kind: "image", name: "Legacy", relativePath: "references/legacy.jpg" },
      { ...base, id: "text", kind: "text", name: "Mood", iconRelativePath: "references/icons/mood.png",
        images: [{ id: "picture", name: "Mood board", relativePath: "references/mood.webp" }],
        refmods: [{ id: "mod", name: "Style", sourcePath: "D:/style.refmod", strength: 1, copies: 1 }] },
      { ...base, id: "video", kind: "video", name: "Clip", sourcePath: "D:/clip.mp4",
        video: { mode: "video", startSeconds: 0, durationSeconds: 5, includeAudio: false,
          frames: [{ id: "frame", name: "Clip at 0:02.0", timeSeconds: 2, relativePath: "references/frames/frame.png" }] } },
      { ...base, id: "audio", kind: "audio", name: "Sound", sourcePath: "D:/sound.wav" },
    ];
    const next = addReferenceImageAssets(config);
    expect(next.assets.map((asset) => [asset.name, asset.mimeType])).toEqual([
      ["Legacy", "image/jpeg"], ["Mood board", "image/webp"], ["Clip at 0:02.0", "image/png"],
    ]);
    expect(next.imageScene).toBe(config.imageScene);
    expect(addReferenceImageAssets(next)).toBe(next);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(next))).assets).toEqual(next.assets);
  });

  it("adds images in the import's undo step and preserves removal across edits and reopening", () => {
    const config = project();
    const session = new ProjectSession({ config, folderPath: "D:/Images" }, vi.fn());
    session.edit((current) => ({ ...current, references: [{ id: "reference", name: "Photo", kind: "text", description: "", intendedUse: [], createdAt: config.createdAt,
      images: [{ id: "photo", name: "Photo", relativePath: "references/photo.png" }] }] }));
    const imported = session.getSnapshot().config;
    expect(imported.assets).toHaveLength(1);
    session.undo();
    expect(session.getSnapshot().config.assets).toEqual([]);
    expect(session.getSnapshot().config.references).toEqual([]);
    session.redo();
    expect(session.getSnapshot().config.assets).toEqual(imported.assets);
    session.edit((current) => ({ ...current, references: [...current.references, { ...current.references[0], id: "copy" }] }));
    expect(session.getSnapshot().config.assets).toHaveLength(1);
    session.edit((current) => ({ ...current, assets: [] }));
    session.edit((current) => ({ ...current, references: current.references.map((reference) => ({ ...reference, name: "Renamed" })) }));
    const reopened = new ProjectSession({ config: parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config))), folderPath: "D:/Images" }, vi.fn());
    expect(reopened.getSnapshot().config.assets).toEqual([]);
  });

  it("reuses an existing image asset when it is made into a reference", () => {
    const config = project();
    config.assets = [{ id: "image", kind: "image", name: "Photo", relativePath: "media/photo.png", mimeType: "image/png", createdAt: config.createdAt }];
    config.references = [{ id: "reference", name: "Photo", kind: "image", relativePath: "media/photo.png", description: "", intendedUse: [], createdAt: config.createdAt }];
    expect(addReferenceImageAssets(config)).toBe(config);
  });
});
