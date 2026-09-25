// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PromptComposer } from "./PromptComposer";
import { createProjectConfig, parseProjectConfig, type ProjectRecord } from "../lib/project";
import { executeAgentCommands } from "../lib/runtime";
import { imageScenePrompt } from "../lib/imageScene";
import { saveDebugOptionsEnabled } from "../lib/settings";
import fixture from "../../fixtures/project-v1-image.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => { cleanup(); localStorage.clear(); });
const record = (): ProjectRecord => ({ folderPath: "D:/Images", config: parseProjectConfig(fixture) });

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
  expect(screen.queryByRole("button", { name: "Debug Prompt" })).not.toBeInTheDocument();
  act(() => saveDebugOptionsEnabled(true));
  // The complete scene prompt is available even with a child selected.
  fireEvent.contextMenu(screen.getByRole("button", { name: "Image" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Text" }));
  fireEvent.change(screen.getByLabelText("Text to render"), { target: { value: "TO THE MOON" } });
  const inspector = screen.getByRole("complementary", { name: "Image node inspector" });
  const button = within(inspector).getByRole("button", { name: "Debug Prompt" });
  expect(inspector.lastElementChild).toContainElement(button);
  button.focus();
  fireEvent.click(button);
  const prompt = within(screen.getByRole("dialog", { name: "Debug Prompt" })).getByLabelText("The compiled MiniMax H3 prompt");
  for (const line of imageScenePrompt(project.config.imageScene!, "Watercolor").split("\n")) expect(prompt.textContent).toContain(line);
  expect(prompt.textContent).toContain('Render the exact text "TO THE MOON".');
  expect(prompt.textContent).toContain("Watercolor visual style");
  expect(prompt.textContent).toContain("subject_definitions:\n<Subject 1> is Rocket, providing appearance from <Picture 1> and <Picture 2>. A silver rocket.\n<Subject 2> is Mood, providing appearance. Peaceful and bright.");
  expect(prompt.textContent).toContain("[Shot 1] A rocket launch over the ocean at dawn.");
  expect(prompt.textContent).toMatch(/overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/);
  expect(prompt.textContent).not.toContain("Do not include this reference");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  act(() => saveDebugOptionsEnabled(false));
  expect(screen.queryByRole("button", { name: "Debug Prompt" })).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "Debug Prompt" })).not.toBeInTheDocument();
});

it("offers image and video projects when creating a folder project", async () => {
  const submit = vi.fn(async () => undefined);
  render(<PromptComposer busy={false} onCreate={submit} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("radio", { name: "Image project" }));
  expect(screen.getByLabelText("Project name")).toHaveValue("Untitled image");
  expect(screen.getByText("Image settings")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Create project/ }));
  await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ generationType: "image" })));
});

it("opens the three-tab image workspace and saves hierarchy/inspector edits through the project session", async () => {
  const save = vi.fn(async () => undefined);
  render(<ProjectWorkspace project={record()} onBack={vi.fn()} onSave={save} />);
  const navigation = within(screen.getByRole("navigation", { name: "Project views" }));
  expect(navigation.getAllByRole("button").map((button) => button.textContent)).toEqual([" Agent", " Editor", " References"]);
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
  fireEvent.click(navigation.getByRole("button", { name: "References" }));
  fireEvent.click(navigation.getByRole("button", { name: "Editor" }));
  expect(screen.getByRole("tree", { name: "Image nodes" })).toBeInTheDocument();
});

it("keeps the video tabs and applies image agent commands without changing generated output", async () => {
  const image = record().config;
  const { outputAssetId: _output, ...authored } = image.imageScene!;
  const next = await executeAgentCommands(image, [{ op: "image.set", ...authored, background: "A moonlit ocean" }]);
  expect(next.imageScene?.background).toBe("A moonlit ocean");
  const video = createProjectConfig({ name: "Film", prompt: "", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 60 });
  await expect(executeAgentCommands(video, [{ op: "image.set", ...authored }])).rejects.toThrow("image project");
  render(<ProjectWorkspace project={{ folderPath: "D:/Film", config: video }} onBack={vi.fn()} onSave={vi.fn()} />);
  const navigation = within(screen.getByRole("navigation", { name: "Project views" }));
  expect(navigation.getByRole("button", { name: "Timeline" })).toBeInTheDocument();
  expect(navigation.getByRole("button", { name: "Generator" })).toBeInTheDocument();
  expect(navigation.queryByRole("button", { name: "Editor" })).not.toBeInTheDocument();
});
