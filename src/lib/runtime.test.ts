// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { compileGenerationJobPrompt, createProjectConfig } from "./project";
import { executeAgentCommands, getRuntimeStatus, resolveVidfabPlan, runAgentTurn } from "./runtime";

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
      seed: 1, canvasWidth: 1920, canvasHeight: 1088, referencePaths: [],
    }, record.config);
    expect(plan.alignedFrames).toBe(192);
    expect(plan.canvasWidth).toBe(1920);
    expect(plan.canvasHeight).toBe(1088);
    expect(plan.durationSeconds).toBe(8);
    expect(plan.boundary).toContain("No weights");
  });

  it("plans and executes provider-neutral commands while conversation stays in memory", async () => {
    const record = project();
    const response = await runAgentTurn(record, "codex", "Add a cinematic shot to the queue", "turn-1");
    expect(response.result.kind).toBe("commands");
    if (response.result.kind !== "commands") throw new Error("Expected commands");
    const latest = { ...record.config, name: "Edited while the provider was thinking" };
    const config = await executeAgentCommands(latest, response.result.commands);
    expect(config.name).toBe("Edited while the provider was thinking");
    const addedJob = config.generationJobs.at(-1)!;
    expect(addedJob.status).toBe("draft");
    const placed = config.timeline.tracks[0].clips[0];
    expect(placed).toMatchObject({
      id: `clip-${addedJob.id}`,
      assetId: `asset-${addedJob.id}`,
      startMs: 0,
      durationMs: 6_000,
      status: "draft",
    });
    expect(response.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(config).not.toHaveProperty("agentConversation");
    expect(config.generationJobs[0]).not.toHaveProperty("compiledPrompt");
    expect(compileGenerationJobPrompt(addedJob)).toContain("overall_soundscape:");

    const followUp = await runAgentTurn({ ...record, config }, "codex", "Make it warmer", "turn-2", response.messages);
    expect(followUp.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(config).not.toHaveProperty("agentConversation");
  });

  it("appends ordinary clips and allows explicit timeline arrangements", async () => {
    const config = createProjectConfig({
      name: "Timeline commands", prompt: "", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30,
    });
    config.assets.push({
      id: "asset-rush", kind: "video", name: "Rush", relativePath: "media/rush.mp4", mimeType: "video/mp4",
      durationMs: 12_000, width: 1920, height: 1080, createdAt: config.createdAt,
    });
    const arranged = await executeAgentCommands(config, [
      { op: "clip.add", id: "clip-a", asset: "asset-rush", seconds: 4 },
      { op: "clip.add", id: "clip-b", asset: "asset-rush", sourceAt: 4, seconds: 4 },
      { op: "clip.set", id: "clip-b", track: "track-v2", at: 1 },
    ]);
    expect(arranged.timeline.tracks[0].clips[0]).toMatchObject({ id: "clip-a", startMs: 0, durationMs: 4_000 });
    expect(arranged.timeline.tracks[1].clips[0]).toMatchObject({ id: "clip-b", startMs: 1_000, sourceStartMs: 4_000 });

    const removed = await executeAgentCommands(arranged, [{ op: "clip.remove", id: "clip-b" }]);
    expect(removed.timeline.tracks.flatMap((track) => track.clips).map((clip) => clip.id)).toEqual(["clip-a"]);
  });
});
