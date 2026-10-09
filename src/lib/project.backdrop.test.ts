import { expect, it } from "vitest";
import { compileGenerationJobPrompt, createDraftGenerationJob, generationJobSchema, sceneGenerationReferences, type ProjectReference } from "./project";
import { BACKDROP_COLORS } from "./backdrop";

it.each(["green", "blue", "black", "white"] as const)("compiles and preserves a %s backdrop without stale frame anchors", (backdropColor) => {
  const job = { ...createDraftGenerationJob("A dancer spins.", { sceneType: "backdrop" }), backdropColor,
    startFrameReferenceId: "old", endFrameReferenceId: "old", usePreviousSceneLastFrame: true };
  const references: ProjectReference[] = [{ id: "old", name: "Old setting", kind: "text", description: "A forest", intendedUse: [],
    images: [{ id: "image", name: "Forest", sourcePath: "C:/forest.png" }], createdAt: "2026-10-09T00:00:00Z" }];
  expect(generationJobSchema.parse(JSON.parse(JSON.stringify(job)))).toEqual(job);
  expect(sceneGenerationReferences(job, references)).toEqual([]);
  const prompt = compileGenerationJobPrompt(job, references);
  expect(prompt).toContain(`solid ${backdropColor} (${BACKDROP_COLORS[backdropColor]})`);
  expect(prompt).toContain("A dancer spins.");
  expect(prompt).not.toContain("<Picture");
  expect(prompt).toBe(compileGenerationJobPrompt(job, sceneGenerationReferences(job, references)));
});

it("uses green by default and retains explicitly cited subject references", () => {
  const job = createDraftGenerationJob("@[ref:subject] spins.", { sceneType: "backdrop" });
  const references: ProjectReference[] = [{ id: "subject", name: "Dancer", kind: "text", description: "A red robot", intendedUse: [], createdAt: "2026-10-09T00:00:00Z" }];
  expect(sceneGenerationReferences(job, references)).toEqual(references);
  expect(compileGenerationJobPrompt(job, references)).toContain("solid green");
  expect(generationJobSchema.safeParse({ ...job, backdropColor: "red" }).success).toBe(false);
});
