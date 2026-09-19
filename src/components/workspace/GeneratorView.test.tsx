// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneShots, type ProjectConfig } from "../../lib/project";
import { cancelSlopfabGeneration, getEngineStatus, type SlopfabStatus } from "../../lib/runtime";
import { GeneratorView } from "./GeneratorView";
import { minimaxOriginalTemplate, viggleAnimateTemplate, saveDebugOptionsEnabled } from "../../lib/settings";

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/runtime")>(),
  cancelSlopfabGeneration: vi.fn().mockResolvedValue(true),
  getEngineStatus: vi.fn(),
}));

beforeAll(() => vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(cleanup);

it("hides unfinished templates from the generator picker", () => {
  setup();
  fireEvent.click(screen.getByRole("combobox", { name: /Video generator template/ }));
  expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "First/Last Frame" })).toBeNull();
});

it("has no selected generator when all templates still need downloads", () => {
  localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [minimaxOriginalTemplate()], defaultTemplateId: "minimax-h3-original", catalogVersion: 1 }));
  setup();
  expect(screen.getByRole("combobox", { name: "Video generator template: No downloaded generators" })).toBeDisabled();
});

it("animates a blank scene only with a video and repainted frame", () => {
  const template = viggleAnimateTemplate();
  template.additionalSafetensors![0].downloadedPath = "conditioning.safetensors";
  template.paths = { transformer: "viggle.safetensors", textEncoder: "encoder", videoVae: "video", audioVae: "audio", tokenizer: "" };
  localStorage.setItem("slopus.loras.v1", JSON.stringify([{ id: template.loras![0].loraId, name: "Viggle", path: "distillation.safetensors", stepOverride: 4 }]));
  localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [template], defaultTemplateId: template.id, catalogVersion: 7 }));
  const initial = project();
  initial.generationJobs = [createDraftGenerationJob("", { id: "blank", title: "Blank scene" })];
  initial.references = [{ id: "motion", kind: "video", name: "Motion", description: "", intendedUse: [],
    sourcePath: "C:/motion.mp4", createdAt: "2026-09-15T00:00:00.000Z",
    video: { startSeconds: 1, durationSeconds: 3, includeAudio: false } },
    { id: "repainted", kind: "image", name: "Repainted frame", description: "", intendedUse: [],
      relativePath: "references/repainted.png", createdAt: "2026-09-15T00:00:00.000Z" }];
  const submitted = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(initial);
    return <GeneratorView config={config} folderPath="C:/project" runtime={readyRuntime}
      onChange={setConfig} onGenerate={submitted} onOpenTimeline={() => undefined} />;
  }
  render(<Harness />);
  const generate = within(screen.getByRole("region", { name: "Blank scene" })).getByRole("button", { name: "Generate" });
  expect(generate).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
  expect(submitted.mock.calls.flatMap(([items]) => items)).toHaveLength(0);
  expect(screen.queryByLabelText("The sound of this scene")).toBeNull();
  fireEvent.change(screen.getByLabelText("Reference video for this scene"), { target: { value: "motion" } });
  expect(generate).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Start frame for this scene"), { target: { value: "repainted" } });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(submitted).toHaveBeenLastCalledWith([expect.objectContaining({ request: expect.objectContaining({
    prompt: "", referenceVideos: [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 1, durationSeconds: 3, includeAudio: false }],
    referencePaths: ["C:/project/references/repainted.png"],
  }) })]);
  fireEvent.change(screen.getByLabelText("Start frame for this scene"), { target: { value: "" } });
  expect(generate).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Start frame for this scene"), { target: { value: "repainted" } });
  expect(generate).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Reference video for this scene"), { target: { value: "" } });
  expect(generate).toBeDisabled();
});

const readyRuntime: SlopfabStatus = {
  state: "ready",
  dllPath: "test",
  version: "test",
  platform: "CUDA 13",
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
    const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(() => new Set());
    latest = config;
    replace = (next) => setConfig(next);
    return <GeneratorView
      config={config}
      folderPath="C:\\project"
      runtime={readyRuntime}
      onChange={setConfig}
      onGenerate={(submissions) => setConfig((current) => ({ ...current, generationJobs: current.generationJobs.map((job) => {
        const submission = submissions.find((item) => item.job.id === job.id);
        return submission ? { ...job, status: "queued", stage: "queued", progress: 0, error: null, generationSnapshot: submission.snapshot } : job;
      }) }))}
      cancellingJobIds={cancellingIds}
      onCancelGeneration={async (ids) => {
        const next = ids.filter((id) => !cancellingIds.has(id));
        setCancellingIds((current) => new Set([...current, ...next]));
        await Promise.all(next.map((id) => cancelSlopfabGeneration(id)));
      }}
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
  it.each([["", "Watercolor"], ["claymation", "Claymation"]])("compiles scene Look %s with the project's default", async (sceneLook, expected) => {
    const initial = project();
    initial.settings.defaultLook = "watercolor";
    const state = setup(initial);
    const selector = screen.getByRole("combobox", { name: "The look of this scene" });
    expect(selector).toHaveValue("");
    expect(screen.getByText("Using project Look: Watercolor.")).toBeInTheDocument();
    if (sceneLook) fireEvent.change(selector, { target: { value: sceneLook } });
    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!).prompt).toContain(expected);
    if (!sceneLook) expect(sceneShots(state.latest().generationJobs[0])[0].settings?.visualStyle).toBeUndefined();
  });

  it("only shows debug prompts when enabled, in a closable popup outside the inspector", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Debug Prompt" })).not.toBeInTheDocument();
    act(() => saveDebugOptionsEnabled(true));
    const button = screen.getByRole("button", { name: "Debug Prompt" });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Debug Prompt" });
    expect(dialog.closest("aside")).toBeNull();
    expect(within(dialog).getByLabelText("The compiled MiniMax H3 prompt")).toHaveTextContent("Opening action");
    expect(within(dialog).getByRole("button", { name: "Close debug prompt" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(within(dialog).getByLabelText("The compiled MiniMax H3 prompt")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Close debug prompt" }));
    expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByRole("dialog", { name: "Debug Prompt" }).parentElement!);
    expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
    fireEvent.click(button);
    act(() => saveDebugOptionsEnabled(false));
    expect(screen.queryByRole("button", { name: "Debug Prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
  });

  it("sends a cited video with its trim and soundtrack choice in the generation snapshot", async () => {
    const initial = project();
    initial.references = [{ id: "motion", kind: "video", name: "Motion", description: "", sourcePath: "C:/motion.mp4", intendedUse: [], createdAt: initial.createdAt,
      video: { startSeconds: 2, durationSeconds: 3, includeAudio: false } }];
    initial.generationJobs[0].referenceIds = ["motion"];
    initial.generationJobs[0].shots![0].action = "Follow @[ref:motion].";
    const state = setup(parseProjectConfig(initial));
    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    const snapshot = JSON.parse(state.latest().generationJobs[0].generationSnapshot!);
    expect(snapshot.referenceVideos).toEqual([{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 2, durationSeconds: 3, includeAudio: false }]);
    expect(snapshot.referencePaths).toEqual([]);
    expect(snapshot.prompt).toContain("<Video 1>");
  });

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

  it("sends a last-frame image and clears it independently of the start frame", () => {
    const initial = project();
    initial.references = [{ id: "closing", kind: "image", name: "Closing still", description: "", relativePath: "references/closing.png", intendedUse: [], createdAt: initial.createdAt }];
    const state = setup(initial);
    fireEvent.change(screen.getByRole("combobox", { name: "Last frame for this scene" }), { target: { value: "closing" } });
    expect(state.latest().generationJobs[0].endFrameReferenceId).toBe("closing");
    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    const snapshot = JSON.parse(state.latest().generationJobs[0].generationSnapshot!);
    expect(snapshot.prompt).toContain("<Picture 1> is the last frame of the video.");
    expect(snapshot.referencePaths[0]).toContain("closing.png");
    fireEvent.change(screen.getByRole("combobox", { name: "Last frame for this scene" }), { target: { value: "" } });
    expect(state.latest().generationJobs[0].endFrameReferenceId).toBeUndefined();
  });

  it("marks a linked scene yellow when its previous scene regenerates and clears it after regeneration", () => {
    const initial = project();
    initial.generationJobs[0] = { ...initial.generationJobs[0], status: "completed", outputRelativePath: "media/generated/work-original.mp4", latentRelativePath: "latents/work-original.safetensors" };
    const state = setup(initial);
    expect(screen.getByRole("option", { name: "Previous scene's last frame" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Select scene Second scene" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Start frame for this scene" }), { target: { value: "previous-scene" } });
    expect(state.latest().generationJobs[1].usePreviousSceneLastFrame).toBe(true);
    const generateSecond = () => fireEvent.click(within(screen.getByRole("region", { name: "Second scene" })).getByRole("button", { name: "Generate" }));
    const finishSecond = () => state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 1 ? { ...job, status: "completed", outputRelativePath: "media/generated/work-second.mp4" } : job) });
    generateSecond();
    const snapshot = JSON.parse(state.latest().generationJobs[1].generationSnapshot!);
    expect(snapshot.previousSceneId).toBe("scene-first");
    expect(snapshot.continuationRelativePath).toBe("latents/work-original.safetensors");
    finishSecond();
    const second = () => screen.getByRole("region", { name: "Second scene" });
    expect(within(second()).getByText("FINISHED")).toBeInTheDocument();
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 0 ? { ...job, status: "generating" } : job) });
    expect(within(second()).getByText("CHANGED")).toBeInTheDocument();
    expect(second().querySelector(".scene-rule__status--changed")).not.toBeNull();
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 0 ? { ...job, status: "completed", outputRelativePath: "media/generated/work-new.mp4", latentRelativePath: "latents/work-new.safetensors" } : job) });
    expect(within(second()).getByText("CHANGED")).toBeInTheDocument();
    // Opening a saved project retains the dependency's recorded renderer inputs.
    state.replace(parseProjectConfig(JSON.parse(JSON.stringify(state.latest()))));
    expect(within(second()).getByText("CHANGED")).toBeInTheDocument();
    generateSecond();
    expect(JSON.parse(state.latest().generationJobs[1].generationSnapshot!).continuationRelativePath).toBe("latents/work-new.safetensors");
    finishSecond();
    expect(within(second()).getByText("FINISHED")).toBeInTheDocument();
  });

  it("includes fixed-seed linked scenes when Generate All regenerates their source", () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 42, outputRelativePath: `media/generated/work-${index}.mp4`, latentRelativePath: `latents/work-${index}.safetensors`, usePreviousSceneLastFrame: index === 1 }));
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job) => ({ ...job, status: "completed" })) });
    expect(screen.getByRole("button", { name: "Generate All" })).toHaveAttribute("title", "Every fixed-seed scene is already up to date.");
    fireEvent.change(screen.getByRole("textbox", { name: "The sound of this scene" }), { target: { value: "Rain" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
  });

  it("regenerates a completed source without latents when Generate All continues it", () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 42,
      outputRelativePath: `media/generated/work-${index}.mp4`, usePreviousSceneLastFrame: index === 1 }));
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    // Simulate an older completed project: matching snapshots, but no archives.
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job) => ({ ...job, status: "completed" })) });
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
  });

  it("shows scene generation controls and sends their values in the render snapshot", async () => {
    const initial = project();
    initial.settings = { ...initial.settings, resolution: "416p", frameRate: 60 };
    const state = setup(initial);
    const generation = screen.getByRole("region", { name: "Generation" });
    expect(within(generation).getByRole("spinbutton", { name: "Generation step count" })).toHaveValue(20);
    expect(within(generation).getByRole("spinbutton", { name: "Generation seed" })).toHaveValue(-1);

    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation step count" }), { target: { value: "28" } });
    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation seed" }), { target: { value: "9173" } });
    expect(state.latest().generationJobs[0]).toEqual(expect.objectContaining({ steps: 28, seed: 9173 }));

    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!)).toEqual(expect.objectContaining({
      steps: 28,
      seed: 9173,
      frames: 144,
      canvasWidth: 736,
      canvasHeight: 416,
    }));
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

  it("keeps an LLM-authored custom speech language in the language list", () => {
    const initial = project();
    initial.generationJobs[0].shots![0].speechLanguage = "Klingon";
    setup(parseProjectConfig(initial));
    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));

    const language = screen.getByRole("combobox", { name: "Speech language for shot 1" });
    expect(language).toHaveValue("Klingon");
    expect(within(language).getByRole("option", { name: "Klingon" })).toBeInTheDocument();
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

  it("selects a scene from its header and keeps confirmed removal in the inspector", () => {
    const state = setup();
    expect(screen.queryByText("DRAFT")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Draft/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "First scene length in seconds" }), { target: { value: "10" } });
    expect(state.latest().generationJobs[0].durationSeconds).toBe(10);
    expect(screen.queryByText("CHANGED")).not.toBeInTheDocument();

    const scene = screen.getByRole("region", { name: "First scene" });
    expect(within(scene).queryByRole("button", { name: "Remove scene First scene" })).not.toBeInTheDocument();
    expect(within(scene).queryByRole("button", { name: "Settings for First scene" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    fireEvent.click(scene.querySelector(".scene-rule")!);
    expect(screen.getByRole("textbox", { name: "Rename First scene" })).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole("complementary", { name: "Scene: First scene" })).getByRole("button", { name: "Remove scene First scene" }));
    expect(screen.getByRole("alertdialog", { name: "Remove scene?" })).toBeInTheDocument();
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove scene" }));
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second"]);
  });

  it("adds new scenes at the bottom", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a scene" }));
    expect(state.latest().generationJobs.slice(0, 2).map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    expect(state.latest().generationJobs.at(-1)?.title).toBe("Untitled scene");
  });

  it("uses the default generator template's steps for a new scene", () => {
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({
      defaultTemplateId: "draft",
      templates: [{
        id: "draft",
        name: "Draft",
        defaultSteps: 9,
        paths: { transformer: "", textEncoder: "", tokenizer: "", videoVae: "", audioVae: "" },
      }],
    }));
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a scene" }));
    expect(state.latest().generationJobs.at(-1)?.steps).toBe(9);
  });

  it("switches the active generator from the ready status control and probes its model paths", async () => {
    localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({
      defaultTemplateId: "quality",
      templates: [
        {
          id: "quality",
          name: "Quality",
          defaultSteps: 20,
          paths: { transformer: "quality.safetensors", textEncoder: "", tokenizer: "", videoVae: "", audioVae: "" },
        },
        {
          id: "draft",
          name: "Fast draft",
          defaultSteps: 8,
          paths: { transformer: "draft.safetensors", textEncoder: "", tokenizer: "", videoVae: "", audioVae: "" },
        },
      ],
    }));
    vi.mocked(getEngineStatus).mockResolvedValueOnce({
      state: "modelsMissing",
      dllPath: "test",
      version: "test",
      platform: "CUDA 13",
      detail: "Draft weights are missing.",
      models: [],
    });
    setup();

    expect(document.querySelector(".generator-runtime--ready > i")).not.toBeNull();
    expect(screen.getByText("Generator:")).toBeInTheDocument();
    expect(screen.queryByText("Video generator ready")).not.toBeInTheDocument();
    const template = screen.getByRole("combobox", { name: /Video generator template/ });
    expect(template).toHaveTextContent("Quality");
    fireEvent.click(template);
    fireEvent.click(screen.getByRole("option", { name: "Fast draft" }));

    await waitFor(() => expect(document.querySelector(".generator-runtime--modelsMissing > i")).not.toBeNull());
    expect(getEngineStatus).toHaveBeenCalledWith(expect.objectContaining({ transformer: "draft.safetensors" }), "sage2", [], "prompt", []);
    expect(JSON.parse(localStorage.getItem("slopus.generator-templates.v1")!).defaultTemplateId).toBe("draft");
    expect(screen.queryByText("Video model files missing")).not.toBeInTheDocument();
    expect(template.closest(".generator-runtime--modelsMissing")).not.toBeNull();
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
    const shotHeader = screen.getByRole("textbox", { name: "Rename shot 2" }).closest("header");
    const removeButton = within(shotHeader!).getByRole("button", { name: "Remove shot 2" });
    expect(removeButton).toHaveClass("inspector-remove-button");
    expect(removeButton).toHaveTextContent("");
    expect(sceneShots(state.latest().generationJobs[0])[1].name).toBe("Doorway reveal");
    expect(parseProjectConfig(state.latest()).generationJobs[0].shots?.[1].name).toBe("Doorway reveal");
    expect(screen.getByRole("button", { name: "Doorway reveal of First scene" })).toBeInTheDocument();

    fireEvent.click(removeButton);
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

  it("keeps Generate All available and skips unchanged completed fixed-seed scenes", async () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 100 + index }));
    const state = setup(initial);

    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    await waitFor(() => expect(state.latest().generationJobs.every((job) => job.status === "queued")).toBe(true));
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job) => ({
        ...job,
        status: "completed",
        stage: "completed",
        progress: 1,
        outputRelativePath: `media/generated/${job.id}.mp4`,
      })),
    });

    const generateAll = screen.getByRole("button", { name: "Generate All" });
    expect(generateAll).toBeEnabled();
    fireEvent.click(generateAll);
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["completed", "completed"]);

    const changed = state.latest().generationJobs[0];
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job) => job.id === changed.id
        ? { ...job, shots: sceneShots(job).map((shot, index) => index === 0 ? { ...shot, action: `${shot.action} Changed.` } : shot) }
        : job),
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "completed"]));
  });

  it("regenerates an unchanged completed random-seed scene while skipping fixed-seed output", async () => {
    const initial = project();
    initial.generationJobs[1].seed = 417;
    const state = setup(initial);

    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    await waitFor(() => expect(state.latest().generationJobs.every((job) => job.status === "queued")).toBe(true));
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job) => ({
        ...job,
        status: "completed",
        stage: "completed",
        progress: 1,
        outputRelativePath: `media/generated/${job.id}.mp4`,
      })),
    });

    fireEvent.click(screen.getByRole("button", { name: "Generate All" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "completed"]));
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
    await waitFor(() => expect(cancelSlopfabGeneration).toHaveBeenCalledWith("scene-first"));
    const cancelling = within(first).getAllByRole("img", { name: /Cancelling\.\.\.$/ });
    expect(cancelling).toHaveLength(2);
    expect(cancelling.every((thumbnail) => thumbnail.querySelector(".spin"))).toBe(true);
    expect(within(first).queryByText("Rendering 42%")).not.toBeInTheDocument();

    vi.mocked(cancelSlopfabGeneration).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel All" }));
    await waitFor(() => {
      expect(cancelSlopfabGeneration).toHaveBeenCalledTimes(1);
      expect(cancelSlopfabGeneration).toHaveBeenCalledWith("scene-second");
    });
  });
});
