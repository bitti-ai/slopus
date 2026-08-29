// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneShots, type ProjectConfig } from "../../lib/project";
import { cancelVidfabGeneration, type VidfabStatus } from "../../lib/runtime";
import { GeneratorView } from "./GeneratorView";

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/runtime")>(),
  cancelVidfabGeneration: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => vi.clearAllMocks());
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

function setup(initial = project()) {
  let latest = initial;
  let replace: (next: ProjectConfig) => void = () => undefined;
  function Harness() {
    const [config, setConfig] = useState(latest);
    latest = config;
    replace = (next) => setConfig(next);
    return <GeneratorView
      config={config}
      folderPath="C:\\project"
      runtime={readyRuntime}
      onChange={setConfig}
      onOpenTimeline={() => undefined}
    />;
  }
  render(<Harness />);
  return {
    latest: () => latest,
    replace: (next: ProjectConfig) => act(() => replace(next)),
  };
}

async function finishFirst(state: ReturnType<typeof setup>) {
  fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
  await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
  state.replace({
    ...state.latest(),
    generationJobs: state.latest().generationJobs.map((job, index) => index === 0 ? {
      ...job,
      status: "completed",
      stage: "completed",
      progress: 1,
    } : job),
  });
}

describe("Generator scene controls", () => {
  it("offers no inferred Look and sends a selected image as the scene's first frame", async () => {
    const initial = project();
    initial.references = [{
      id: "ref-opening",
      kind: "image",
      name: "Opening still",
      description: "",
      relativePath: "references/opening.jpg",
      intendedUse: [],
      createdAt: initial.createdAt,
    }];
    const state = setup(parseProjectConfig(initial));

    expect(within(screen.getByRole("combobox", { name: "The look of this scene" })).getByRole("option", { name: "None" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Start frame for this scene" }), { target: { value: "ref-opening" } });
    expect(state.latest().generationJobs[0].startFrameReferenceId).toBe("ref-opening");

    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    const snapshot = JSON.parse(state.latest().generationJobs[0].generationSnapshot!);
    expect(snapshot.referencePaths).toEqual(["C:\\\\project\\references\\opening.jpg"]);
    expect(snapshot.prompt).toContain("<Picture 1> is the first frame of the video.");
  });

  it("shows scene generation controls and sends their values in the render snapshot", async () => {
    const state = setup();
    const generation = screen.getByRole("region", { name: "Generation" });
    expect(within(generation).getByRole("spinbutton", { name: "Generation step count" })).toHaveValue(20);
    expect(within(generation).getByRole("spinbutton", { name: "Generation seed" })).toHaveValue(-1);

    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation step count" }), { target: { value: "28" } });
    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation seed" }), { target: { value: "9173" } });
    expect(state.latest().generationJobs[0]).toEqual(expect.objectContaining({ steps: 28, seed: 9173 }));

    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!)).toEqual(expect.objectContaining({ steps: 28, seed: 9173 }));
  });

  it("edits shot speech and sends it with the selected language in dialogue tags", async () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));

    const speech = screen.getByRole("textbox", { name: "Speech for shot 1" });
    const language = screen.getByRole("combobox", { name: "Speech language for shot 1" });
    expect(speech).toHaveValue("");
    expect(language).toHaveValue("English");

    fireEvent.change(language, { target: { value: "Korean" } });
    fireEvent.change(speech, { target: { value: "문을 열어 주세요." } });
    expect(sceneShots(state.latest().generationJobs[0])[0]).toEqual(expect.objectContaining({
      speech: "문을 열어 주세요.",
      speechLanguage: "Korean",
    }));

    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    const snapshot = JSON.parse(state.latest().generationJobs[0].generationSnapshot!);
    expect(snapshot.prompt).toContain("<d>[Korean] 문을 열어 주세요.</d>");
  });

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
    expect(screen.queryByText("CHANGED")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove scene First scene" }));
    expect(screen.getByRole("alertdialog", { name: "Remove scene?" })).toBeInTheDocument();
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove scene" }));
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second"]);
  });

  it("adds new scenes at the bottom", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add Scene" }));
    expect(state.latest().generationJobs.slice(0, 2).map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    expect(state.latest().generationJobs.at(-1)?.title).toBe("Untitled scene");
  });

  it("marks a finished scene yellow when scene settings change", async () => {
    const state = setup();
    await finishFirst(state);
    const scene = screen.getByRole("region", { name: "First scene" });
    expect(within(scene).getByText("FINISHED")).toBeInTheDocument();
    expect(scene.querySelector(".scene-rule__status--completed")).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "The sound of this scene" }), { target: { value: "Soft rain." } });
    expect(within(scene).getByText("CHANGED")).toBeInTheDocument();
    expect(scene.querySelector(".scene-rule__status--changed")).not.toBeNull();
  });

  it("keeps scene and shot settings editable during generation and marks the finished scene changed", async () => {
    const state = setup();
    const scene = screen.getByRole("region", { name: "First scene" });
    fireEvent.click(within(scene).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].status).toBe("queued"));
    const sent = state.latest().generationJobs[0].generationSnapshot;
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job, index) => index === 0
        ? { ...job, status: "generating", stage: "generating", progress: 0.4 }
        : job),
    });

    const sound = screen.getByRole("textbox", { name: "The sound of this scene" });
    expect(sound).toBeEnabled();
    fireEvent.change(sound, { target: { value: "Rain added while this run is rendering." } });

    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    const addSetting = screen.getByRole("combobox", { name: "Add a setting to shot 1" });
    expect(addSetting).toBeEnabled();
    fireEvent.change(addSetting, { target: { value: "shotSize" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Value for Shot size on shot 1" }), { target: { value: "close-up" } });
    expect(state.latest().generationJobs[0].generationSnapshot).toBe(sent);

    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job, index) => index === 0
        ? { ...job, status: "completed", stage: "completed", progress: 1 }
        : job),
    });
    const finished = screen.getByRole("region", { name: "First scene" });
    expect(within(finished).getByText("CHANGED")).toBeInTheDocument();
    expect(finished.querySelector(".scene-rule__status--changed")).not.toBeNull();
  });

  it("marks a finished scene changed when shot settings or order change", async () => {
    const state = setup();
    await finishFirst(state);
    const scene = screen.getByRole("region", { name: "First scene" });

    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    expect(screen.getByText("Describe the shot")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Add a setting to shot 1" }), { target: { value: "shotSize" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Value for Shot size on shot 1" }), { target: { value: "close-up" } });
    expect(within(scene).getByText("CHANGED")).toBeInTheDocument();

    fireEvent.click(within(scene).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].status).toBe("queued"));
    const regenerated = state.latest().generationJobs[0];
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job, index) => index === 0
        ? { ...regenerated, status: "completed", stage: "completed", progress: 1 }
        : job),
    });
    expect(within(scene).getByText("FINISHED")).toBeInTheDocument();

    const shotTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Shot 1 of First scene" }), { dataTransfer: shotTransfer });
    fireEvent.drop(screen.getByRole("button", { name: "Add a shot to First scene" }).parentElement!, { dataTransfer: shotTransfer });
    expect(within(scene).getByText("CHANGED")).toBeInTheDocument();
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
    expect(state.latest().generationJobs.every((job) => Boolean(job.generationSnapshot))).toBe(true);
    expect(parseProjectConfig(state.latest())).toBeTruthy();
  });

  it("turns active generation actions into per-scene and batch cancellation", async () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({
      ...job,
      status: index === 0 ? "generating" : "queued",
      stage: index === 0 ? "generating" : "queued",
      progress: index === 0 ? 0.42 : 0,
    }));
    setup(initial);

    const first = screen.getByRole("region", { name: "First scene" });
    const second = screen.getByRole("region", { name: "Second scene" });
    expect(within(first).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(second).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel All" })).toBeEnabled();
    expect(within(first).getAllByText("Rendering 42%")).toHaveLength(2);
    const progressBars = first.querySelectorAll(".shot-thumb__progress > i");
    expect(progressBars).toHaveLength(2);
    expect([...progressBars].every((bar) => (bar as HTMLElement).style.width === "42%")).toBe(true);
    expect(within(first).queryByText("RENDERING")).not.toBeInTheDocument();

    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelVidfabGeneration).toHaveBeenCalledWith("scene-first"));
    const cancelling = within(first).getAllByRole("img", { name: /Cancelling\.\.\.$/ });
    expect(cancelling).toHaveLength(2);
    expect(cancelling.every((thumbnail) => thumbnail.querySelector(".spin"))).toBe(true);
    expect(within(first).queryByText("Rendering 42%")).not.toBeInTheDocument();

    vi.mocked(cancelVidfabGeneration).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel All" }));
    await waitFor(() => {
      expect(cancelVidfabGeneration).toHaveBeenCalledTimes(1);
      expect(cancelVidfabGeneration).toHaveBeenCalledWith("scene-second");
    });
  });
});
