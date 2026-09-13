// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProjectConfig } from "../../lib/project";
import { builtinIconVisitAction } from "../../lib/referenceIconSettings";
import { ReferencesView } from "./ReferencesView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockResolvedValue([]);
});
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
const open = (generate = vi.fn()) => {
  const config = createProjectConfig({ name: "Icons", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  return { generate, ...render(<ReferencesView config={config} folderPath="C:/project" onChange={vi.fn()} onGenerateBuiltinIcons={generate} />) };
};

it("asks on the first Add reference visit, explains video priority, and remembers Start", async () => {
  const view = open();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  const prompt = await screen.findByRole("alertdialog", { name: "Generate built-in reference icons?" });
  expect(prompt).toHaveTextContent("take a long time");
  expect(prompt).toHaveTextContent("pauses for normal video generation");
  expect(view.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(screen.getByRole("button", { name: "Start generation" }));
  expect(view.generate).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog", { name: "Add a reference" })).toBeInTheDocument();
  view.unmount(); sessionStorage.clear();
  open(view.generate);
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  await waitFor(() => expect(view.generate).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("remembers Cancel across sessions without starting generation", async () => {
  const view = open();
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("checkbox", { name: /Don't ask again/ }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  sessionStorage.clear();
  expect(builtinIconVisitAction()).toBe("skip");
  expect(view.generate).not.toHaveBeenCalled();
});

it("does not ask again on another visit in the same session when Cancel is not remembered", async () => {
  open();
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Close type picker" }));
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_builtin_reference_icons"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(localStorage.getItem("slopus.builtin-reference-icons.v1")).toBeNull();
});
