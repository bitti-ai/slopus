// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { executeGeneratorCommands, generatorContext, type GeneratorContext, type GeneratorCommand } from "./agentGenerators";
import { createGeneratorTemplate, loadGeneratorTemplateSettings, saveGeneratorTemplateSettings } from "./settings";
import { loadLoras } from "./loras";
import { executeAgentCommands, runAgentTurn } from "./runtime";
import { createProjectConfig } from "./project";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
const commands: GeneratorCommand[] = [{ op: "generator.add", id: "agent-template", settings: { name: "Agent template" } }];
const withTemplate = (context: GeneratorContext): GeneratorContext => ({ ...context, settings: {
  ...context.settings, templates: [...context.settings.templates, { ...createGeneratorTemplate(), id: "agent-template", name: "Agent template" }],
} });

it("applies generator edits to machine settings without changing the project", async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) => withTemplate((args as { context: GeneratorContext }).context));
  const config = createProjectConfig({ name: "Untouched", prompt: "", aspectRatio: "16:9", resolution: "544p", targetDurationSeconds: 15 });
  const original = structuredClone(config);
  expect(await executeAgentCommands(config, commands)).toBe(config);
  expect(config).toEqual(original);
  expect(loadGeneratorTemplateSettings().templates.at(-1)?.id).toBe("agent-template");
  expect(invoke).toHaveBeenCalledWith("prepare_generator_commands", expect.objectContaining({ commands }));
});

it("rebases onto edits made during native validation", async () => {
  let calls = 0;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const context = (args as { context: GeneratorContext }).context;
    if (calls++ === 0) {
      saveGeneratorTemplateSettings({ ...context.settings, templates: context.settings.templates.map((t, i) => i === 0 ? { ...t, name: "Concurrent change" } : t) });
    }
    return withTemplate(context);
  });
  await executeGeneratorCommands(commands);
  expect(calls).toBe(2);
  expect(loadGeneratorTemplateSettings().templates[0].name).toBe("Concurrent change");
  expect(loadGeneratorTemplateSettings().templates.at(-1)?.id).toBe("agent-template");
});

it("does not save failed validation and rolls back LoRAs if settings persistence fails", async () => {
  const before = generatorContext();
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Wrong weight role"));
  await expect(executeGeneratorCommands(commands)).rejects.toThrow("Wrong weight role");
  expect(generatorContext()).toEqual(before);
  vi.mocked(invoke).mockResolvedValueOnce({ ...withTemplate(before), loras: [...before.loras, { id: "new", name: "New", path: "C:/adapter.safetensors", needsPreparation: true }] });
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key.includes("generator-templates")) throw new Error("Storage full");
    setItem.call(this, key, value);
  });
  await expect(executeGeneratorCommands(commands)).rejects.toThrow("Storage full");
  expect(loadLoras()).toEqual(before.loras);
  expect(loadGeneratorTemplateSettings()).toEqual(before.settings);
});

it("sends a separate generator snapshot and records generator summaries in chat", async () => {
  const config = createProjectConfig({ name: "Snapshot", prompt: "", aspectRatio: "16:9", resolution: "544p", targetDurationSeconds: 15 });
  vi.mocked(invoke).mockResolvedValueOnce({ result: { kind: "generatorCommands", summary: "Added generator", commands }, events: [] });
  const result = await runAgentTurn({ folderPath: "C:/Project", config }, "local", "Set up my weights", "turn");
  const request = (vi.mocked(invoke).mock.calls[0][1] as { request: Record<string, unknown> }).request;
  expect(request.generators).toEqual(generatorContext());
  expect(request.config).not.toHaveProperty("generators");
  expect(result.messages.at(-1)?.content).toBe("Added generator");
});

it("rejects mixed project and generator batches before any mutation", async () => {
  const config = createProjectConfig({ name: "Mixed", prompt: "", aspectRatio: "16:9", resolution: "544p", targetDurationSeconds: 15 });
  await expect(executeAgentCommands(config, [...commands, { op: "project.set", name: "Wrong" }])).rejects.toThrow("separate");
  expect(invoke).not.toHaveBeenCalled();
});
