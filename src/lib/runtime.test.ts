// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { createProjectConfig } from "./project";
import { getRuntimeStatus, resolveVidfabPlan, runAgentTurn } from "./runtime";

const project = () => ({
  folderPath: "~/PolStudio/runtime-test",
  config: createProjectConfig({
    name: "Runtime test",
    prompt: "A quiet architectural film",
    aspectRatio: "16:9",
    resolution: "1080p",
    targetDurationSeconds: 30,
  }),
});

describe("deterministic browser runtime", () => {
  beforeEach(() => localStorage.clear());

  it("reports explicit demo status and a plan-only generation boundary", async () => {
    const record = project();
    const status = await getRuntimeStatus();
    expect(status.vidfab.state).toBe("demo");
    const plan = await resolveVidfabPlan({
      jobId: "job-plan", prompt: "three field prompt", frames: 180, steps: 50,
      seed: 1, aspectRatio: "16:9", referencePaths: [],
    }, record.config);
    expect(plan.alignedFrames).toBe(192);
    expect(plan.boundary).toContain("No weights");
  });

  it("persists a provider-neutral mutation and both conversation turns", async () => {
    const response = await runAgentTurn(project(), "codex", "Add a cinematic shot to the queue", "turn-1");
    expect(response.result.kind).toBe("mutation");
    expect(response.record.config.generationJobs[0].status).toBe("draft");
    expect(response.record.config.agentConversation.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(response.record.config.generationJobs[0].compiledPrompt).toContain("overall_soundscape:");
  });
});
