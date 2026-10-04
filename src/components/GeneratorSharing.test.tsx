// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GeneratorSharing } from "./GeneratorSharing";
import { SettingsView } from "./SettingsView";
import { createGeneratorTemplate, loadGeneratorTemplateSettings, minimaxOriginalTemplate, saveGeneratorTemplateSettings } from "../lib/settings";
import { parseGeneratorSlop, serializeGeneratorSlop } from "../lib/slop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  vi.mocked(invoke).mockImplementation(async () => null as never);
});
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("exports only chosen URL templates through the native save dialog", async () => {
  const template = minimaxOriginalTemplate();
  render(<GeneratorSharing templates={[createGeneratorTemplate("Local setup"), template, { ...template, id: "other", name: "Other" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = within(screen.getByRole("dialog", { name: "Export generator templates" }));
  expect((dialog.getByRole("checkbox", { name: "Export Local setup" }) as HTMLInputElement).disabled).toBe(true);
  expect(dialog.getByText(/Add a download URL for Transformer weights/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("checkbox", { name: "Export Other" }));
  vi.mocked(invoke).mockResolvedValue(true);
  fireEvent.click(dialog.getByRole("button", { name: "Export" }));
  await screen.findByText("Exported 1 generator template.");
  const [command, args] = vi.mocked(invoke).mock.calls[0];
  expect(command).toBe("export_slop_file");
  expect(args).toMatchObject({ filename: "First-Last Frame.slop" });
  expect(parseGeneratorSlop((args as { contents: string }).contents).items.map(({ data }) => data.name)).toEqual([template.name]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("imports from the Generators page and updates its list without downloading or replacing defaults", async () => {
  const shared = { ...minimaxOriginalTemplate(), name: "Shared generator" };
  vi.mocked(invoke).mockImplementation(async (command) => command === "import_slop_file" ? serializeGeneratorSlop([shared]) : null as never);
  const previous = loadGeneratorTemplateSettings();
  render(<SettingsView onClose={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("Added 1 generator template.");
  expect(screen.getByRole("button", { name: "Edit Shared generator generator" })).toBeTruthy();
  expect(loadGeneratorTemplateSettings().templates).toHaveLength(previous.templates.length + 1);
  expect(loadGeneratorTemplateSettings().defaultTemplateId).toBe(previous.defaultTemplateId);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "download_weight")).toBe(false);
});

it("does not mutate on cancellation or malformed files, and reports native read errors", async () => {
  const before = loadGeneratorTemplateSettings();
  render(<GeneratorSharing templates={before.templates} />);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText(/Added/)).toBeNull();
  expect(loadGeneratorTemplateSettings()).toEqual(before);
  vi.mocked(invoke).mockResolvedValue("bad JSON");
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("This .slop file is not valid JSON.");
  expect(loadGeneratorTemplateSettings()).toEqual(before);
  vi.mocked(invoke).mockRejectedValue(new Error("File unreadable"));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText("File unreadable");
});

it("keeps concurrent edits when a native import completes and prevents duplicate dialogs", async () => {
  let resolve: (value: string) => void = () => undefined;
  vi.mocked(invoke).mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<GeneratorSharing templates={loadGeneratorTemplateSettings().templates} />);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(invoke).toHaveBeenCalledTimes(1);
  const latest = loadGeneratorTemplateSettings();
  const edited = { ...latest.templates[0], name: "Changed while dialog open" };
  saveGeneratorTemplateSettings({ ...latest, templates: [edited, ...latest.templates.slice(1)] });
  await act(async () => resolve(serializeGeneratorSlop([minimaxOriginalTemplate()])));
  await screen.findByText("Added 1 generator template.");
  expect(loadGeneratorTemplateSettings().templates[0].name).toBe(edited.name);
});

it("keeps the export selection after save cancellation and reports write failures", async () => {
  render(<GeneratorSharing templates={[minimaxOriginalTemplate()]} />);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const dialog = within(screen.getByRole("dialog"));
  vi.mocked(invoke).mockResolvedValue(false);
  fireEvent.click(dialog.getByRole("button", { name: "Export" }));
  await waitFor(() => expect((dialog.getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByText(/Exported/)).toBeNull();
  vi.mocked(invoke).mockRejectedValue(new Error("Disk full"));
  fireEvent.click(dialog.getByRole("button", { name: "Export" }));
  await screen.findByText("Disk full");
});

it("accepts browser-selected .slop files", async () => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  render(<GeneratorSharing templates={loadGeneratorTemplateSettings().templates} />);
  const file = new File([""], "shared.slop", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => serializeGeneratorSlop([minimaxOriginalTemplate()]) });
  fireEvent.change(screen.getByLabelText("Import .slop file"), { target: { files: [file] } });
  await screen.findByText("Added 1 generator template.");
  expect(invoke).not.toHaveBeenCalled();
});
