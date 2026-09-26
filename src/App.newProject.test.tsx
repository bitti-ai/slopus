// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "./App";
import type { ProjectConfig } from "./lib/project";
import type { NewProjectFolder } from "./lib/persistence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./lib/persistence", async (original) => ({ ...await original<typeof import("./lib/persistence")>(), isTauri: () => true, listRecentProjects: async () => ({ projects: [], unreadable: [] }) }));
vi.mock("./lib/runtime", async (original) => ({ ...await original<typeof import("./lib/runtime")>(), getRuntimeStatus: async () => ({ providers: [], slopfab: null }) }));

let selected: NewProjectFolder | null;
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  selected = { folderPath: "D:\\tmp\\Folder name", error: null };
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "choose_new_project_folder" || command === "inspect_new_project_folder") return selected;
    if (command === "create_project") return { folderPath: selected!.folderPath, config: (args as { config: ProjectConfig }).config };
    return undefined;
  });
});
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("selects a folder before showing the form and keeps its path when the project is renamed", async () => {
  let finish!: (folder: NewProjectFolder | null) => void;
  const regular = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "choose_new_project_folder") return new Promise((resolve) => { finish = resolve; });
    return regular(command, args);
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "New project" }));
  expect(invoke).toHaveBeenCalledWith("choose_new_project_folder");
  expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
  finish(selected);
  await screen.findByRole("dialog", { name: "New project" });
  expect(screen.getByLabelText("Project folder")).toHaveValue(selected!.folderPath);
  expect(screen.getByLabelText("Project name")).toHaveValue("Folder name");
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Different title" } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_project", expect.objectContaining({ projectDirectory: "D:\\tmp\\Folder name", config: expect.objectContaining({ name: "Different title" }) })));
});

it("cancels without opening the form, then blocks a nonempty folder next to Create", async () => {
  selected = null;
  render(<App />);
  const start = await screen.findByRole("button", { name: "New project" });
  fireEvent.click(start);
  await waitFor(() => expect(start).toBeEnabled());
  expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument();
  selected = { folderPath: "D:/Occupied", error: "The selected folder is not empty. Choose an empty folder for the new project." };
  fireEvent.click(start);
  await screen.findByRole("dialog", { name: "New project" });
  const create = screen.getByRole("button", { name: "Create project" });
  expect(create).toBeDisabled();
  expect(screen.getByRole("alert").parentElement).toBe(create.parentElement);
  expect(invoke).not.toHaveBeenCalledWith("create_project", expect.anything());
  selected = { folderPath: "D:/Empty", error: null };
  fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
  await waitFor(() => expect(screen.getByLabelText("Project folder")).toHaveValue("D:/Empty"));
  expect(screen.getByLabelText("Project name")).toHaveValue("Empty");
  expect(create).toBeEnabled();
});

it("rechecks the selected directory before creating", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "New project" }));
  await screen.findByRole("dialog", { name: "New project" });
  selected = { ...selected!, error: "The selected folder is not empty." };
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  expect(invoke).not.toHaveBeenCalledWith("create_project", expect.anything());
  selected = { ...selected, error: null };
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled());
});
