import { describe, expect, it } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import {
  createProjectConfig,
  normalizeProjectPath,
  parseProjectConfig,
  projectNameFromPrompt,
} from "./project";

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
    expect(project.references).toEqual([]);
    expect(project.generationJobs).toEqual([]);
    expect(project.agentConversation).toEqual({ messages: [] });
    expect(project.providerSettings).toEqual({});
  });

  it("parses the complete cross-layer fixture without losing data", () => {
    expect(parseProjectConfig(completeFixture)).toEqual(completeFixture);
  });

  it("normalizes portable paths to project-root relative forward slashes", () => {
    expect(normalizeProjectPath("./media\\imported//clip.mp4")).toBe("media/imported/clip.mp4");
    const config = structuredClone(completeFixture);
    config.assets[0].relativePath = "media\\imported\\macro.mp4";
    expect(parseProjectConfig(config).assets[0].relativePath).toBe("media/imported/macro.mp4");
  });

  it.each([
    "/etc/passwd",
    "\\Windows\\system.ini",
    "C:\\Users\\creator\\clip.mp4",
    "https://example.com/clip.mp4",
    "media/../../outside.mp4",
    "references/../outside.png",
  ])("rejects escaping stored path %s", (relativePath) => {
    const config = structuredClone(completeFixture);
    config.assets[0].relativePath = relativePath;
    expect(() => parseProjectConfig(config)).toThrow();
  });

  it("applies path containment to every stored path field", () => {
    const thumbnail = structuredClone(completeFixture);
    thumbnail.thumbnail = "../thumbnail.webp";
    const reference = structuredClone(completeFixture);
    reference.references[1].relativePath = "../product.png";
    const job = structuredClone(completeFixture);
    job.generationJobs[0].outputRelativePath = "C:\\output.mp4";
    for (const config of [thumbnail, reference, job]) {
      expect(() => parseProjectConfig(config)).toThrow();
    }
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
