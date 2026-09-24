import { describe, expect, it } from "vitest";
import { compileImagePrompt } from "./imagePrompt";
import { addImageNode, imageScenePrompt } from "./imageScene";
import { createProjectConfig, parseProjectConfig } from "./project";
import fixture from "../../fixtures/project-v1-image.json";

const photo = () => createProjectConfig({ name: "Portrait", generationType: "image", prompt: "A runner suspended mid-stride", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 });
describe("MiniMax H3 still-image prompts", () => {
  it("places photo style before a single visual composition without video scaffolding", () => {
    const config = photo();
    config.settings.defaultLook = "watercolor";
    config.imageScene!.style = { mode: "photo", aesthetics: "editorial, high contrast", lighting: "golden hour", medium: "Ignored art medium", detail: "85mm, f/1.4" };
    const snapshot = structuredClone(config);
    expect(compileImagePrompt(config).prompt).toBe([
      "Create one still image with a single composition.",
      "Medium: Photograph.",
      "Visual style: Watercolor.",
      "Aesthetics: editorial, high contrast.",
      "Lighting: golden hour.",
      "Camera and lens: 85mm, f/1.4.",
      "", "A runner suspended mid-stride.",
    ].join("\n"));
    expect(compileImagePrompt(config).prompt).not.toMatch(/\[Shot|overall_soundscape|non_diegetic_music|integrated_multimodal_description|00:|root:|Ignored art medium/);
    expect(config).toEqual(snapshot);
  });

  it("preserves nested composition, placement and palettes even for undescribed groups", () => {
    const config = parseProjectConfig(fixture);
    config.imageScene!.nodes[1].description = "";
    const prompt = compileImagePrompt(config).prompt;
    expect(prompt).toContain("Medium: Illustration.");
    expect(prompt).toContain("Art style: Screen print.");
    expect(prompt).toContain("Overall color palette: #204060.");
    expect(prompt).toContain("Background: Ocean at dawn.");
    expect(prompt).toContain("A grouped arrangement. Position in the full image: left 30%, top 10%, width 40%, height 80%. Its composition includes:\n  Visible lettering. Bold red lettering.");
    expect(prompt).toContain('Render the exact text "LIFT OFF". Position in the full image: left 35%, top 15%, width 30%, height 10%. Color palette: #FF0000.');
    expect(prompt).not.toMatch(/group:|text:|group-rocket|Camera and lens/);
  });

  it("keeps exact lettering and authored content rather than escaping or stripping it", () => {
    const config = photo();
    const scene = addImageNode(config.imageScene!, "image-root", "text");
    const text = '营业中\nSay "hello" — C:\\Art';
    scene.nodes.at(-1)!.text = text;
    scene.nodes.at(-1)!.description = "Hand-lettered sign";
    expect(imageScenePrompt(scene)).toContain(`Render the exact text "${text}".`);
    expect(imageScenePrompt(scene)).not.toContain("\\n");
  });

  it("numbers pictures in selected payload order and treats text references as visual guidance", () => {
    const config = photo();
    config.references = [
      { id: "runner", kind: "image", name: "Runner", description: "Red jersey", relativePath: "references/runner.png", images: [{ id: "detail", name: "Detail", relativePath: "references/detail.png", sourcePath: null }], intendedUse: [], createdAt: config.createdAt },
      { id: "palette", kind: "text", name: "Palette", description: "", content: "Warm ochre and red", intendedUse: [], createdAt: config.createdAt },
      { id: "track", kind: "image", name: "Track", description: "A gravel track", relativePath: "references/track.png", intendedUse: [], createdAt: config.createdAt },
      { id: "unused", kind: "text", name: "Unused", description: "Exclude these words", intendedUse: [], createdAt: config.createdAt },
    ];
    config.imageScene!.referenceIds = ["track", "palette", "runner"];
    const result = compileImagePrompt(config);
    expect(result.references.map((reference) => reference.id)).toEqual(["track", "palette", "runner"]);
    expect(result.prompt).toContain([
      "Visual references for this still image:",
      "Use <Picture 1> as visual guidance for Track. A gravel track.",
      "Additional visual guidance: Warm ochre and red.",
      "Use <Picture 2>, <Picture 3> as visual guidance for Runner. Red jersey.",
    ].join("\n"));
    expect(result.prompt).not.toMatch(/Exclude these words|<Video|<Audio|first frame|last frame/);
    config.imageScene!.referenceIds = ["missing"];
    expect(() => compileImagePrompt(config)).toThrow("no longer exists");
  });

  it("uses the brief for legacy image documents and leaves genuinely empty prompts empty", () => {
    const config = photo();
    config.imageScene = null;
    expect(compileImagePrompt(config).prompt).toContain("A runner suspended mid-stride.");
    config.brief.prompt = "";
    expect(compileImagePrompt(config).prompt).toBe("");
  });
  it("describes an active refmod as visual identity conditioning, with no invented picture label", () => {
    const config = photo();
    config.references = [{ id: "identity", kind: "text", name: "Woman", description: "", intendedUse: ["character"], createdAt: config.createdAt,
      refmods: [{ id: "encoded", name: "Identity", sourcePath: "D:/identity.safetensors", strength: 1, copies: 1 }] }];
    config.imageScene!.referenceIds = ["identity"];
    const prompt = compileImagePrompt(config).prompt;
    expect(prompt).toContain("Use the supplied reference conditioning for Woman's identity and appearance in this still image");
    expect(prompt).not.toMatch(/Additional visual guidance: Woman|<Picture|<Video|safetensors/);
    config.references[0].refmods![0].strength = 0;
    expect(compileImagePrompt(config).prompt).not.toContain("Woman");
  });
});
