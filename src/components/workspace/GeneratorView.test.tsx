// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftGenerationJob, createProjectConfig, parseProjectConfig, sceneShots, type ProjectConfig } from "../../lib/project";
import { cancelSlopfabGeneration, getEngineStatus, type SlopfabStatus } from "../../lib/runtime";
import { askNative } from "../../lib/nativeShell";
import { GeneratorView, templateSceneBlocker } from "./GeneratorView";
import { ReferencesView } from "./ReferencesView";
import { choose, chooseOption, comboValue, optionNames } from "./comboTestUtils";
import { chooseReference, changePromptChip, insertPromptReference, placePromptCaret, typePrompt } from "./promptTestUtils";
import { minimaxOriginalTemplate, viggleAnimateTemplate, saveDebugOptionsEnabled } from "../../lib/settings";

vi.mock("../../lib/nativeShell", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/nativeShell")>(),
  askNative: vi.fn().mockResolvedValue(true),
}));

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

it("queues Long Shot anchors before their intervening bridges", () => {
  const initial = project();
  initial.generationJobs = Array.from({ length: 7 }, (_, i) => createDraftGenerationJob("Keep walking", { id: String(i + 1), sceneType: "long-shot" }));
  const submitted = vi.fn();
  render(<GeneratorView config={initial} folderPath="C:/project" runtime={readyRuntime}
    onChange={vi.fn()} onGenerate={submitted} onOpenTimeline={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
  expect(submitted.mock.calls[0][0].map((item: { job: { id: string } }) => item.job.id)).toEqual(["1", "3", "2", "5", "4", "7", "6"]);
  expect(submitted.mock.calls[0][0][2].request.latentBridge).toMatchObject({ leftSceneId: "1", rightSceneId: "3", leftMarginFrames: 17, rightMarginFrames: 17 });
});

it("persists Long Shot boundary controls and inherits the scene type for new scenes", () => {
  const initial = project();
  initial.generationJobs.forEach((job) => { job.sceneType = "long-shot"; });
  const state = setup(initial);
  fireEvent.click(screen.getByRole("button", { name: "Select scene Second scene" }));
  choose("Edit previous ending", "34 frames (1.42 s)");
  choose("Edit following beginning", "0 frames (0.00 s)");
  expect(state.latest().generationJobs[1]).toMatchObject({ sceneType: "long-shot", bridgeLeftMargin: 34, bridgeRightMargin: 0 });
  expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  expect(state.latest().generationJobs.at(-1)?.sceneType).toBe("long-shot");
});

it("hides unfinished templates from the generator picker", () => {
  setup();
  fireEvent.click(screen.getByRole("combobox", { name: /Video generator template/ }));
  expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "First/Last Frame" })).toBeNull();
});

it("generates the selected backdrop with the scene action and restores it on reopen", () => {
  const state = setup();
  fireEvent.click(screen.getByRole("button", { name: "Select scene First scene" }));
  choose("Scene type", "Backdrop");
  choose("Scene backdrop color", "White");
  expect(state.latest().generationJobs[0]).toMatchObject({ sceneType: "backdrop", backdropColor: "white" });
  expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
  fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
  const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
  const snapshot = JSON.parse(saved.generationJobs[0].generationSnapshot!);
  expect(snapshot.prompt).toContain("solid white (#ffffff)");
  expect(saved.generationJobs[0].backdropColor).toBe("white");
});

it("unbinds a reference after its last prompt chip is removed and excludes it from generation and Used by", () => {
  const initial = project();
  initial.references = ["hero", "opening"].map((id) => ({ id, kind: "image", name: id, description: "", intendedUse: [],
    relativePath: `references/${id}.png`, createdAt: initial.createdAt }));
  initial.generationJobs[0].referenceIds = ["hero"];
  initial.generationJobs[0].startFrameReferenceId = "opening";
  initial.generationJobs[0].shots!.forEach((shot) => { shot.action = "@[ref:hero] walks."; });
  const state = setup(initial);
  fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
  changePromptChip(screen.getByLabelText("Describe shot 1"), 0, null);
  expect(state.latest().generationJobs[0].referenceIds).toEqual(["hero"]);
  fireEvent.click(screen.getByRole("button", { name: "Shot 2 of First scene" }));
  typePrompt(screen.getByLabelText("Describe shot 2"), "A walk through the forest.");
  expect(state.latest().generationJobs[0].referenceIds).toEqual([]);
  fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
  const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
  const snapshot = JSON.parse(saved.generationJobs[0].generationSnapshot!);
  expect(snapshot.referencePaths).toHaveLength(1);
  expect(snapshot.referencePaths[0]).toContain("opening.png");
  expect(snapshot.prompt).not.toContain("<Subject");
  cleanup();
  const { container } = render(<ReferencesView config={saved} folderPath="C:/project" onChange={vi.fn()} />);
  expect(container.querySelector(".reference-used-by")).toHaveTextContent("No scenes yet.");
  fireEvent.click(screen.getByRole("option", { name: /opening/ }));
  expect(within(container.querySelector(".reference-used-by")! as HTMLElement).getByRole("button", { name: "First scene" })).toBeInTheDocument();
});

it("replaces a chip's binding and removes bindings when its shot is deleted", async () => {
  const initial = project();
  initial.references = ["Hero", "Forest"].map((name) => ({ id: name.toLowerCase(), kind: "image", name, description: "", intendedUse: [],
    relativePath: `references/${name}.png`, createdAt: initial.createdAt }));
  initial.generationJobs[0].referenceIds = ["hero"];
  initial.generationJobs[0].shots![1].action = "@[ref:hero] walks.";
  const state = setup(initial);
  fireEvent.click(screen.getByRole("button", { name: "Shot 2 of First scene" }));
  changePromptChip(screen.getByLabelText("Describe shot 2"), 0, "Forest");
  expect(state.latest().generationJobs[0].referenceIds).toEqual(["forest"]);
  fireEvent.click(screen.getByRole("button", { name: "Delete shot 2" }));
  await waitFor(() => expect(state.latest().generationJobs[0].referenceIds).toEqual([]));
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
  initial.generationJobs = [createDraftGenerationJob("", { id: "blank", title: "Blank scene", sceneType: "animate" })];
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
  fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
  expect(submitted.mock.calls.flatMap(([items]) => items)).toHaveLength(0);
  expect(screen.queryByLabelText("The sound of this scene")).toBeNull();
  choose("Reference video for this scene", "Motion");
  expect(generate).toBeDisabled();
  chooseReference("Start frame for this scene", "Repainted frame");
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(submitted).toHaveBeenLastCalledWith([expect.objectContaining({ request: expect.objectContaining({
    prompt: "", referenceVideos: [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 1, durationSeconds: 3, includeAudio: false }],
    referencePaths: ["C:/project/references/repainted.png"],
  }) })]);
  chooseReference("Start frame for this scene", "None");
  expect(generate).toBeDisabled();
  chooseReference("Start frame for this scene", "Repainted frame");
  expect(generate).toBeEnabled();
  choose("Reference video for this scene", "None");
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

it("saves scene types and submits Character Replace with the exact selected references", () => {
  const initial = project();
  initial.generationJobs = [createDraftGenerationJob("", { id: "replace", title: "Replace scene" })];
  initial.references = [
    { id: "motion", kind: "video", name: "Motion", description: "", intendedUse: [], sourcePath: "C:/motion.mp4",
      video: { startSeconds: 1, durationSeconds: 3, includeAudio: false }, createdAt: "2026-09-21T00:00:00.000Z" },
    { id: "hero", kind: "image", name: "New hero", description: "", intendedUse: [], relativePath: "references/hero.png", createdAt: "2026-09-21T00:00:00.000Z" },
  ];
  let latest = initial;
  const submitted = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return <GeneratorView config={config} folderPath="C:/project" runtime={readyRuntime}
      onChange={setConfig} onGenerate={submitted} onOpenTimeline={() => undefined} />;
  }
  render(<Harness />);
  expect(comboValue(screen.getByRole("combobox", { name: "Scene type" }))).toBe("first-last-frame");
  choose("Scene type", "Character replace");
  expect(latest.generationJobs[0].sceneType).toBe("character-replace");
  expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
  const generate = within(screen.getByRole("region", { name: "Replace scene" })).getByRole("button", { name: "Generate" });
  expect(generate).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Shot 1 of Replace scene" }));
  expect(screen.queryByLabelText("Describe shot 1")).toBeNull();
  choose("Video reference for this shot", "Motion");
  expect(generate).toBeDisabled();
  choose("New character reference for this shot", "New hero");
  fireEvent.change(screen.getByLabelText("Character to replace in this shot"), { target: { value: "the person on the left" } });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(submitted).toHaveBeenCalledWith([expect.objectContaining({ request: expect.objectContaining({
    prompt: expect.stringContaining("replace the person on the left with <Subject 1>"),
    referencePaths: ["C:/project/references/hero.png"],
    referenceVideos: [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 1, durationSeconds: 3, includeAudio: false }],
  }) })]);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).generationJobs[0].shots![0]).toMatchObject({ videoReferenceId: "motion", characterReferenceId: "hero" });
  fireEvent.click(screen.getByRole("button", { name: "Select scene Replace scene" }));
  choose("Scene type", "First & last frame");
  expect(screen.getByLabelText("Start frame for this scene")).toBeInTheDocument();
  choose("Scene type", "Character replace");
  expect(generate).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Shot 1 of Replace scene" }));
  expect(comboValue(screen.getByRole("combobox", { name: "New character reference for this shot" }))).toBe("hero");
  choose("New character reference for this shot", "None");
  expect(generate).toBeDisabled();
});

it("submits Pose from the scene panel with its video and optional prompt references", () => {
  const initial = project();
  initial.generationJobs = [createDraftGenerationJob("", { id: "pose", title: "Pose scene" })];
  initial.references = [
    { id: "motion", kind: "video", name: "Motion", description: "", intendedUse: [], sourcePath: "C:/motion.mp4",
      video: { startSeconds: 1, durationSeconds: 3, includeAudio: true }, createdAt: "2026-09-22T00:00:00.000Z" },
    { id: "hero", kind: "image", name: "Hero", description: "", intendedUse: [], relativePath: "references/hero.png", createdAt: "2026-09-22T00:00:00.000Z" },
  ];
  let latest = initial;
  const submitted = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return <GeneratorView config={config} folderPath="C:/project" runtime={readyRuntime}
      onChange={setConfig} onGenerate={submitted} onOpenTimeline={() => undefined} />;
  }
  render(<Harness />);
  choose("Scene type", "Pose");
  expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
  const generate = within(screen.getByRole("region", { name: "Pose scene" })).getByRole("button", { name: "Generate" });
  expect(generate).toBeDisabled();
  choose("Pose video reference for this scene", "Motion");
  expect(generate).toBeDisabled();
  typePrompt(screen.getByLabelText("Describe shot 1"), "A dancer on a rainy street.");
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(submitted.mock.calls[0][0][0].request).toMatchObject({
    prompt: expect.stringContaining("Apply the body pose, movement and timing from <Video 1>"),
    referencePaths: [],
    referenceVideos: [{ name: "Motion", sourcePath: "C:/motion.mp4", startSeconds: 1, durationSeconds: 3, includeAudio: false }],
  });
  placePromptCaret(screen.getByLabelText("Describe shot 1"));
  insertPromptReference("Hero");
  expect(latest.generationJobs[0].shots![0].action).toContain("@[ref:hero]");
  fireEvent.click(generate);
  expect(submitted.mock.calls.at(-1)![0][0].request.referencePaths).toEqual(["C:/project/references/hero.png"]);
  expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).generationJobs[0]).toMatchObject({ sceneType: "pose", poseVideoReferenceId: "motion" });
  choose("Scene type", "First & last frame");
  choose("Scene type", "Pose");
  expect(comboValue(screen.getByRole("combobox", { name: "Pose video reference for this scene" }))).toBe("motion");
  choose("Pose video reference for this scene", "None");
  expect(generate).toBeDisabled();
  expect(templateSceneBlocker("pose", minimaxOriginalTemplate())).toContain("References or Singularity");
  expect(templateSceneBlocker("pose", viggleAnimateTemplate())).toContain("MiniMax prompt");
});

it("keeps an explicitly selected scene type independent of the global generator", () => {
  const initial = project();
  initial.generationJobs[0].sceneType = "animate";
  const state = setup(initial);
  expect(comboValue(screen.getByRole("combobox", { name: "Scene type" }))).toBe("animate");
  expect(screen.getByLabelText("Reference video for this scene")).toBeInTheDocument();
  const first = within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" });
  expect(first).toHaveAttribute("data-tooltip", "Select an Animate generator for this scene.");
  fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
  expect(state.latest().generationJobs[0].status).toBe("draft");
  expect(state.latest().generationJobs[1].status).toBe("queued");
});

it("refuses known first/last-frame weights for Character Replace", () => {
  expect(templateSceneBlocker("character-replace", minimaxOriginalTemplate())).toContain("References or Singularity");
  expect(templateSceneBlocker("character-replace", viggleAnimateTemplate())).toContain("MiniMax prompt");
});

it.each(["extend", "bridge"] as const)("submits %s with ordered video anchors and the shot prompt", (type) => {
  const initial = project();
  initial.generationJobs = [createDraftGenerationJob("The dancer turns toward the door.", { id: "transition", title: "Transition" })];
  initial.references = ["end", "start"].map((id) => ({ id, kind: "video" as const, name: id, description: "", intendedUse: [],
    sourcePath: `C:/${id}.mp4`, video: { startSeconds: 1, durationSeconds: 3, includeAudio: true }, createdAt: "2026-09-21T00:00:00.000Z" }));
  let latest = initial;
  const submitted = vi.fn();
  function Harness() {
    const [config, setConfig] = useState(initial);
    latest = config;
    return <GeneratorView config={config} folderPath="C:/project" runtime={readyRuntime}
      onChange={setConfig} onGenerate={submitted} onOpenTimeline={() => undefined} />;
  }
  render(<Harness />);
  choose("Scene type", type === "extend" ? "Extend" : "Bridge");
  expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
  const generate = within(screen.getByRole("region", { name: "Transition" })).getByRole("button", { name: "Generate" });
  expect(generate).toBeDisabled();
  choose("Start video reference for this scene", "start");
  if (type === "bridge") {
    expect(generate).toBeDisabled();
    choose("End video reference for this scene", "end");
  } else expect(screen.queryByLabelText("End video reference for this scene")).toBeNull();
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  const request = submitted.mock.calls[0][0][0].request;
  expect(request.videoTransition).toBe(type);
  expect(request.referenceVideos.map((video: { sourcePath: string }) => video.sourcePath)).toEqual(type === "extend" ? ["C:/start.mp4"] : ["C:/start.mp4", "C:/end.mp4"]);
  expect(request.referenceVideos.every((video: { includeAudio: boolean }) => !video.includeAudio)).toBe(true);
  expect(request.referencePaths).toEqual([]);
  expect(request).not.toHaveProperty("previousSceneId");
  expect(request.prompt).toContain("The dancer turns toward the door.");
  expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).generationJobs[0].startVideoReferenceId).toBe("start");
  fireEvent.click(screen.getByRole("button", { name: "Shot 1 of Transition" }));
  typePrompt(screen.getByLabelText("Describe shot 1"), "");
  expect(generate).toBeDisabled();
});

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
  fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
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
    expect(comboValue(selector)).toBe("");
    expect(screen.getByText("Using project Look: Watercolor.")).toBeInTheDocument();
    if (sceneLook) chooseOption(selector, expected);
    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!).prompt).toContain(expected);
    if (!sceneLook) expect(sceneShots(state.latest().generationJobs[0])[0].settings?.visualStyle).toBeUndefined();
  });

  it("only shows debug prompts when enabled, in a dialog outside the inspector", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Debug prompt" })).not.toBeInTheDocument();
    act(() => saveDebugOptionsEnabled(true));
    const button = screen.getByRole("button", { name: "Debug prompt" });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Debug prompt" });
    expect(dialog.closest("aside")).toBeNull();
    const prompt = within(dialog).getByLabelText("The compiled MiniMax H3 prompt");
    expect(prompt).toHaveTextContent("Opening action");
    expect(prompt).toHaveFocus();
    fireEvent.keyDown(prompt, { key: "a", ctrlKey: true });
    expect(window.getSelection()?.toString()).toBe(prompt.textContent);
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
    fireEvent.click(button);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Debug prompt" })).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
    fireEvent.click(button);
    act(() => saveDebugOptionsEnabled(false));
    expect(screen.queryByRole("button", { name: "Debug prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
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

    expect(optionNames(screen.getByRole("combobox", { name: "The look of this scene" }))).toContain("None");
    chooseReference("Start frame for this scene", "Opening still");
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
    chooseReference("Last frame for this scene", "Closing still");
    expect(state.latest().generationJobs[0].endFrameReferenceId).toBe("closing");
    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    const snapshot = JSON.parse(state.latest().generationJobs[0].generationSnapshot!);
    expect(snapshot.prompt).toContain("<Picture 1> is the last frame of the video.");
    expect(snapshot.referencePaths[0]).toContain("closing.png");
    chooseReference("Last frame for this scene", "None");
    expect(state.latest().generationJobs[0].endFrameReferenceId).toBeUndefined();
  });

  it.each([false, true])("continues a later scene with selectable overlap and edge, with Lock Overlap %s", (lockOverlap) => {
    const initial = project();
    initial.generationJobs[1] = { ...initial.generationJobs[1], status: "completed", latentRelativePath: "latents/later.safetensors" };
    initial.references = [{ id: "still", kind: "image", name: "Still", description: "", intendedUse: [], sourcePath: "C:/still.png", createdAt: initial.createdAt }];
    initial.generationJobs[0].startFrameReferenceId = "still";
    initial.generationJobs[0].endFrameReferenceId = "still";
    const state = setup(initial);
    choose("Scene type", "Continue");
    const generate = within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" });
    expect(generate).toBeDisabled();
    expect(screen.queryByLabelText("Start frame for this scene")).toBeNull();
    expect(screen.queryByLabelText("Last frame for this scene")).toBeNull();
    expect(comboValue(screen.getByLabelText("Take continuation latents from"))).toBe("end");
    expect(comboValue(screen.getByLabelText("Continuation overlap frames"))).toBe("22");
    expect(optionNames(screen.getByLabelText("Source scene for continuation"))).not.toContain("First scene");
    choose("Source scene for continuation", "Second scene");
    choose("Take continuation latents from", "Start");
    choose("Continuation overlap frames", "39");
    expect(screen.getByRole("switch", { name: "Lock Overlap" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Lock Overlap" }));
    if (!lockOverlap) fireEvent.click(screen.getByRole("switch", { name: "Lock Overlap" }));
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    const saved = parseProjectConfig(JSON.parse(JSON.stringify(state.latest())));
    expect(saved.generationJobs[0]).toMatchObject({ sceneType: "continue", continuationSceneId: "scene-second", continuationFrom: "start", continuationOverlapFrames: 39, continuationLockOverlap: lockOverlap });
    expect(JSON.parse(saved.generationJobs[0].generationSnapshot!).continuationLockOverlap ?? false).toBe(lockOverlap);
    expect(JSON.parse(saved.generationJobs[0].generationSnapshot!)).toMatchObject({
      previousSceneId: "scene-second", continuationRelativePath: "latents/later.safetensors", continuationFrom: "start", continuationOverlapFrames: 39, referencePaths: [],
    });
  });

  it("queues continuation dependencies before their dependents, regardless of board order", () => {
    const initial = project();
    initial.generationJobs = [
      { ...initial.generationJobs[0], sceneType: "continue", continuationSceneId: "middle" },
      { ...initial.generationJobs[1], id: "middle", sceneType: "continue", continuationSceneId: "source" },
      createDraftGenerationJob("Original", { id: "source" }),
      createDraftGenerationJob("Cycle A", { id: "cycle-a", sceneType: "continue" }),
      createDraftGenerationJob("Cycle B", { id: "cycle-b", sceneType: "continue" }),
    ];
    initial.generationJobs[3].continuationSceneId = "cycle-b";
    initial.generationJobs[4].continuationSceneId = "cycle-a";
    const submitted = vi.fn();
    render(<GeneratorView config={initial} folderPath="C:/project" runtime={readyRuntime}
      onChange={vi.fn()} onGenerate={submitted} onOpenTimeline={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.calls[0][0].map((item: { job: { id: string } }) => item.job.id)).toEqual(["source", "middle", "scene-first"]);
    expect(submitted.mock.calls[0][0][2].request).toMatchObject({ previousSceneId: "middle", continuationFrom: "end", continuationOverlapFrames: 22 });
  });

  it("marks a linked scene yellow when its source regenerates and clears it after regeneration", () => {
    const initial = project();
    initial.generationJobs[0] = { ...initial.generationJobs[0], status: "completed", outputRelativePath: "media/generated/work-original.mp4", latentRelativePath: "latents/work-original.safetensors" };
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Start frame for this scene" }));
    expect(screen.queryByRole("option", { name: "Previous scene" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start frame for this scene" }));
    fireEvent.click(screen.getByRole("button", { name: "Select scene Second scene" }));
    choose("Scene type", "Continue");
    choose("Source scene for continuation", "First scene");
    expect(state.latest().generationJobs[1].continuationSceneId).toBe("scene-first");
    const generateSecond = () => fireEvent.click(within(screen.getByRole("region", { name: "Second scene" })).getByRole("button", { name: "Generate" }));
    const finishSecond = () => state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 1 ? { ...job, status: "completed", outputRelativePath: "media/generated/work-second.mp4" } : job) });
    generateSecond();
    const snapshot = JSON.parse(state.latest().generationJobs[1].generationSnapshot!);
    expect(snapshot.previousSceneId).toBe("scene-first");
    expect(snapshot.continuationRelativePath).toBe("latents/work-original.safetensors");
    finishSecond();
    const second = () => screen.getByRole("region", { name: "Second scene" });
    expect(within(second()).getByText("Finished")).toBeInTheDocument();
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 0 ? { ...job, status: "generating" } : job) });
    expect(within(second()).getByText("Changed")).toBeInTheDocument();
    expect(second().querySelector(".scene-rule__status--changed")).not.toBeNull();
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 0 ? { ...job, status: "completed", outputRelativePath: "media/generated/work-new.mp4", latentRelativePath: "latents/work-new.safetensors" } : job) });
    expect(within(second()).getByText("Changed")).toBeInTheDocument();
    // Opening a saved project retains the dependency's recorded renderer inputs.
    state.replace(parseProjectConfig(JSON.parse(JSON.stringify(state.latest()))));
    expect(within(second()).getByText("Changed")).toBeInTheDocument();
    generateSecond();
    expect(JSON.parse(state.latest().generationJobs[1].generationSnapshot!).continuationRelativePath).toBe("latents/work-new.safetensors");
    finishSecond();
    expect(within(second()).getByText("Finished")).toBeInTheDocument();
  });

  it("includes fixed-seed linked scenes when Generate All regenerates their source", () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 42, outputRelativePath: `media/generated/work-${index}.mp4`, latentRelativePath: `latents/work-${index}.safetensors`, usePreviousSceneLastFrame: index === 1 }));
    initial.assets.push({ id: "asset-scene-first", kind: "generated", mimeType: "video/mp4", name: "First scene", relativePath: "media/generated/work-0.mp4", durationMs: 6000, createdAt: initial.createdAt });
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job) => ({ ...job, status: "completed" })) });
    expect(screen.getByRole("button", { name: "Generate all" })).toHaveAttribute("data-tooltip", "Every fixed-seed scene is already up to date.");
    // Suffix-only renders from older versions must regenerate even with an
    // unchanged seed and prompt, so the source side of the join is recovered.
    const legacy = JSON.parse(state.latest().generationJobs[1].generationSnapshot!);
    delete legacy.continuationOutput;
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job, index) => index === 1 ? { ...job, generationSnapshot: JSON.stringify(legacy) } : job) });
    expect(within(screen.getByRole("region", { name: "Second scene" })).getByText("Changed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["completed", "queued"]);
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job) => ({ ...job, status: "completed" })) });
    fireEvent.change(screen.getByRole("textbox", { name: "The sound of this scene" }), { target: { value: "Rain" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
  });

  it("regenerates a completed source without latents when Generate All continues it", () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 42,
      outputRelativePath: `media/generated/work-${index}.mp4`, usePreviousSceneLastFrame: index === 1 }));
    const state = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    // Simulate an older completed project: matching snapshots, but no archives.
    state.replace({ ...state.latest(), generationJobs: state.latest().generationJobs.map((job) => ({ ...job, status: "completed" })) });
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("saves generation controls with separate audio steps %s and latent upscale %s", async (separateAudio, latentUpscale) => {
    const initial = project();
    initial.settings = { ...initial.settings, resolution: "416p", frameRate: 60 };
    const state = setup(initial);
    const generation = screen.getByRole("region", { name: "Generation" });
    const upscale = within(generation).getByRole("switch", { name: "Latent upscale" });
    expect(upscale).not.toBeChecked();
    fireEvent.click(upscale);
    if (!latentUpscale) fireEvent.click(upscale);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(state.latest()))).generationJobs[0].latentUpscale).toBe(latentUpscale);
    expect(within(generation).getByRole("spinbutton", { name: "Generation step count" })).toHaveValue(20);
    expect(within(generation).getByRole("spinbutton", { name: "Generation seed" })).toHaveValue(-1);

    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation step count" }), { target: { value: "28" } });
    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Generation seed" }), { target: { value: "9173" } });
    expect(within(generation).getByRole("switch", { name: "Separate audio steps" })).not.toBeChecked();
    expect(within(generation).queryByRole("spinbutton", { name: "Audio step count" })).toBeNull();
    fireEvent.click(within(generation).getByRole("switch", { name: "Separate audio steps" }));
    expect(within(generation).getByRole("spinbutton", { name: "Audio step count" })).toHaveValue(28);
    fireEvent.change(within(generation).getByRole("spinbutton", { name: "Audio step count" }), { target: { value: "17" } });
    if (!separateAudio) fireEvent.click(within(generation).getByRole("switch", { name: "Separate audio steps" }));
    expect(parseProjectConfig(JSON.parse(JSON.stringify(state.latest()))).generationJobs[0].audioSteps).toBe(separateAudio ? 17 : undefined);
    expect(state.latest().generationJobs[0]).toEqual(expect.objectContaining({ steps: 28, seed: 9173 }));

    fireEvent.click(within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].generationSnapshot).toEqual(expect.any(String)));
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!).audioSteps).toBe(separateAudio ? 17 : undefined);
    expect(JSON.parse(state.latest().generationJobs[0].generationSnapshot!).latentUpscale).toBe(latentUpscale ? true : undefined);
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
    expect(speech).toHaveTextContent("");
    expect(comboValue(language)).toBe("English");

    chooseOption(language, "Korean");
    typePrompt(speech, "문을 열어 주세요.");
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
    expect(comboValue(language)).toBe("Klingon");
    expect(optionNames(language)).toContain("Klingon");
  });

  it("inserts a voice chip into Speech and removes its generation input when the chip is removed", () => {
    const initial = project();
    initial.references = [
      { id: "voice", kind: "audio", name: "Narrator voice", description: "", intendedUse: [], sourcePath: "C:/voice.wav",
        audio: { startSeconds: 2, durationSeconds: 4 }, createdAt: initial.createdAt },
      { id: "hero", kind: "image", name: "Hero", description: "", intendedUse: [], sourcePath: "C:/hero.png", createdAt: initial.createdAt },
    ];
    initial.generationJobs[0].startFrameReferenceId = "hero";
    let latest = initial;
    const submitted = vi.fn();
    function Harness() {
      const [config, setConfig] = useState(initial);
      latest = config;
      return <GeneratorView config={config} folderPath="C:/project" runtime={readyRuntime}
        onChange={setConfig} onGenerate={submitted} onOpenTimeline={() => undefined} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    const speech = screen.getByRole("textbox", { name: "Speech for shot 1" });
    typePrompt(speech, "Welcome home.");
    placePromptCaret(speech);
    fireEvent.click(screen.getByRole("button", { name: "Voice reference" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: /^Hero/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Narrator voice/ }));
    expect(speech.querySelector(".prompt-chip")).toHaveTextContent("Narrator voice");
    expect(latest.generationJobs[0].referenceIds).toEqual(["voice"]);
    expect(parseProjectConfig(JSON.parse(JSON.stringify(latest))).generationJobs[0].shots![0].speech).toContain("@[ref:voice]");
    const generate = within(screen.getByRole("region", { name: "First scene" })).getByRole("button", { name: "Generate" });
    fireEvent.click(generate);
    expect(submitted.mock.calls.at(-1)![0][0].request).toMatchObject({
      prompt: expect.stringContaining("<d>[English] Welcome home.</d>"),
      referenceAudios: [{ name: "Narrator voice", sourcePath: "C:/voice.wav", startSeconds: 2, durationSeconds: 4 }],
    });
    changePromptChip(speech, 0, null);
    expect(latest.generationJobs[0].referenceIds).toEqual([]);
    fireEvent.click(generate);
    expect(submitted.mock.calls.at(-1)![0][0].request.referenceAudios).toEqual([]);
    expect(submitted.mock.calls.at(-1)![0][0].request.prompt).not.toContain("<Audio");
  });

  it("reorders shots inside a scene while keeping its cut slots", () => {
    const state = setup();
    const shotTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Shot 1 of First scene" }), { dataTransfer: shotTransfer });
    fireEvent.drop(screen.getByRole("list", { name: "Shots in First scene" }), { dataTransfer: shotTransfer });

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

  it("selects a scene from its header and keeps confirmed removal in the inspector", async () => {
    const state = setup();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Draft/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("slider", { name: "First scene length in seconds" }), { target: { value: "10" } });
    expect(state.latest().generationJobs[0].durationSeconds).toBe(10);
    expect(screen.queryByText("Changed")).not.toBeInTheDocument();

    const scene = screen.getByRole("region", { name: "First scene" });
    expect(within(scene).queryByRole("button", { name: "Delete scene First scene" })).not.toBeInTheDocument();
    expect(within(scene).queryByRole("button", { name: "Settings for First scene" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    fireEvent.click(scene.querySelector(".scene-rule")!);
    expect(screen.getByRole("textbox", { name: "Rename First scene" })).toBeInTheDocument();

    vi.mocked(askNative).mockResolvedValueOnce(false);
    fireEvent.click(within(screen.getByRole("complementary", { name: "Scene: First scene" })).getByRole("button", { name: "Delete scene First scene" }));
    await waitFor(() => expect(askNative).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete scene", okLabel: "Delete" })));
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-first", "scene-second"]);
    vi.mocked(askNative).mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete scene First scene" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second"]));
  });

  it("adds new scenes at the bottom", () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
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
          motionCache: true,
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
    expect(screen.getByRole("img", { name: "Video generator ready" })).toBeInTheDocument();
    const template = screen.getByRole("combobox", { name: /Video generator template/ });
    expect(template).toHaveTextContent("Quality");
    fireEvent.click(template);
    fireEvent.click(screen.getByRole("option", { name: "Fast draft" }));

    await waitFor(() => expect(document.querySelector(".generator-runtime--modelsMissing > i")).not.toBeNull());
    expect(getEngineStatus).toHaveBeenCalledWith(expect.objectContaining({ transformer: "draft.safetensors" }), "sage2", [], "prompt", [], true, expect.anything());
    expect(JSON.parse(localStorage.getItem("slopus.generator-templates.v1")!).defaultTemplateId).toBe("draft");
    expect(within(screen.getByRole("region", { name: "Generator status" })).getByText("Video model files missing")).toBeInTheDocument();
    expect(template.closest(".generator-runtime--modelsMissing")).not.toBeNull();
  });

  it("marks a finished scene yellow when scene settings change", async () => {
    const state = setup();
    await finishFirst(state);
    const scene = screen.getByRole("region", { name: "First scene" });
    expect(within(scene).getByText("Finished")).toBeInTheDocument();
    expect(scene.querySelector(".scene-rule__status--completed")).not.toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: "The sound of this scene" }), { target: { value: "Soft rain." } });
    expect(within(scene).getByText("Changed")).toBeInTheDocument();
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
    chooseOption(addSetting, "Shot size");
    choose("Value for Shot size on shot 1", "Close-up");
    expect(state.latest().generationJobs[0].generationSnapshot).toBe(sent);

    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job, index) => index === 0
        ? { ...job, status: "completed", stage: "completed", progress: 1 }
        : job),
    });
    const finished = screen.getByRole("region", { name: "First scene" });
    expect(within(finished).getByText("Changed")).toBeInTheDocument();
    expect(finished.querySelector(".scene-rule__status--changed")).not.toBeNull();
  });

  it("marks a finished scene changed when shot settings or order change", async () => {
    const state = setup();
    await finishFirst(state);
    const scene = screen.getByRole("region", { name: "First scene" });

    fireEvent.click(screen.getByRole("button", { name: "Shot 1 of First scene" }));
    expect(screen.getByText("Description")).toBeInTheDocument();
    choose("Add a setting to shot 1", "Shot size");
    choose("Value for Shot size on shot 1", "Close-up");
    expect(within(scene).getByText("Changed")).toBeInTheDocument();

    fireEvent.click(within(scene).getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(state.latest().generationJobs[0].status).toBe("queued"));
    const regenerated = state.latest().generationJobs[0];
    state.replace({
      ...state.latest(),
      generationJobs: state.latest().generationJobs.map((job, index) => index === 0
        ? { ...regenerated, status: "completed", stage: "completed", progress: 1 }
        : job),
    });
    expect(within(scene).getByText("Finished")).toBeInTheDocument();

    const shotTransfer = transfer();
    fireEvent.dragStart(screen.getByRole("button", { name: "Shot 1 of First scene" }), { dataTransfer: shotTransfer });
    fireEvent.drop(screen.getByRole("list", { name: "Shots in First scene" }), { dataTransfer: shotTransfer });
    expect(within(scene).getByText("Changed")).toBeInTheDocument();
  });

  it("renames a shot and confirms before removing it", async () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Shot 2 of First scene" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rename shot 2" }), { target: { value: "Doorway reveal" } });
    const shotHeader = screen.getByRole("textbox", { name: "Rename shot 2" }).closest<HTMLElement>(".ui-item-header");
    const removeButton = within(shotHeader!).getByRole("button", { name: "Delete shot 2" });
    expect(removeButton).toHaveClass("icon-button");
    expect(removeButton).toHaveTextContent("");
    expect(sceneShots(state.latest().generationJobs[0])[1].name).toBe("Doorway reveal");
    expect(parseProjectConfig(state.latest()).generationJobs[0].shots?.[1].name).toBe("Doorway reveal");
    expect(screen.getByRole("button", { name: "Doorway reveal of First scene" })).toBeInTheDocument();

    vi.mocked(askNative).mockResolvedValueOnce(false);
    fireEvent.click(removeButton);
    await waitFor(() => expect(askNative).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete shot", message: "Delete “Doorway reveal” from “First scene”?" })));
    expect(sceneShots(state.latest().generationJobs[0])).toHaveLength(2);

    vi.mocked(askNative).mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete shot 2" }));
    await waitFor(() => expect(sceneShots(state.latest().generationJobs[0])).toHaveLength(1));
  });

  it("queues every valid draft from Generate All", async () => {
    const state = setup();
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "queued"]));
    expect(state.latest().generationJobs.every((job) => Boolean(job.generationSnapshot))).toBe(true);
    expect(parseProjectConfig(state.latest())).toBeTruthy();
  });

  it("keeps Generate All available and skips unchanged completed fixed-seed scenes", async () => {
    const initial = project();
    initial.generationJobs = initial.generationJobs.map((job, index) => ({ ...job, seed: 100 + index }));
    const state = setup(initial);

    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
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

    const generateAll = screen.getByRole("button", { name: "Generate all" });
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
    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
    await waitFor(() => expect(state.latest().generationJobs.map((job) => job.status)).toEqual(["queued", "completed"]));
  });

  it("regenerates an unchanged completed random-seed scene while skipping fixed-seed output", async () => {
    const initial = project();
    initial.generationJobs[1].seed = 417;
    const state = setup(initial);

    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Generate all" }));
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
    expect(screen.getByRole("button", { name: "Cancel all" })).toBeEnabled();
    expect(within(first).getAllByText("Rendering 42%")).toHaveLength(2);
    const progressBars = first.querySelectorAll(".shot-thumb__progress > i");
    expect(progressBars).toHaveLength(2);
    expect([...progressBars].every((bar) => (bar as HTMLElement).style.width === "42%")).toBe(true);
    expect(within(first).queryByText("Rendering")).not.toBeInTheDocument();

    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelSlopfabGeneration).toHaveBeenCalledWith("scene-first"));
    const cancelling = within(first).getAllByRole("img", { name: /Cancelling\.\.\.$/ });
    expect(cancelling).toHaveLength(2);
    expect(cancelling.every((thumbnail) => thumbnail.querySelector(".spin"))).toBe(true);
    expect(within(first).queryByText("Rendering 42%")).not.toBeInTheDocument();

    vi.mocked(cancelSlopfabGeneration).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel all" }));
    await waitFor(() => {
      expect(cancelSlopfabGeneration).toHaveBeenCalledTimes(1);
      expect(cancelSlopfabGeneration).toHaveBeenCalledWith("scene-second");
    });
  });
});

describe("Generator board as a native list", () => {
  it("summarises the board in the status bar and switches density", () => {
    const initial = project();
    initial.generationJobs[0] = { ...initial.generationJobs[0], status: "generating", stage: "generating", progress: 0.1 };
    setup(initial);
    expect(within(screen.getByRole("region", { name: "Generator status" })).getByRole("status")).toHaveTextContent("2 scenes · 1 rendering");
    expect(screen.queryByRole("heading", { name: "Generator" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".scene-board--list")).not.toBeNull();
    expect(localStorage.getItem("slopus.generator.density")).toBe("list");
  });

  it("collapses a scene group from its header", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Collapse First scene" }));
    expect(screen.queryByRole("list", { name: "Shots in First scene" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand First scene" }));
    expect(screen.getByRole("list", { name: "Shots in First scene" })).toBeInTheDocument();
  });

  it("opens scene and shot menus by right-click and Shift+F10 and runs their commands", () => {
    const state = setup();
    fireEvent.contextMenu(screen.getByRole("region", { name: "Second scene" }).querySelector(".scene-rule")!);
    const menu = screen.getByRole("menu", { name: "Second scene actions" });
    expect(within(menu).getByRole("menuitem", { name: /Move down/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Move up/ }));
    expect(state.latest().generationJobs.map((job) => job.id)).toEqual(["scene-second", "scene-first"]);

    const shot = screen.getByRole("button", { name: "Shot 2 of First scene" });
    fireEvent.keyDown(shot, { key: "F10", shiftKey: true });
    const shotMenu = screen.getByRole("menu", { name: "Shot 2 actions" });
    // One "Move to" item with the other scenes in a cascade, not one item per scene.
    const moveTo = within(shotMenu).getByRole("menuitem", { name: "Move to" });
    expect(moveTo).toHaveAttribute("aria-haspopup", "menu");
    moveTo.focus();
    fireEvent.keyDown(moveTo, { key: "ArrowRight" });
    fireEvent.click(within(screen.getByRole("menu", { name: "Move to" })).getByRole("menuitem", { name: "Second scene" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(sceneShots(state.latest().generationJobs.find((job) => job.id === "scene-second")!).map((item) => item.id)).toEqual(["shot-second-a", "shot-first-b"]);
  });

  it("renames with F2 and deletes with Delete after a native confirmation", async () => {
    const state = setup();
    const shot = screen.getByRole("button", { name: "Shot 2 of First scene" });
    fireEvent.click(shot);
    shot.focus();
    fireEvent.keyDown(shot, { key: "F2" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Rename shot 2" })).toHaveFocus());

    shot.focus();
    fireEvent.keyDown(shot, { key: "Delete" });
    await waitFor(() => expect(sceneShots(state.latest().generationJobs[0])).toHaveLength(1));
    expect(askNative).toHaveBeenCalledWith(expect.objectContaining({ title: "Delete shot" }));
  });

  it("moves between shot tiles with the arrow keys as one tab stop", () => {
    setup();
    const first = screen.getByRole("button", { name: "Shot 1 of First scene" });
    const second = screen.getByRole("button", { name: "Shot 2 of First scene" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("aria-pressed", "true");
  });

  it("shows where a dragged shot will land and dims the source", () => {
    setup();
    const shotTransfer = transfer();
    const source = screen.getByRole("button", { name: "Shot 1 of First scene" });
    fireEvent.dragStart(source, { dataTransfer: shotTransfer });
    expect(source.closest(".shot-card")).toHaveClass("shot-card--dragging");
    const target = screen.getByRole("button", { name: "Shot 1 of Second scene" }).closest("li")!;
    fireEvent.dragOver(target, { dataTransfer: shotTransfer });
    expect(target).toHaveClass("shot-slot--drop-before");
    fireEvent.dragEnd(source, { dataTransfer: shotTransfer });
    expect(target).not.toHaveClass("shot-slot--drop-before");
    expect(source.closest(".shot-card")).not.toHaveClass("shot-card--dragging");
  });
});
