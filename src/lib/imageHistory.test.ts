import { describe, expect, it } from "vitest";
import { completeImageDraft, imageFamilyRoot, imageGenerationSnapshot, removeImageAsset, restoreGeneratedImage, saveImageDraft } from "./imageHistory";
import { imageGenerationSnapshotSchema, parseProjectConfig } from "./project";
import fixture from "../../fixtures/project-v1-image.json";
import snapshotFixture from "../../fixtures/image-generation-snapshot.json";
import { createImageEditScene } from "./imageScene";

describe("generated image history", () => {
  it("preserves a whole-image prompt and linked references as a new draft of a saved image", () => {
    const config = parseProjectConfig(fixture);
    const source = { relativePath: "media/generated/source.png", name: "Source", width: 101, height: 77 };
    config.assets = [{ id: "saved", kind: "image", ...source, mimeType: "image/png", createdAt: config.createdAt }];
    config.imageScene = { ...createImageEditScene(source), outputAssetId: "saved" };
    config.imageScene.nodes[0].description = "Make the lighting warmer";
    config.imageScene.nodes[0].referenceIds = ["mood"];
    config.references = [{ id: "mood", name: "Mood", kind: "text", description: "Warm sunset", intendedUse: [], createdAt: config.createdAt }];
    const saved = saveImageDraft(config, "test");
    expect(saved.assets).toHaveLength(2);
    expect(saved.imageScene!.outputAssetId).not.toBe("saved");
    const reopened = parseProjectConfig(JSON.parse(JSON.stringify(saved)));
    reopened.references = [];
    const restored = restoreGeneratedImage(reopened, saved.imageScene!.outputAssetId!);
    expect(restored.references).toEqual(config.references);
    expect(restored.imageScene!.nodes[0]).toMatchObject({ description: "Make the lighting warmer", referenceIds: ["mood"] });
    const snapshot = reopened.assets[1].imageGeneration!;
    expect(imageGenerationSnapshotSchema.safeParse({ ...snapshot, references: [] }).success).toBe(false);
  });
  it("restores saved inputs and references after reopening without changing other results", () => {
    const config = parseProjectConfig(fixture);
    const snapshot = imageGenerationSnapshotSchema.parse(snapshotFixture);
    config.assets = [{ id: "result", kind: "image", name: "Lantern", relativePath: "media/generated/lantern.jpg", mimeType: "image/jpeg", createdAt: config.createdAt, imageGeneration: snapshot }];
    config.references = [
      { ...snapshot.references[0], description: "Later reference edit" },
      { id: "unrelated", name: "Unrelated", kind: "text", description: "Keep this", intendedUse: [], createdAt: config.createdAt },
    ];
    const reopened = parseProjectConfig(JSON.parse(JSON.stringify(config)));
    const restored = restoreGeneratedImage(reopened, "result");
    expect(restored.imageScene).toEqual({ ...snapshot.scene, outputAssetId: "result" });
    expect(restored.settings).toMatchObject({ resolution: "1088p", aspectRatio: "4:5", defaultLook: "watercolor" });
    expect(restored.brief.prompt).toBe(snapshot.briefPrompt);
    expect(restored.references).toEqual([snapshot.references[0], config.references[1]]);
    expect(restored.assets).toEqual(config.assets);
    restored.imageScene!.nodes[0].description = "New edit";
    restored.references[0].refmods![0].strength = 0;
    expect(restored.assets[0].imageGeneration).toEqual(snapshotFixture);
    reopened.references = [];
    expect(restoreGeneratedImage(reopened, "result").references).toEqual(snapshot.references);
  });

  it("captures an independent snapshot and preserves legacy images without inventing history", () => {
    const config = parseProjectConfig(fixture);
    const snapshot = imageGenerationSnapshot(config, "Exact submitted prompt", "generator");
    config.imageScene!.nodes[0].description = "Later edit";
    config.settings.resolution = "1344p";
    expect(snapshot.scene.nodes[0].description).not.toBe("Later edit");
    expect(snapshot.resolution).toBe("768p");
    expect(snapshot.prompt).toBe("Exact submitted prompt");
    expect(snapshot.scene.outputAssetId).toBeNull();
    config.assets = [{ id: "legacy", kind: "image", name: "Legacy", relativePath: "media/generated/legacy.jpg", mimeType: "image/jpeg", createdAt: config.createdAt }];
    const restored = restoreGeneratedImage(config, "legacy");
    expect(restored.imageScene).toEqual({ ...config.imageScene, outputAssetId: "legacy" });
    expect(restored.settings).toEqual(config.settings);
  });

  it("rejects corrupt snapshot trees and missing or duplicate reference definitions", () => {
    const snapshot = structuredClone(snapshotFixture);
    snapshot.scene.nodes[1].parentId = "missing";
    expect(imageGenerationSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(imageGenerationSnapshotSchema.safeParse({ ...snapshotFixture, references: [] }).success).toBe(false);
    expect(imageGenerationSnapshotSchema.safeParse({ ...snapshotFixture, references: [...snapshotFixture.references, ...snapshotFixture.references] }).success).toBe(false);
  });

  it("leaves image-root mode when selecting an older result without a snapshot", () => {
    const config = parseProjectConfig(fixture);
    config.imageScene = createImageEditScene({ relativePath: "media/imported/source.png", name: "Source", width: 65, height: 41 });
    config.assets = [{ id: "legacy", kind: "image", name: "Legacy", relativePath: "media/generated/legacy.jpg", mimeType: "image/jpeg", createdAt: config.createdAt }];
    const restored = restoreGeneratedImage(config, "legacy");
    expect(restored.imageScene!.rootType).not.toBe("image");
    expect(restored.imageScene!.outputAssetId).toBe("legacy");
    expect(restored.imageScene!.sourceImage).toBeUndefined();
  });
  it("puts an edit of any image in its original's family, one level deep", () => {
    const config = parseProjectConfig(fixture);
    const image = (id: string, parentAssetId?: string) => ({ id, name: id, kind: "image" as const, relativePath: `media/generated/${id}.png`, mimeType: "image/png", width: 101, height: 77, createdAt: config.createdAt, ...(parentAssetId ? { parentAssetId } : {}) });
    config.assets = [image("original"), image("child", "original")];
    expect(imageFamilyRoot(config.assets, "child")).toBe("original");
    expect(imageFamilyRoot(config.assets, "original")).toBe("original");
    // Editing the child starts a draft in the original's family, not the child's.
    config.imageScene = createImageEditScene({ relativePath: "media/generated/child.png", name: "child", width: 101, height: 77 });
    const drafted = saveImageDraft(config, "test");
    const draft = drafted.assets.find((asset) => asset.imageDraft)!;
    expect(draft.parentAssetId).toBe("original");
    // Generating it keeps the family.
    const done = completeImageDraft(drafted, draft.id, { ...image(draft.id), imageGeneration: draft.imageGeneration });
    expect(done.assets.find((asset) => asset.id === draft.id)).toMatchObject({ imageDraft: false, parentAssetId: "original" });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(done))).assets).toEqual(done.assets);
    // An imported file starts a family of its own.
    config.imageScene = createImageEditScene({ relativePath: "media/imported/photo.png", name: "photo", width: 101, height: 77 });
    expect(saveImageDraft(config, "test").assets.find((asset) => asset.imageDraft)!.parentAssetId).toBeUndefined();
  });

  it("keeps a family together when its original is removed", () => {
    const config = parseProjectConfig(fixture);
    const image = (id: string, parentAssetId?: string) => ({ id, name: id, kind: "image" as const, relativePath: `media/generated/${id}.jpg`, mimeType: "image/jpeg", createdAt: config.createdAt, ...(parentAssetId ? { parentAssetId } : {}) });
    const assets = removeImageAsset([image("a"), image("b", "a"), image("c", "a"), image("d")], "a");
    expect(assets.map((asset) => [asset.id, asset.parentAssetId])).toEqual([["b", undefined], ["c", "b"], ["d", undefined]]);
  });
});
