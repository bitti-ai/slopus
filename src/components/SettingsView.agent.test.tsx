// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { runAgentTurn, type ProviderStatus } from "../lib/runtime";
import { loadGeneratorTemplateSettings } from "../lib/settings";
import type { GeneratorContext } from "../lib/agentGenerators";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/runtime", async (original) => ({
  ...await original<typeof import("../lib/runtime")>(),
  runAgentTurn: vi.fn(),
  cancelAgentTurn: vi.fn().mockResolvedValue(true),
}));

const providers: ProviderStatus[] = [{ id: "codex", label: "Codex", state: "ready", executable: "codex", version: "test", detail: "Ready" }];
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);

it("opens a resizable settings agent from the title bar and preserves its draft when hidden", async () => {
  const onClose = vi.fn();
  render(<SettingsView onClose={onClose} providers={providers} />);
  const toggle = screen.getByRole("button", { name: "Agent" });
  expect(toggle.closest(".titlebar")).toBeInTheDocument();
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  const pane = screen.getByRole("complementary", { name: "Agent" });
  const field = within(pane).getByRole("textbox", { name: "Ask Slop about settings" });
  await waitFor(() => expect(field).toHaveFocus());
  expect(screen.getByRole("separator", { name: "Resize agent pane" })).toHaveAttribute("aria-controls", pane.id);
  fireEvent.change(field, { target: { value: "Find my weights" } });
  fireEvent.click(within(pane).getByRole("button", { name: "Close agent" }));
  expect(pane).not.toBeVisible();
  expect(toggle).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("main", { name: "Settings" }), { key: "A", ctrlKey: true, shiftKey: true });
  expect(pane).toBeVisible();
  expect(field).toHaveValue("Find my weights");
  expect(onClose).not.toHaveBeenCalled();
});

it("applies generator changes from settings without opening or saving a project", async () => {
  let complete!: (value: Awaited<ReturnType<typeof runAgentTurn>>) => void;
  vi.mocked(runAgentTurn).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  vi.mocked(invoke).mockImplementation(async (name, args) => {
    if (name !== "prepare_generator_commands") throw new Error(`Unexpected command ${name}`);
    const { context } = args as { context: GeneratorContext };
    return { ...context, settings: { ...context.settings, templates: context.settings.templates.map((template) => template.id === "default"
      ? { ...template, name: "Local weights", paths: { ...template.paths, transformer: "D:/weights/model.safetensors" } } : template) } } as never;
  });
  render(<SettingsView onClose={vi.fn()} providers={providers} />);
  fireEvent.click(screen.getByRole("button", { name: "Agent" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Ask Slop about settings" }), { target: { value: "Use my local model weights" } });
  fireEvent.click(screen.getByRole("button", { name: "Send to Slop" }));
  expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-busy", "true");
  const call = vi.mocked(runAgentTurn).mock.calls[0];
  expect(call[0].folderPath).toBe("");
  expect(call[0].config.generationJobs).toEqual([]);
  expect(call[6]).toBe("settings");
  await act(async () => complete({ result: { kind: "generatorCommands", summary: "Updated weights", commands: [
    { op: "generator.set", id: "default", settings: { name: "Local weights", paths: { transformer: "D:/weights/model.safetensors" } } },
  ] }, events: [], messages: [] }));
  expect(await screen.findByRole("button", { name: "Edit Local weights generator" })).toBeInTheDocument();
  expect(loadGeneratorTemplateSettings().templates.find((template) => template.id === "default")?.paths.transformer).toBe("D:/weights/model.safetensors");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-busy", "false");
});
