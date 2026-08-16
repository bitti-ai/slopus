import { describe, expect, it } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import {
  createProjectConfig,
  normalizeProjectPath,
  parseProjectConfig,
  projectNameFromPrompt,
  seedProjectWorkspace,
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
    expect(project.timeline.tracks.map((track) => track.name)).toEqual(["Story", "Voice-over", "Music"]);
    expect(project.timeline.tracks.every((track) => track.clips.length === 0)).toBe(true);
    expect(project.references).toEqual([]);
    expect(project.generationJobs).toHaveLength(1);
    expect(project.generationJobs[0].creativeBrief).toBe("A tactile product launch");
    expect(project.generationJobs[0].status).toBe("draft");
    expect(project.agentConversation).toEqual({ messages: [] });
    expect(project.providerSettings).toEqual({});
  });

  it("compiles the initial brief into exactly the three MiniMax H3 core fields", () => {
    const project = createProjectConfig({
      name: "Launch film",
      prompt: "A tactile product launch with rain and close macro camera moves",
      aspectRatio: "16:9",
      resolution: "1080p",
      targetDurationSeconds: 30,
    });
    const job = project.generationJobs[0];
    expect(job.creativeBrief).toBe(project.brief.prompt);
    expect(job.compiledPrompt.match(/^[a-z_]+:/gm)).toEqual([
      "integrated_multimodal_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ]);
    expect(job.compiledPrompt).toContain(project.brief.prompt);
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

  it("seeds a portable, screenshot-ready editing workspace", () => {
    const project = seedProjectWorkspace(createProjectConfig({
      name: "Northern Light",
      prompt: "A brand film about humane architecture",
      aspectRatio: "16:9",
      resolution: "4k",
      targetDurationSeconds: 34,
    }));
    expect(project.timeline.tracks).toHaveLength(4);
    expect(project.generationJobs.some((job) => job.status === "generating")).toBe(true);
    expect(project.references.some((reference) => reference.kind === "image")).toBe(true);
    expect(project.assets.every((asset) => !asset.relativePath.match(/^([a-z]:|[/\\])/i))).toBe(true);
    expect(project.generationJobs.filter((job) => job.outputRelativePath).every((job) => !job.outputRelativePath!.match(/^([a-z]:|[/\\])/i))).toBe(true);
  });
});
