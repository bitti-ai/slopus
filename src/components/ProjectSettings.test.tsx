// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "../lib/project";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { PromptComposer } from "./PromptComposer";

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
  expect(dialog.getByLabelText("Aspect Ratio")).toHaveValue("16:9");
  expect(dialog.getByLabelText("Resolution")).toHaveValue("768p");
  expect(dialog.getByLabelText("Length in seconds")).toHaveValue(30);
  fireEvent.change(dialog.getByLabelText("Project name"), { target: { value: "Updated" } });
  fireEvent.change(dialog.getByLabelText("Aspect Ratio"), { target: { value: "9:16" } });
  fireEvent.change(dialog.getByLabelText("Resolution"), { target: { value: "544p" } });
  fireEvent.change(dialog.getByLabelText("Length in seconds"), { target: { value: "90" } });
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument());
  const saved = onSave.mock.calls[0][0].config;
  expect(saved).toMatchObject({ name: "Updated", id: record.config.id,
    brief: { prompt: "Keep this brief", aspectRatio: "9:16", resolution: "544p", targetDurationSeconds: 90 },
    settings: { aspectRatio: "9:16", resolution: "544p" },
  });
  expect(saved.timeline).toEqual(record.config.timeline);
  expect(saved.generationJobs).toEqual(record.config.generationJobs);
  expect(opener).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Updated" }));
  expect(screen.getByLabelText("Resolution")).toHaveValue("544p");
  expect(screen.getByLabelText("Length in seconds")).toHaveValue(90);
});

it("cancels pending edits with Escape without saving", () => {
  const onSave = vi.fn();
  render(<ProjectWorkspace project={project()} initialView="references" onBack={vi.fn()} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  fireEvent.change(screen.getByLabelText("Aspect Ratio"), { target: { value: "1:1" } });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument();
  expect(onSave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  expect(screen.getByLabelText("Aspect Ratio")).toHaveValue("16:9");
});

it("keeps failed saves open for retry", async () => {
  const onSave = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined);
  render(<ProjectWorkspace project={project()} initialView="references" onBack={vi.fn()} onSave={onSave} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit project settings for Original" }));
  fireEvent.change(screen.getByLabelText("Length in seconds"), { target: { value: "120" } });
  const dialog = within(screen.getByRole("dialog", { name: "Project settings" }));
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("Disk unavailable"));
  expect(dialog.getByLabelText("Length in seconds")).toHaveValue(120);
  fireEvent.click(dialog.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project settings" })).not.toBeInTheDocument());
  expect(onSave).toHaveBeenCalledTimes(2);
});

it("preserves legacy resolution and short project length when opening settings", async () => {
  const config = project().config;
  config.settings.resolution = "1080p";
  config.brief.targetDurationSeconds = 5;
  const onSubmit = vi.fn(async () => undefined);
  render(<PromptComposer project={config} busy={false} onClose={vi.fn()} onCreate={onSubmit} />);
  expect(screen.getByLabelText("Resolution")).toHaveValue("1080p");
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ resolution: "1080p", targetDurationSeconds: 5 }));
});

it.each([false, true])("supports exact numeric lengths and the two slider intervals (editing=%s)", (editing) => {
  const onSubmit = vi.fn(async () => undefined);
  render(<PromptComposer project={editing ? project().config : undefined} busy={false} onClose={vi.fn()} onCreate={onSubmit} />);
  const slider = screen.getByRole("slider", { name: "Length slider" });
  const number = screen.getByRole("spinbutton", { name: "Length in seconds" });
  const save = screen.getByRole("button", { name: editing ? "Save changes" : "Create project" });
  for (const [position, seconds] of [[0, 0], [1, 1], [59, 59], [60, 60], [61, 70], [62, 80], [114, 600]]) {
    fireEvent.change(slider, { target: { value: String(position) } });
    expect(number).toHaveValue(seconds);
    expect(save).toBeEnabled();
  }
  fireEvent.change(number, { target: { value: "73" } });
  fireEvent.click(save);
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ targetDurationSeconds: 73 }));
  for (const value of ["", "-1", "601", "3.5"]) {
    fireEvent.change(number, { target: { value } });
    expect(save).toBeDisabled();
  }
});
