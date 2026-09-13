// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProjectConfig } from "../../lib/project";
import { builtinIconVisitAction } from "../../lib/referenceIconSettings";
import { ReferencesView } from "./ReferencesView";
import { REFERENCE_PRESETS } from "../../lib/reference-presets";

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

it("generates a preset icon without selecting its card and supports regenerating existing artwork", () => {
  const preset = REFERENCE_PRESETS.find(({ name }) => name === "Abby Sciuto")!;
  const previous = preset.icon;
  const config = createProjectConfig({ name: "Icons", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 });
  const onChange = vi.fn();
  const generate = vi.fn();
  const props = { config, folderPath: "C:/project", onChange, onRegenerateBuiltinIcon: generate };
  const view = render(<ReferencesView {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Add a reference/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search reference options" }), { target: { value: preset.name } });
  const button = screen.getByRole("button", { name: `Generate icon for ${preset.name}` });
  expect(button.parentElement?.querySelector(".reference-preset-select")?.contains(button)).toBe(false);
  fireEvent.click(button);
  expect(generate).toHaveBeenCalledWith(preset.id);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Add a reference" })).toBeInTheDocument();
  view.rerender(<ReferencesView {...props} pendingBuiltinIconIds={new Set([preset.id])} />);
  expect(button).toBeDisabled();
  try {
    preset.icon = "/complete-icon.jpg";
    view.rerender(<ReferencesView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: `Regenerate icon for ${preset.name}` }));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();
  } finally { preset.icon = previous; }
});

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
