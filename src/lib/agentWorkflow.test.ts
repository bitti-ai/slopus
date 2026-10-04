import { beforeEach, expect, it, vi } from "vitest";
import { createProjectConfig, type ProjectRecord } from "./project";
import { runAgentTurn, type AgentTurnResponse, type AgentTurnResult } from "./runtime";
import { runAgentWorkflow } from "./agentWorkflow";
import type { GenerationObservation } from "./agentGeneration";

vi.mock("./runtime", () => ({ runAgentTurn: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const project = (): ProjectRecord => ({ folderPath: "D:/Project", config: createProjectConfig({ name: "Original", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 10 }) });
const command = { op: "scene.generate" as const, scene: "job-initial-brief", template: "chosen" };
const response = (result: AgentTurnResult): AgentTurnResponse => ({ result, events: [], messages: [] });
const generate = response({ kind: "generation", summary: "Generate this scene", command });
const answer = response({ kind: "answer", content: "Reviewed the finished scene." });
const outcome: GenerationObservation = { scene: command.scene, template: command.template, status: "completed", workId: "work-one", detail: "Video saved" };

it("waits for the exact generation result, then resumes with fresh edits and clean chat", async () => {
  const record = project();
  let current = structuredClone(record);
  let finish!: (result: GenerationObservation) => void;
  const host = { getRecord: () => current, generate: vi.fn(() => new Promise<GenerationObservation>((resolve) => { finish = resolve; })) };
  vi.mocked(runAgentTurn).mockResolvedValueOnce(generate).mockResolvedValueOnce(answer);
  const pending = runAgentWorkflow(record, "codex", "Generate and review", "turn", [], new AbortController().signal, host);
  await vi.waitFor(() => expect(host.generate).toHaveBeenCalledOnce());
  expect(runAgentTurn).toHaveBeenCalledOnce();
  current = { ...current, config: { ...current.config, name: "User renamed while rendering", assets: [{ id: "asset-result", name: "Rendered", kind: "generated", relativePath: "media/result.mp4", mimeType: "video/mp4", createdAt: current.config.createdAt }] } };
  finish(outcome);
  const result = await pending;
  expect(vi.mocked(runAgentTurn).mock.calls[1][0]).toMatchObject({ config: { name: "User renamed while rendering", assets: [{ id: "asset-result" }] } });
  expect(vi.mocked(runAgentTurn).mock.calls[1][2]).toContain('"status":"completed"');
  expect(result.messages.map((message) => message.content)).toEqual(["Generate and review", "Reviewed the finished scene."]);
});

it("deduplicates repeated generation commands after resuming", async () => {
  const record = project();
  const host = { getRecord: () => record, generate: vi.fn().mockResolvedValue(outcome) };
  vi.mocked(runAgentTurn).mockResolvedValueOnce(generate).mockResolvedValueOnce(generate).mockResolvedValueOnce(answer);
  await runAgentWorkflow(record, "local", "Generate", "turn", [], new AbortController().signal, host);
  expect(host.generate).toHaveBeenCalledOnce();
  expect(runAgentTurn).toHaveBeenCalledTimes(3);
});

it.each(["failed", "cancelled"] as const)("returns %s to the agent without automatically generating again", async (status) => {
  const record = project();
  const host = { getRecord: () => record, generate: vi.fn().mockResolvedValue({ ...outcome, status, error: "Stopped", needsSave: true }) };
  vi.mocked(runAgentTurn).mockResolvedValueOnce(generate).mockResolvedValueOnce(answer);
  await runAgentWorkflow(record, "local", "Generate", "turn", [], new AbortController().signal, host);
  expect(vi.mocked(runAgentTurn).mock.calls[1][2]).toContain(`"status":"${status}"`);
  expect(vi.mocked(runAgentTurn).mock.calls[1][2]).toContain('"needsSave":true');
  expect(host.generate).toHaveBeenCalledOnce();
});

it("reports startup rejection and does not retry that command", async () => {
  const record = project();
  const host = { getRecord: () => record, generate: vi.fn().mockRejectedValue(new Error("Template was removed")) };
  vi.mocked(runAgentTurn).mockResolvedValueOnce(generate).mockResolvedValueOnce(generate).mockResolvedValueOnce(answer);
  await runAgentWorkflow(record, "local", "Generate", "turn", [], new AbortController().signal, host);
  expect(vi.mocked(runAgentTurn).mock.calls[1][2]).toContain("Template was removed");
  expect(host.generate).toHaveBeenCalledOnce();
});

it("does not resume after the user stops while generation is running", async () => {
  const record = project();
  const controller = new AbortController();
  const host = { getRecord: () => record, generate: vi.fn(async () => { controller.abort(new Error("Stopped")); return outcome; }) };
  vi.mocked(runAgentTurn).mockResolvedValue(generate);
  await expect(runAgentWorkflow(record, "local", "Generate", "turn", [], controller.signal, host)).rejects.toThrow("Stopped");
  expect(runAgentTurn).toHaveBeenCalledOnce();
});

it("does not start generation from a late response to a cancelled turn", async () => {
  const record = project();
  const controller = new AbortController();
  const host = { getRecord: () => record, generate: vi.fn() };
  vi.mocked(runAgentTurn).mockImplementation(async () => { controller.abort(new Error("Stopped")); return generate; });
  await expect(runAgentWorkflow(record, "local", "Generate", "turn", [], controller.signal, host)).rejects.toThrow("Stopped");
  expect(host.generate).not.toHaveBeenCalled();
});

it("bounds a provider that keeps requesting generation", async () => {
  const record = project();
  const host = { getRecord: () => record, generate: vi.fn().mockResolvedValue(outcome) };
  vi.mocked(runAgentTurn).mockResolvedValue(generate);
  await expect(runAgentWorkflow(record, "local", "Generate", "turn", [], new AbortController().signal, host)).rejects.toThrow("8 generation requests");
  expect(host.generate).toHaveBeenCalledOnce();
  expect(runAgentTurn).toHaveBeenCalledTimes(9);
});
