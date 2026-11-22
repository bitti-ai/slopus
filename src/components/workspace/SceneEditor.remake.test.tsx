// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { createDraftGenerationJob, projectReferenceSchema, sceneShots, type GenerationJob } from "../../lib/project";
import { newH3Templates } from "../../lib/settings";
import { SceneInspector } from "./SceneEditor";

afterEach(cleanup);

it("authors ordered Remake pins and clears them when painted images change", () => {
  const references = ["Opening", "Ending"].map((name) => projectReferenceSchema.parse({ id: name, name,
    kind: "image", description: "Painted frame", relativePath: `references/${name}.png`, createdAt: new Date().toISOString() }));
  let latest!: GenerationJob;
  function Inspector() {
    const [job, setJob] = useState(() => ({ ...createDraftGenerationJob("A robot waves", { sceneType: "remake", durationSeconds: 5 }), referenceIds: ["Opening", "Ending"] }));
    latest = job;
    return <SceneInspector job={job} shots={sceneShots(job)} references={references} defaultSteps={6}
      template={newH3Templates().find((entry) => entry.mode === "remake-swap")} disabled={false} importAvailable={false}
      importError={null} onAddStartFrame={() => {}} onAddEndFrame={() => {}} onShots={() => {}}
      onChange={(updates) => setJob((current) => ({ ...current, ...updates }))} />;
  }
  render(<Inspector />);
  fireEvent.click(screen.getByLabelText("Enable Remake timeline pins"));
  expect(latest.remakePins).toEqual([0, 0]);
  const ending = screen.getByLabelText("Remake picture 2 frame");
  fireEvent.change(ending, { target: { value: "60" } });
  fireEvent.blur(ending);
  expect(latest.remakePins).toEqual([0, 60]);
  const release = screen.getByLabelText("Remake keyframe release");
  fireEvent.change(release, { target: { value: "0.8" } });
  fireEvent.blur(release);
  expect(latest.remakeKeyframeUntil).toBe(0.8);
  fireEvent.click(screen.getByLabelText("Ending"));
  expect(latest.remakePins).toBeUndefined();
  expect(screen.queryByLabelText("Remake picture 2 frame")).toBeNull();
});
