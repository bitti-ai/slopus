import { expect, it } from "vitest";
import { referenceMediaTypes, selectReferences } from "./referenceSelection";
import type { ProjectReference } from "./project";

const reference = (id: string, patch: Partial<ProjectReference> = {}): ProjectReference => ({ id, name: id, kind: "text", description: "", intendedUse: [], createdAt: "2026-01-01T00:00:00.000Z", ...patch });

it("selects real image payloads including attachments and video stills, but not generated icons or videos", () => {
  const references = [
    reference("legacy", { kind: "image", sourcePath: "D:/picture.png" }),
    reference("attached", { images: [{ id: "image", name: "Image", relativePath: "references/image.png" }] }),
    reference("frames", { kind: "video", sourcePath: "D:/clip.mp4", video: { mode: "frames", startSeconds: 0, durationSeconds: 3, includeAudio: false, frames: [{ id: "frame", name: "Frame", relativePath: "references/frame.png", timeSeconds: 1 }] } }),
    reference("video", { kind: "video", sourcePath: "D:/clip.mp4" }),
    reference("audio", { kind: "audio", sourcePath: "D:/voice.wav" }),
    reference("icon", { description: "An illustrated character", iconRelativePath: "references/icon.png" }),
    reference("empty"),
  ];
  expect(selectReferences(references, ["image"]).map((ref) => ref.id)).toEqual(["legacy", "attached", "frames"]);
  expect(selectReferences(references, ["audio"]).map((ref) => ref.id)).toEqual(["audio"]);
  expect(selectReferences(references, ["image", "audio"]).map((ref) => ref.id)).toEqual(["legacy", "attached", "frames", "audio"]);
  expect(selectReferences(references, ["video"]).map((ref) => ref.id)).toEqual(["video"]);
});

it("recognizes mixed reference payloads without duplicate options, and ignores inactive refmods", () => {
  const mixed = reference("mixed", { description: "Red coat", images: [{ id: "image", name: "Coat", relativePath: "references/coat.png" }],
    refmods: [{ id: "encoded", name: "Coat", relativePath: "references/coat.safetensors", strength: 1, copies: 1 }] });
  expect(referenceMediaTypes(mixed)).toEqual(["image", "text", "refmod"]);
  expect(selectReferences([mixed], ["image", "text", "refmod"])).toEqual([mixed]);
  expect(selectReferences([{ ...mixed, refmods: mixed.refmods!.map((refmod) => ({ ...refmod, strength: 0 })) }], ["refmod"])).toEqual([]);
  expect(selectReferences([mixed], [])).toEqual([]);
});
