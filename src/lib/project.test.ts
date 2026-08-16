import { describe, expect, it } from "vitest";
import { createProjectConfig, parseProjectConfig, projectNameFromPrompt } from "./project";

describe("project schema", () => {
  it("creates a versioned, validated project", () => {
    const project = createProjectConfig({
      name: "Launch film",
      prompt: "A tactile product launch",
      aspectRatio: "16:9",
      resolution: "4k",
      targetDurationSeconds: 45,
    });
    expect(parseProjectConfig(project)).toEqual(project);
    expect(project.schemaVersion).toBe(1);
    expect(project.timeline.tracks).toEqual([]);
  });

  it("rejects unknown schema versions", () => {
    expect(() => parseProjectConfig({ schemaVersion: 99 })).toThrow();
  });

  it("derives a compact working title", () => {
    expect(projectNameFromPrompt("Create a cinematic film about a midnight train through Europe")).toBe(
      "Cinematic film about a midnight train through",
    );
  });
});
