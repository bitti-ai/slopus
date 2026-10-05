// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { placePromptCaret, typePrompt } from "./workspace/promptTestUtils";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PromptComposer } from "./PromptComposer";
import { choose } from "./workspace/comboTestUtils";
import { createProjectConfig, parseProjectConfig, type CreateProjectInput, type ProjectRecord } from "../lib/project";
import { executeAgentCommands } from "../lib/runtime";
import { imageScenePrompt } from "../lib/imageScene";
import { EMPTY_ENGINE_SETTINGS, saveDebugOptionsEnabled, saveGeneratorTemplateSettings } from "../lib/settings";
import { imageGenerationSnapshot } from "../lib/imageHistory";
import { WorkQueue } from "../lib/workQueue";
import * as runtime from "../lib/runtime";
import fixture from "../../fixtures/project-v1-image.json";
import videoFixture from "../../fixtures/project-v1-complete.json";
import { invoke } from "@tauri-apps/api/core";
import * as persistence from "../lib/persistence";
import { getExportJobs, resetExportJobForTests } from "../lib/exportJob";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => { cleanup(); resetExportJobForTests(); localStorage.clear(); vi.restoreAllMocks(); });
const record = (): ProjectRecord => ({ folderPath: "D:/Images", config: parseProjectConfig(fixture) });

it("opens template settings and executes only after configuring prompts and clothing references", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const template = { id: "test", name: "Test", modelType: "minimax-h3" as const, defaultSteps: 20, attention: "sage2" as const, paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "D:/h3.safetensors" } };
  saveGeneratorTemplateSettings({ defaultTemplateId: "test", templates: [template] });
  const project = record();
  project.config.assets = ["First", "Selected"].map((id) => ({ id, name: id, kind: "image", relativePath: `media/${id}.png`, mimeType: "image/png", createdAt: project.config.createdAt }));
  project.config.references = [{ id: "outfit", name: "Red coat", kind: "image", description: "A red wool coat", relativePath: "references/coat.png", intendedUse: [], createdAt: project.config.createdAt }];
  const queue = new WorkQueue(vi.fn(async (record) => record));
  const generate = vi.spyOn(queue, "enqueueCharacterSheet").mockImplementation(() => undefined);
  render(<ProjectWorkspace project={project} workQueue={queue} onBack={vi.fn()} onSave={vi.fn()} />);
  const toolbar = within(screen.getByRole("toolbar", { name: "Image tools" }));
  expect(toolbar.getByRole("button", { name: "Template" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "View Selected" }));
  toolbar.getByRole("button", { name: "Template" }).focus();
  fireEvent.click(toolbar.getByRole("button", { name: "Template" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Character sheet" }));
  expect(generate).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu", { name: "Image templates" })).not.toBeInTheDocument();
  expect(screen.queryByRole("complementary", { name: "Image node inspector" })).not.toBeInTheDocument();
  const panel = within(screen.getByRole("complementary", { name: "Character sheet settings" }));
  const before = structuredClone(queue.project(project).getSnapshot().config);
  choose("Character sheet resolution", "2048 px high");
  expect(panel.getByText(/Sheet size:/)).toHaveTextContent("5504 × 2048 px");
  fireEvent.change(panel.getByRole("spinbutton", { name: "Steps" }), { target: { value: "" } });
  expect(panel.getByRole("button", { name: "Execute" })).toBeDisabled();
  fireEvent.change(panel.getByRole("spinbutton", { name: "Steps" }), { target: { value: "37" } });
  fireEvent.change(panel.getByRole("spinbutton", { name: "Seed" }), { target: { value: "0" } });
  expect(panel.queryByRole("textbox", { name: "Clothing and accessories" })).not.toBeInTheDocument();
  const prompt = panel.getByRole("textbox", { name: "Character sheet prompt" });
  typePrompt(prompt, "Soft studio lighting. Wear");
  placePromptCaret(prompt);
  fireEvent.click(within(prompt.closest(".image-inspector__area") as HTMLElement).getByRole("button", { name: "Reference" }));
  fireEvent.click(screen.getByRole("button", { name: /Red coat/ }));
  expect(prompt.querySelector(".prompt-chip")).toHaveTextContent("Red coat");
  expect(queue.project(project).getSnapshot().config).toEqual(before);
  fireEvent.click(panel.getByRole("button", { name: "Execute" }));
  expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "test" }), "Selected", { prompt: "Soft studio lighting. Wear @[ref:outfit]", height: 2048, steps: 37, seed: 0 });
  fireEvent.click(panel.getByRole("button", { name: "Close template settings" }));
  expect(screen.getByRole("complementary", { name: "Image node inspector" })).toBeInTheDocument();
  fireEvent.click(toolbar.getByRole("button", { name: "Template" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Character sheet" }));
  fireEvent.click(screen.getByRole("button", { name: "View First" }));
  expect(screen.queryByRole("complementary", { name: "Character sheet settings" })).not.toBeInTheDocument();
});

it.each(["Create Scene", "Create Reference"])("opens and saves the item created by %s in the image bar", async (action) => {
  const project = record();
  project.config.assets = [{ id: "poster", name: "Poster", kind: "image", relativePath: "media/generated/poster.png", mimeType: "image/png", createdAt: project.config.createdAt }];
  project.config.imageScene!.outputAssetId = "poster";
  const save = vi.fn(async (_record: ProjectRecord) => undefined);
  render(<ProjectWorkspace project={project} onBack={vi.fn()} onSave={save} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "View Poster" }));
  fireEvent.click(screen.getByRole("menuitem", { name: action }));
  const navigation = within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation.getByRole("tab", { name: action === "Create Scene" ? "Video" : "References" })).toHaveAttribute("aria-selected", "true");
  if (action === "Create Scene") expect(screen.getByRole("button", { name: "Start frame for this scene" })).toHaveTextContent("Poster");
  else expect(screen.getByLabelText("Reference name")).toHaveValue("Poster");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const saved = parseProjectConfig(JSON.parse(JSON.stringify(save.mock.calls[0][0].config)));
  expect(saved.references[0].images?.[0].relativePath).toBe("media/generated/poster.png");
  if (action === "Create Scene") expect(saved.generationJobs.at(-1)?.startFrameReferenceId).toBe(saved.references[0].id);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1][0].config.references).toEqual(project.config.references);
  expect(save.mock.calls[1][0].config.generationJobs).toEqual(project.config.generationJobs);
});

it.each([false, true])("scopes generation controls to each image and queues others (draft: %s)", async (imageDraft) => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.spyOn(runtime, "resolveSlopfabPlan").mockResolvedValue({ alignedFrames: 1, canvasWidth: 768, canvasHeight: 768 } as Awaited<ReturnType<typeof runtime.resolveSlopfabPlan>>);
  const enqueue = vi.spyOn(runtime, "enqueueSlopfabGeneration").mockResolvedValue(undefined);
  const cancel = vi.spyOn(runtime, "cancelSlopfabGeneration").mockResolvedValue(true);
  saveGeneratorTemplateSettings({ defaultTemplateId: "test", templates: [{ id: "test", name: "Test", modelType: "minimax-h3", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "D:/h3.safetensors" } }] });
  const project = record();
  project.config.assets = ["First", "Second", "Third"].map((name) => ({ id: name, name, kind: "image", imageDraft,
    relativePath: `media/generated/${name}.jpg`, mimeType: "image/jpeg", createdAt: project.config.createdAt,
    imageGeneration: imageGenerationSnapshot(project.config, "", "test") }));
  project.config.imageScene!.outputAssetId = "First";
  const queue = new WorkQueue(vi.fn(async (record) => record));
  render(<ProjectWorkspace project={project} workQueue={queue} onBack={vi.fn()} onSave={vi.fn()} />);
  const panel = within(screen.getByRole("region", { name: "Image panel" }));
  const toolbar = within(screen.getByRole("toolbar", { name: "Image tools" }));
  fireEvent.click(toolbar.getByRole("button", { name: "Generate" }));
  await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
  expect(toolbar.getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  expect(toolbar.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(toolbar.getByRole("combobox", { name: "Generator" })).toBeEnabled();
  fireEvent.click(toolbar.getByRole("button", { name: "Generate" }));
  expect(queue.getSnapshot().map((item) => [item.imageAssetId, item.status])).toEqual([["First", "generating"], ["Second", "queued"]]);
  expect(enqueue).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "View Third" }));
  expect(toolbar.getByRole("button", { name: "Generate" })).toBeEnabled();
  expect(panel.queryByRole("progressbar")).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: "View First" }));
  expect(screen.getByRole("menuitem", { name: "Remove" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("menu", { name: "Generated image actions" }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "View First" }));
  fireEvent.click(toolbar.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(queue.getSnapshot()[0].id));
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  fireEvent.click(toolbar.getByRole("button", { name: "Cancel" }));
  expect(queue.getSnapshot()[1].status).toBe("cancelled");
  expect(toolbar.getByRole("button", { name: "Generate" })).toBeEnabled();
});

it("exports the selected image from the Export tab and handles cancellation and errors", async () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const project = record();
  project.config.assets = ["First", "Second"].map((name) => ({ id: name, name, kind: "image", relativePath: `media/generated/${name}.jpg`, mimeType: "image/jpeg", width: 1024, height: 768, createdAt: project.config.createdAt }));
  project.config.imageScene!.outputAssetId = "First";
  let complete!: (value: boolean) => void;
  const exporting = new Promise<boolean>((resolve) => { complete = resolve; });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "choose_image_export_destination") return "D:/out.jpg" as never;
    if (command === "export_generated_image") return await exporting as never;
    return undefined as never;
  });
  render(<ProjectWorkspace project={project} onBack={vi.fn()} onSave={vi.fn()} />);
  // No title-bar Export button any more: only Save sits among the commands.
  expect(screen.queryByRole("button", { name: /^Export/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  fireEvent.click(within(screen.getByRole("tablist", { name: "Project views" })).getByRole("tab", { name: /Export/ }));
  const settings = screen.getByRole("region", { name: "Export settings" });
  expect(within(settings).getByRole("combobox", { name: "Format" })).toHaveTextContent("JPG");
  expect(within(settings).getByRole("combobox", { name: "Resolution" })).toHaveTextContent("1024 × 768 (original)");
  const preview = screen.getByRole("region", { name: "Image preview" });
  expect(within(preview.querySelector(".export-screen") as HTMLElement).getByRole("img", { name: /Second/ })).toBeInTheDocument();
  expect(within(screen.getByLabelText("Generated images")).getByRole("button", { name: "View Second" })).toHaveAttribute("aria-pressed", "true");
  const button = within(settings).getByRole("button", { name: "Export…" });
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("export_generated_image", {
    jobId: expect.any(String), destination: "D:/out.jpg",
    folderPath: "D:/Images", relativePath: "media/generated/Second.jpg", options: { format: "jpg", width: 1024, height: 768, quality: 90 },
  }));
  expect(within(settings).getByRole("button", { name: "Cancel export" })).toBeEnabled();
  expect(getExportJobs()[0]).toMatchObject({ kind: "image", status: "running" });
  await act(async () => complete(false));
  expect(button).toBeEnabled();
  expect(button).toHaveTextContent("Export…");
  expect(screen.queryByText("Couldn’t export image")).not.toBeInTheDocument();
  vi.mocked(invoke).mockRejectedValueOnce("Destination is not writable");
  fireEvent.click(button);
  expect(await within(settings).findByText("Destination is not writable")).toBeInTheDocument();
  expect(within(settings).getByText("Couldn’t export image")).toBeInTheDocument();
  expect(button).toBeEnabled();
});

it("disables image export until a generated image is selected, and says why", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  render(<ProjectWorkspace project={record()} onBack={vi.fn()} onSave={vi.fn()} />);
  fireEvent.keyDown(document.body, { key: "e", code: "KeyE", ctrlKey: true });
  expect(within(screen.getByRole("tablist", { name: "Project views" })).getByRole("tab", { name: /Export/ })).toHaveAttribute("aria-selected", "true");
  const button = screen.getByRole("button", { name: "Export…" });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute("data-tooltip", "Generate an image in the Image tab first.");
  expect(screen.getByText("No image to export yet")).toBeInTheDocument();
});

it("disables image export outside the desktop app", () => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(false);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  const project = record();
  project.config.assets = [{ id: "Only", name: "Only", kind: "image", relativePath: "media/generated/Only.jpg", mimeType: "image/jpeg", createdAt: project.config.createdAt }];
  project.config.imageScene!.outputAssetId = "Only";
  render(<ProjectWorkspace project={project} initialView="export" onBack={vi.fn()} onSave={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Export…" })).toBeDisabled();
  expect(screen.getAllByText("Exporting is available in the Slopus desktop app.").length).toBeGreaterThan(0);
  expect(screen.queryByText(/ × .* px/)).not.toBeInTheDocument();
});

it("shows the full image prompt at the end of the inspector only when debug is enabled", () => {
  const project = record();
  project.config.settings.defaultLook = "watercolor";
  project.config.references = [
    { id: "subject", kind: "image", name: "Rocket", description: "A silver rocket", relativePath: "references/rocket.png", images: [{ id: "detail", name: "Detail", relativePath: "references/detail.png", sourcePath: null }], intendedUse: [], createdAt: project.config.createdAt },
    { id: "mood", kind: "text", name: "Mood", description: "Peaceful and bright", intendedUse: [], createdAt: project.config.createdAt },
    { id: "unused", kind: "text", name: "Unused", description: "Do not include this reference", intendedUse: [], createdAt: project.config.createdAt },
  ];
  // Only cited references reach the prompt; Unused is never cited.
  project.config.imageScene!.nodes[0].description = "A @[ref:subject] launch over the ocean at dawn, @[ref:mood]";
  render(<ProjectWorkspace project={project} onBack={vi.fn()} onSave={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Debug prompt" })).not.toBeInTheDocument();
  act(() => saveDebugOptionsEnabled(true));
  // The complete scene prompt is available even with a child selected.
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Text" }));
  fireEvent.change(screen.getByLabelText("Text to render"), { target: { value: "TO THE MOON" } });
  const inspector = screen.getByRole("complementary", { name: "Image node inspector" });
  const button = within(inspector).getByRole("button", { name: "Debug prompt" });
  expect(inspector.lastElementChild).toContainElement(button);
  button.focus();
  fireEvent.click(button);
  const prompt = within(screen.getByRole("dialog", { name: "Debug prompt" })).getByLabelText("The compiled MiniMax H3 prompt");
  const compiled = imageScenePrompt(project.config.imageScene!, "Watercolor").replace("@[ref:subject]", "<Subject 1>").replace("@[ref:mood]", "<Subject 2>");
  for (const line of compiled.split("\n")) expect(prompt.textContent).toContain(line);
  expect(prompt.textContent).toContain('Render the exact text "TO THE MOON".');
  expect(prompt.textContent).toContain("Watercolor visual style");
  expect(prompt.textContent).toContain("subject_definitions:\n<Subject 1> is Rocket, providing appearance from <Picture 1> and <Picture 2>. A silver rocket.\n<Subject 2> is Mood, providing appearance. Peaceful and bright.");
  expect(prompt.textContent).toContain("[Shot 1] A <Subject 1> launch over the ocean at dawn, <Subject 2>.");
  expect(prompt.textContent).toMatch(/overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/);
  expect(prompt.textContent).not.toContain("Do not include this reference");
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
  fireEvent.click(button);
  act(() => saveDebugOptionsEnabled(false));
  expect(screen.queryByRole("button", { name: "Debug prompt" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
});

it("creates one project without a separate image or video type", async () => {
  const submit = vi.fn(async (_input: CreateProjectInput) => undefined);
  render(<PromptComposer busy={false} onCreate={submit} onClose={vi.fn()} />);
  expect(screen.queryByRole("radiogroup", { name: "Project type" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Project name")).toHaveValue("Untitled project");
  choose("Resolution", "3648 × 2048");
  fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ resolution: "2048p" })));
  expect(submit.mock.calls[0][0]).not.toHaveProperty("generationType");
});

it("opens a legacy image project on Image with all five tabs and saves composition edits", async () => {
  const save = vi.fn(async () => undefined);
  render(<ProjectWorkspace project={record()} onBack={vi.fn()} onSave={save} />);
  const navigation = within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Timeline", "Video", "Image", "References", "Export"]);
  expect(navigation.getByRole("tab", { name: "Image" })).toHaveAttribute("aria-selected", "true");
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Text" }));
  fireEvent.change(screen.getByLabelText("Text to render"), { target: { value: "Hello world" } });
  typePrompt(screen.getByLabelText("Description"), "Large blue letters");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]).toBeDefined();
  const saved = (save.mock.calls as unknown as [ProjectRecord][])[0][0];
  expect(saved.config.imageScene?.nodes.at(-1)).toMatchObject({ kind: "text", text: "Hello world", description: "Large blue letters", parentId: "image-root" });
  expect(parseProjectConfig(saved.config).imageScene).toEqual(saved.config.imageScene);
  fireEvent.click(navigation.getByRole("tab", { name: /References/ }));
  fireEvent.click(navigation.getByRole("tab", { name: "Image" }));
  expect(screen.getByRole("tree", { name: "Image nodes" })).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "5", code: "Digit5", ctrlKey: true });
  expect(navigation.getByRole("tab", { name: /Export/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("region", { name: "Image preview" })).toBeInTheDocument();
});

it("keeps the video tabs and applies image agent commands without changing generated output", async () => {
  const image = record().config;
  const { outputAssetId: _output, ...authored } = image.imageScene!;
  const next = await executeAgentCommands(image, [{ op: "image.set", ...authored, background: "A moonlit ocean" }]);
  expect(next.imageScene?.background).toBe("A moonlit ocean");
  const video = createProjectConfig({ name: "Film", prompt: "", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 60 });
  const mixed = await executeAgentCommands(video, [{ op: "image.set", ...authored }]);
  expect(mixed.imageScene?.nodes).toEqual(authored.nodes);
  expect(mixed.timeline).toEqual(video.timeline);
  expect(mixed.generationJobs).toEqual(video.generationJobs);
  render(<ProjectWorkspace project={{ folderPath: "D:/Film", config: video }} onBack={vi.fn()} onSave={vi.fn()} />);
  const navigation = within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation.getByRole("tab", { name: /Timeline/ })).toBeInTheDocument();
  expect(navigation.getByRole("tab", { name: "Video" })).toBeInTheDocument();
  expect(navigation.getByRole("tab", { name: "Image" })).toBeInTheDocument();
});

it("adds and reopens an image in an older video project while preserving its video content", async () => {
  const project = { folderPath: "D:/Legacy film", config: parseProjectConfig(videoFixture) };
  const save = vi.fn(async (_record: ProjectRecord) => undefined);
  const workspace = render(<ProjectWorkspace project={project} onBack={vi.fn()} onSave={save} />);
  const navigation = () => within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation().getByRole("tab", { name: "Timeline" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(document.body, { key: "3", code: "Digit3", ctrlKey: true });
  expect(navigation().getByRole("tab", { name: "Image" })).toHaveAttribute("aria-selected", "true");
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Text" }));
  fireEvent.change(screen.getByLabelText("Text to render"), { target: { value: "Film poster" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  const saved = save.mock.calls[0][0];
  expect(saved.config.timeline).toEqual(project.config.timeline);
  expect(saved.config.generationJobs).toEqual(project.config.generationJobs);
  workspace.unmount();
  render(<ProjectWorkspace project={{ ...saved, config: parseProjectConfig(JSON.parse(JSON.stringify(saved.config))) }} onBack={vi.fn()} onSave={save} />);
  fireEvent.click(navigation().getByRole("tab", { name: "Image" }));
  fireEvent.click(within(screen.getByRole("tree", { name: "Image nodes" })).getByRole("button", { name: "Text" }));
  expect(screen.getByLabelText("Text to render")).toHaveValue("Film poster");
  fireEvent.click(navigation().getByRole("tab", { name: "Export" }));
  const exportTypes = within(screen.getByRole("tablist", { name: "Export type" }));
  expect(exportTypes.getByRole("tab", { name: "Image" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(exportTypes.getByRole("tab", { name: "Video" }));
  expect(exportTypes.getByRole("tab", { name: "Video" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(exportTypes.getByRole("tab", { name: "Image" }));
  expect(screen.getByRole("region", { name: "Image preview" })).toBeInTheDocument();
});
