// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneShots, type ProjectConfig } from "../../lib/project";
import type { VidfabStatus } from "../../lib/runtime";
import { GeneratorView } from "./GeneratorView";

afterEach(cleanup);

const readyRuntime: VidfabStatus = {
  state: "ready",
  dllPath: "test",
  version: "test",
  detail: "Ready",
  models: [],
};

const project = (): ProjectConfig => {
  const base = createProjectConfig({
    name: "Drag test",
    prompt: "Opening action",
    aspectRatio: "16:9",
    resolution: "1080p",
    targetDurationSeconds: 20,
  });
  const now = "2026-08-22T00:00:00.000Z";
  const first = createDraftGenerationJob("Opening action", {
    id: "scene-first",
    title: "First scene",
    now,
    durationSeconds: 6,
    shots: [
      { id: "shot-first-a", startSeconds: 0, action: "Opening action" },
      { id: "shot-first-b", startSeconds: 3, action: "Second action" },
    ],
  });
  const second = createDraftGenerationJob("Another scene", {
    id: "scene-second",
    title: "Second scene",
    now,
    durationSeconds: 8,
    shots: [{ id: "shot-second-a", startSeconds: 0, action: "Another scene" }],
  });
  return { ...base, generationJobs: [first, second] };
};

const transfer = (): DataTransfer => {
  const data = new Map<string, string>();
  const value = {
    effectAllowed: "none",
    get types() { return [...data.keys()]; },
    setData(type: string, content: string) { data.set(type, content); },
    getData(type: string) { return data.get(type) ?? ""; },
  };
  return value as unknown as DataTransfer;
};

function setup() {
  let latest = project();
  function Harness() {
    const [config, setConfig] = useState(latest);
    latest = config;
    return <GeneratorView
      config={config}
      folderPath="C:\\project"
      runtime={readyRuntime}
      onChange={setConfig}
      onOpenTimeline={() => undefined}
    />;
  }
  render(<Harness />);
  return { latest: () => latest };
}

describe("Generator scene controls", () => {
  it("reorders shots inside a scene while keeping its cut slots", () => {
    const state = setup();
    const shotTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Shot 1 of First scene" }), { dataTransfer: shotTransfer });
    fireEvent.drop(screen.getByRole("button", { name: "Add a shot to First scene" }).parentElement!, { dataTransfer: shotTransfer });

    const first = state.latest().generationJobs.find((job) => job.id === "scene-first")!;
    expect(sceneShots(first).map((shot) => shot.id)).toEqual(["shot-first-b", "shot-first-a"]);
    expect(sceneShots(first).map((shot) => shot.startSeconds)).toEqual([0, 3]);
  });

  it("reorders scenes and moves shots between scenes by drag and drop", () => {
    const state = setup();

    const sceneTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Drag Second scene to reorder scenes" }), { dataTransfer: sceneTransfer });
    fireEvent.drop(screen.getByRole("region", { name: "First scene" }), { dataTransfer: sceneTransfer });
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second", "scene-first"]);

    const shotTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Shot 2 of First scene" }), { dataTransfer: shotTransfer });
    fireEvent.drop(screen.getByRole("button", { name: "Shot 1 of Second scene" }).parentElement!, { dataTransfer: shotTransfer });

    const source = state.latest().generationJobs.find((job) => job.id === "scene-first")!;
    const target = state.latest().generationJobs.find((job) => job.id === "scene-second")!;
    expect(sceneShots(source).map((shot) => shot.id)).toEqual(["shot-first-a"]);
    expect(sceneShots(target).map((shot) => shot.id)).toEqual(["shot-first-b", "shot-second-a"]);
    expect(sceneShots(target).map((shot) => shot.startSeconds)).toEqual([0, 4]);
  });

  it("puts scene length and confirmed removal in the header without a Draft indicator", () => {
    const state = setup();
    expect(screen.queryByText("DRAFT")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Draft/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "First scene length in seconds" }), { target: { value: "10" } });
    expect(state.latest().generationJobs[0].durationSeconds).toBe(10);

    fireEvent.click(screen.getByRole("button", { name: "Remove scene First scene" }));
    expect(screen.getByRole("alertdialog", { name: "Remove scene?" })).toBeInTheDocument();
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove scene" }));
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second"]);
  });

  it("renames a shot and confirms before removing it", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Shot 2 of First scene" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename shot 2" }), { target: { value: "Doorway reveal" } });
    expect(sceneShots(state.latest().generationJobs[0])[1].name).toBe("Doorway reveal");
    expect(parseProjectConfig(state.latest()).generationJobs[0].shots?.[1].name).toBe("Doorway reveal");
    expect(screen.getByRole("button", { name: "Doorway reveal of First scene" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove shot 2" }));
    expect(screen.getByRole("alertdialog", { name: "Remove shot?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sceneShots(state.latest().generationJobs[0])).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove shot 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove shot" }));
    expect(sceneShots(state.latest().generationJobs[0])).toHaveLength(1);
  });

  it("queues every valid draft from Generate All", async () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]));
  });
});
