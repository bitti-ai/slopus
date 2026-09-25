import { describe, expect, it } from "vitest";
import { imageGenerationSnapshot, restoreGeneratedImage } from "./imageHistory";
import { imageGenerationSnapshotSchema, parseProjectConfig } from "./project";
import fixture from "../../fixtures/project-v1-image.json";
import snapshotFixture from "../../fixtures/image-generation-snapshot.json";
import { createImageEditScene } from "./imageScene";

describe("generated image history", () => {
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
});
