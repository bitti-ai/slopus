// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PromptComposer } from "./PromptComposer";
import { choose } from "./workspace/comboTestUtils";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "../lib/project";
import { executeAgentCommands } from "../lib/runtime";
import { imageScenePrompt } from "../lib/imageScene";
import { EMPTY_ENGINE_SETTINGS, saveDebugOptionsEnabled, saveGeneratorTemplateSettings } from "../lib/settings";
import { imageGenerationSnapshot } from "../lib/imageHistory";
import { WorkQueue } from "../lib/workQueue";
import * as runtime from "../lib/runtime";
import fixture from "../../fixtures/project-v1-image.json";
import { invoke } from "@tauri-apps/api/core";
import * as persistence from "../lib/persistence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });
const record = (): ProjectRecord => ({ folderPath: "D:/Images", config: parseProjectConfig(fixture) });

it.each([false, true])("scopes generation controls to each image and queues others (draft: %s)", async (imageDraft) => {
  vi.spyOn(persistence, "isTauri").mockReturnValue(true);
  vi.spyOn(persistence, "readMediaFileUrl").mockResolvedValue(null);
  vi.spyOn(runtime, "resolveSlopfabPlan").mockResolvedValue({ alignedFrames: 1, canvasWidth: 768, canvasHeight: 768 } as Awaited<ReturnType<typeof runtime.resolveSlopfabPlan>>);
  const enqueue = vi.spyOn(runtime, "enqueueSlopfabGeneration").mockResolvedValue(undefined);
  const cancel = vi.spyOn(runtime, "cancelSlopfabGeneration").mockResolvedValue(true);
  saveGeneratorTemplateSettings({ defaultTemplateId: "test", templates: [{ id: "test", name: "Test", defaultSteps: 20, attention: "sage2", paths: { ...EMPTY_ENGINE_SETTINGS, transformer: "D:/h3.safetensors" } }] });
  const project = record();
  project.config.assets = ["First", "Second", "Third"].map((name) => ({ id: name, name, kind: "image", imageDraft,
    relativePath: `media/generated/${name}.jpg`, mimeType: "image/jpeg", createdAt: project.config.createdAt,
    imageGeneration: imageGenerationSnapshot(project.config, "", "test") }));
  project.config.imageScene!.outputAssetId = "First";
  const queue = new WorkQueue(vi.fn(async (record) => record));
  render(<ProjectWorkspace project={project} workQueue={queue} onBack={vi.fn()} onSave={vi.fn()} />);
  const panel = within(screen.getByRole("region", { name: "Image panel" }));
  fireEvent.click(panel.getByRole("button", { name: "Generate" }));
  await waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
  expect(panel.getByRole("button", { name: "Cancel" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  expect(panel.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  expect(panel.getByRole("combobox", { name: "Generator" })).toBeEnabled();
  fireEvent.click(panel.getByRole("button", { name: "Generate" }));
  expect(queue.getSnapshot().map((item) => [item.imageAssetId, item.status])).toEqual([["First", "generating"], ["Second", "queued"]]);
  expect(enqueue).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "View Third" }));
  expect(panel.getByRole("button", { name: "Generate" })).toBeEnabled();
  expect(panel.queryByRole("progressbar")).not.toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: "View First" }));
  expect(screen.getByRole("menuitem", { name: "Remove" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("menu", { name: "Generated image actions" }), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "View First" }));
  fireEvent.click(panel.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(queue.getSnapshot()[0].id));
  fireEvent.click(screen.getByRole("button", { name: "View Second" }));
  fireEvent.click(panel.getByRole("button", { name: "Cancel" }));
  expect(queue.getSnapshot()[1].status).toBe("cancelled");
  expect(panel.getByRole("button", { name: "Generate" })).toBeEnabled();
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
    folderPath: "D:/Images", relativePath: "media/generated/Second.jpg", options: { format: "jpg", width: 1024, height: 768, quality: 90 },
  }));
  expect(within(settings).getByRole("button", { name: "Exporting…" })).toBeDisabled();
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
  expect(button).toHaveAttribute("data-tooltip", "Generate an image in the Editor first.");
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
  project.config.imageScene!.referenceIds = ["subject", "mood"];
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
  for (const line of imageScenePrompt(project.config.imageScene!, "Watercolor").split("\n")) expect(prompt.textContent).toContain(line);
  expect(prompt.textContent).toContain('Render the exact text "TO THE MOON".');
  expect(prompt.textContent).toContain("Watercolor visual style");
  expect(prompt.textContent).toContain("subject_definitions:\n<Subject 1> is Rocket, providing appearance from <Picture 1> and <Picture 2>. A silver rocket.\n<Subject 2> is Mood, providing appearance. Peaceful and bright.");
  expect(prompt.textContent).toContain("[Shot 1] A rocket launch over the ocean at dawn.");
  expect(prompt.textContent).toMatch(/overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/);
  expect(prompt.textContent).not.toContain("Do not include this reference");
  fireEvent.keyDown(prompt, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
  fireEvent.click(button);
  act(() => saveDebugOptionsEnabled(false));
  expect(screen.queryByRole("button", { name: "Debug prompt" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Debug prompt" })).not.toBeInTheDocument();
});

it("offers image and video projects when creating a folder project", async () => {
  const submit = vi.fn(async () => undefined);
  render(<PromptComposer busy={false} onCreate={submit} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Image project" }));
  expect(screen.getByLabelText("Project name")).toHaveValue("Untitled image");
  choose("Resolution", "2720 × 1536");
  fireEvent.click(screen.getByRole("radio", { name: "Video project" }));
  expect(screen.getByRole("combobox", { name: "Resolution" })).toHaveTextContent("1376 × 768 (default)");
  fireEvent.click(screen.getByRole("radio", { name: "Image project" }));
  choose("Resolution", "3648 × 2048");
  fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ generationType: "image", resolution: "2048p" })));
});

it("opens the three-tab image workspace and saves hierarchy/inspector edits through the project session", async () => {
  const save = vi.fn(async () => undefined);
  render(<ProjectWorkspace project={record()} onBack={vi.fn()} onSave={save} />);
  const navigation = within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Editor", "References", "Export"]);
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Text" }));
  fireEvent.change(screen.getByLabelText("Text to render"), { target: { value: "Hello world" } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Large blue letters" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]).toBeDefined();
  const saved = (save.mock.calls as unknown as [ProjectRecord][])[0][0];
  expect(saved.config.imageScene?.nodes.at(-1)).toMatchObject({ kind: "text", text: "Hello world", description: "Large blue letters", parentId: "image-root" });
  expect(parseProjectConfig(saved.config).imageScene).toEqual(saved.config.imageScene);
  fireEvent.click(navigation.getByRole("tab", { name: /References/ }));
  fireEvent.click(navigation.getByRole("tab", { name: /Editor/ }));
  expect(screen.getByRole("tree", { name: "Image nodes" })).toBeInTheDocument();
  fireEvent.keyDown(document.body, { key: "3", code: "Digit3", ctrlKey: true });
  expect(navigation.getByRole("tab", { name: /Export/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("region", { name: "Image preview" })).toBeInTheDocument();
});

it("keeps the video tabs and applies image agent commands without changing generated output", async () => {
  const image = record().config;
  const { outputAssetId: _output, ...authored } = image.imageScene!;
  const next = await executeAgentCommands(image, [{ op: "image.set", ...authored, background: "A moonlit ocean" }]);
  expect(next.imageScene?.background).toBe("A moonlit ocean");
  const video = createProjectConfig({ name: "Film", prompt: "", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 60 });
  await expect(executeAgentCommands(video, [{ op: "image.set", ...authored }])).rejects.toThrow("image project");
  render(<ProjectWorkspace project={{ folderPath: "D:/Film", config: video }} onBack={vi.fn()} onSave={vi.fn()} />);
  const navigation = within(screen.getByRole("tablist", { name: "Project views" }));
  expect(navigation.getByRole("tab", { name: /Timeline/ })).toBeInTheDocument();
  expect(navigation.getByRole("tab", { name: /Generator/ })).toBeInTheDocument();
  expect(navigation.queryByRole("tab", { name: /Editor/ })).not.toBeInTheDocument();
});
