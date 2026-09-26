// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig, type CreateProjectInput, type ProjectRecord } from "../lib/project";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PromptComposer } from "./PromptComposer";
import { chooseOption, comboValue } from "./workspace/comboTestUtils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
afterEach(() => { cleanup(); localStorage.clear(); });

const project = (): ProjectRecord => ({ folderPath: "C:/project-settings", config: createProjectConfig({
  name: "Original", prompt: "Keep this brief", aspectRatio: "16:9", resolution: "768p", targetDurationSeconds: 30,
}) });

it("opens settings from the project name, saves both settings mirrors, and restores saved values", async () => {
  const record = project();
  const onSave = vi.fn(async (_record: ProjectRecord) => undefined);
  render(<ProjectWorkspace project={record} initialView="references" onBack={vi.fn()} onSave={onSave} />);
  const opener = screen.getByRole("button", { name: "Edit project settings for Original" });
  opener.focus(); fireEvent.click(opener);
  const dialog = within(screen.getByRole("dialog", { name: "Project settings" }));
  expect(dialog.getByLabelText("Project name")).toHaveValue("Original");
  expect(comboValue(dialog.getByLabelText("Aspect ratio"))).toBe("16:9");
  expect(comboValue(dialog.getByLabelText("Resolution"))).toBe("768p");
  expect(dialog.queryByLabelText("Length in seconds")).not.toBeInTheDocument();
  fireEvent.change(dialog.getByLabelText("Project name"), { target: { value: "Updated" } });
  chooseOption(dialog.getByLabelText("Aspect ratio"), "Vertical 9:16");
  chooseOption(dialog.getByLabelText("Resolution"), /^544 × 960/);
  chooseOption(dialog.getByLabelText("Look"), /^watercolor$/i);
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument());
  const saved = onSave.mock.calls[0][0].config;
  expect(saved).toMatchObject({ name: "Updated", id: record.config.id,
    brief: { prompt: "Keep this brief", aspectRatio: "9:16", resolution: "544p", targetDurationSeconds: 30 },
    settings: { aspectRatio: "9:16", resolution: "544p", defaultLook: "watercolor" },
  });
  expect(saved.timeline).toEqual(record.config.timeline);
  expect(saved.generationJobs).toEqual(record.config.generationJobs);
  expect(opener).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Updated" }));
  expect(comboValue(screen.getByLabelText("Resolution"))).toBe("544p");
  expect(screen.queryByLabelText("Length in seconds")).not.toBeInTheDocument();
  expect(comboValue(screen.getByLabelText("Look"))).toBe("watercolor");
});

it("cancels pending edits with Escape without saving", () => {
  const onSave = vi.fn();
  render(<ProjectWorkspace project={project()} initialView="references" onBack={vi.fn()} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  chooseOption(screen.getByLabelText("Aspect ratio"), "Square 1:1");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  expect(comboValue(screen.getByLabelText("Aspect ratio"))).toBe("16:9");
});

it("keeps failed saves open for retry", async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined);
  render(<ProjectWorkspace project={project()} initialView="references" onBack={vi.fn()} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  chooseOption(screen.getByLabelText("Look"), /^watercolor$/i);
  const dialog = within(screen.getByRole("dialog", { name: "Project settings" }));
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("Disk unavailable"));
  expect(comboValue(dialog.getByLabelText("Look"))).toBe("watercolor");
  fireEvent.click(dialog.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument());
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("preserves legacy resolution and short project length when opening settings", async () => {
  const config = project().config;
  config.settings.resolution = "1080p";
  config.brief.targetDurationSeconds = 5;
  const onSubmit = vi.fn(async () => undefined);
  render(<PromptComposer project={config} busy={false} onClose={vi.fn()} onCreate={onSubmit} />);
  expect(comboValue(screen.getByLabelText("Resolution"))).toBe("1080p");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ resolution: "1080p", targetDurationSeconds: 5 }));
});

it.each(["", "claymation"])("creates a project with Look %s and a 60-second timeline", (look) => {
  const onCreate = vi.fn(async (_input: CreateProjectInput) => {});
  render(<PromptComposer busy={false} onClose={vi.fn()} onCreate={onCreate} />);
  expect(screen.queryByLabelText("Length in seconds")).not.toBeInTheDocument();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(screen.queryByText("Used by scenes whose Look is set to None.")).not.toBeInTheDocument();
  chooseOption(screen.getByLabelText("Look"), look ? new RegExp(`^${look}$`, "i") : "None");
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ defaultLook: look || null, targetDurationSeconds: 60 }));
  expect(createProjectConfig(onCreate.mock.calls[0][0]).settings.defaultLook ?? null).toBe(look || null);
});

it("preserves an automatically extended project and allows clearing its default Look", () => {
  const config = project().config;
  config.brief.targetDurationSeconds = 730;
  config.settings.defaultLook = "watercolor";
  const onSubmit = vi.fn(async (_input: CreateProjectInput) => {});
  render(<PromptComposer project={config} busy={false} onClose={vi.fn()} onCreate={onSubmit} />);
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Length in seconds")).not.toBeInTheDocument();
  chooseOption(screen.getByLabelText("Look"), "None");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ targetDurationSeconds: 730, defaultLook: null }));
});
