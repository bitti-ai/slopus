import { expect, it } from "vitest";
import { compileGenerationJobPrompt, compileGenerationJobSegments, createDraftGenerationJob, generationJobSchema, sceneGenerationReferences, type ProjectReference } from "./project";
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
  expect(prompt).toContain("neutral studio");
  expect(prompt).not.toContain("cinematic");
  expect(prompt).toContain(`remains the same solid ${backdropColor} (${BACKDROP_COLORS[backdropColor]}) in every frame`);
  expect(prompt).not.toContain("<Picture");
  expect(prompt).toBe(compileGenerationJobPrompt(job, sceneGenerationReferences(job, references)));
});

it.each(["text", "image", "refmod"])("limits %s reference guidance to appearance and describes the background in every shot", (kind) => {
  const reference: ProjectReference = { id: "subject", name: "Subject", kind: "text", description: kind === "refmod" ? "" : "A red robot in a forest", intendedUse: [], createdAt: "2026-10-09T00:00:00Z",
    ...(kind === "image" ? { images: [{ id: "image", name: "Robot", sourcePath: "C:/robot.png" }] } : {}),
    ...(kind === "refmod" ? { refmods: [{ id: "encoded", name: "Robot", sourcePath: "C:/robot.safetensors", strength: 1, copies: 1 }] } : {}),
  };
  const job = { ...createDraftGenerationJob("", { sceneType: "backdrop" }), shots: [
    { id: "first", startSeconds: 0, action: "@[ref:subject]Walking cycle from side, full body shot." },
    { id: "second", startSeconds: 2, action: "@[ref:subject]'s arms swing." },
  ] };
  const segments = compileGenerationJobSegments(job, [reference]);
  const prompt = segments.map((segment) => segment.value).join("");
  const definitions = prompt.split("\n\nsummary:")[0];
  expect(definitions).toContain("appearance and identity only");
  expect(definitions).toContain("environmental lighting are replaced");
  if (kind === "refmod") {
    expect(definitions).toContain("pre-encoded reference");
    expect(prompt).not.toContain("<Picture");
  }
  expect(prompt).toContain("<Subject 1> Walking cycle");
  expect(prompt).toContain("<Subject 1>'s arms swing.");
  const detailed = prompt.split("detailed_description:\n")[1].split("\n\noverall_soundscape:")[0];
  expect(detailed).toMatch(/^The target video is in a neutral studio style\./);
  for (const shot of detailed.split(/\[Shot \d+\]/).slice(1)) {
    expect(shot).toContain("newly revealed areas during movement");
    expect(shot).toContain("#00ff00");
  }
  const summary = prompt.split("summary:\n")[1].split("\n\nretention_analysis:")[0];
  expect(summary).toMatch(/^\[reference generation\] An isolated-subject compositing plate/);
  expect(summary).not.toContain("No visible scenery");
});

it("preserves chosen and described styles while limiting grading to the subject", () => {
  const job = createDraftGenerationJob("A claymation dancer spins.", { sceneType: "backdrop" });
  expect(compileGenerationJobPrompt(job)).toContain("Claymation");
  const chosen = { ...job, shots: [{ id: "first", startSeconds: 0, action: "A dancer spins.", settings: { visualStyle: ["watercolor"] } }] };
  expect(compileGenerationJobPrompt(chosen)).toContain("Watercolor");
  const prompt = compileGenerationJobPrompt({ ...chosen, shots: [{ ...chosen.shots[0], settings: null }] }, [], "live-action-cinematic");
  expect(prompt).toContain("Live-action, cinematic");
  expect(prompt).toContain("lighting and color grading affect the subject alone");
});

it("uses green by default and retains explicitly cited subject references", () => {
  const job = createDraftGenerationJob("@[ref:subject] spins.", { sceneType: "backdrop" });
  const references: ProjectReference[] = [{ id: "subject", name: "Dancer", kind: "text", description: "A red robot", intendedUse: [], createdAt: "2026-10-09T00:00:00Z" }];
  expect(sceneGenerationReferences(job, references)).toEqual(references);
  expect(compileGenerationJobPrompt(job, references)).toContain("solid green");
  expect(compileGenerationJobPrompt(job, references)).toContain("partially_preserved");
  expect(generationJobSchema.safeParse({ ...job, backdropColor: "red" }).success).toBe(false);
});
