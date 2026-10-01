import { describe, expect, it } from "vitest";
import { compileImagePrompt } from "./imagePrompt";
import { addImageNode, imageScenePrompt } from "./imageScene";
import { createProjectConfig, parseProjectConfig } from "./project";
import fixture from "../../fixtures/project-v1-image.json";

const photo = () => createProjectConfig({ name: "Portrait", generationType: "image", prompt: "A runner suspended mid-stride", aspectRatio: "1:1", resolution: "768p", targetDurationSeconds: 60 });
describe("MiniMax H3 still-image prompts", () => {
  it("uses H3's three core fields with style inside the first shot and silent audio", () => {
    const config = photo();
    config.settings.defaultLook = "watercolor";
    config.imageScene!.style = { mode: "photo", aesthetics: "editorial, high contrast", lighting: "golden hour", medium: "Ignored art medium", detail: "85mm, f/1.4" };
    const snapshot = structuredClone(config);
    expect(compileImagePrompt(config).prompt).toBe([
      "integrated_multimodal_description: [Shot 1] A still photograph with Watercolor visual style, editorial, high contrast aesthetics, golden hour lighting, 85mm, f/1.4 camera and lens characteristics.",
      "A runner suspended mid-stride.",
      "", "overall_soundscape: N/A",
      "", "non_diegetic_music: N/A",
    ].join("\n"));
    expect(compileImagePrompt(config).prompt).not.toMatch(/\[Shot 2|00:|root:|Ignored art medium|Medium:|Aesthetics:|Camera and lens:/);
    expect(config).toEqual(snapshot);
  });

  it("preserves nested composition while omitting placement and palettes", () => {
    const config = parseProjectConfig(fixture);
    config.imageScene!.nodes[1].description = "";
    const prompt = compileImagePrompt(config).prompt;
    expect(prompt).toContain("integrated_multimodal_description: [Shot 1] A still image in Illustration");
    expect(prompt).toContain("Screen print art style.");
    expect(prompt).not.toMatch(/palette|#204060|#FF0000|Position in|\[300, 100, 700, 900\]|\[350, 150, 650, 250\]/);
    expect(prompt).toContain("Background: Ocean at dawn.");
    expect(prompt).toContain("A grouped arrangement. Its composition includes:\n  Visible lettering. Bold red lettering.");
    expect(prompt).toContain('Render the exact text "LIFT OFF".');
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

  it("uses all six reference sections with stable subjects and pictures in payload order", () => {
    const config = photo();
    config.references = [
      { id: "runner", kind: "image", name: "Runner", description: "Red jersey", relativePath: "references/runner.png", images: [{ id: "detail", name: "Detail", relativePath: "references/detail.png", sourcePath: null }], intendedUse: [], createdAt: config.createdAt },
      { id: "palette", kind: "text", name: "Palette", description: "", content: "Warm ochre and red", intendedUse: [], createdAt: config.createdAt },
      { id: "track", kind: "image", name: "Track", description: "A gravel track", relativePath: "references/track.png", intendedUse: [], createdAt: config.createdAt },
      { id: "unused", kind: "text", name: "Unused", description: "Exclude these words", intendedUse: [], createdAt: config.createdAt },
    ];
    // Only citations choose references, in the order they are first cited.
    config.imageScene!.nodes[0].description = "On @[ref:track] in @[ref:palette] tones, @[ref:runner] is suspended mid-stride";
    const result = compileImagePrompt(config);
    expect(result.references.map((reference) => reference.id)).toEqual(["track", "palette", "runner"]);
    expect(result.prompt.match(/^\w+:/gm)).toEqual(["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]);
    expect(result.prompt).toContain("<Subject 1> is Track, providing appearance from <Picture 1>. A gravel track.");
    expect(result.prompt).toContain("<Subject 2> is Palette, providing appearance. Warm ochre and red.");
    expect(result.prompt).toContain("<Subject 3> is Runner, providing appearance from <Picture 2> and <Picture 3>. Red jersey.");
    expect(result.prompt).toContain("summary:\n[reference generation] A single still image uses <Subject 1>, <Subject 2>, <Subject 3>");
    expect(result.prompt).toContain("detailed_description:\nA still photograph.\n[Shot 1] On <Subject 1> in <Subject 2> tones, <Subject 3> is suspended mid-stride.");
    for (let index = 1; index <= 3; index++) {
      expect(result.prompt).toContain(`<Subject ${index}> (appears in [Shot 1]): fully_preserved`);
      expect(result.prompt.split("detailed_description:")[1]).toContain(`Use <Subject ${index}>`);
    }
    expect(result.prompt).toMatch(/overall_soundscape: N\/A\n\nnon_diegetic_music: N\/A$/);
    expect(result.prompt).not.toContain("integrated_multimodal_description");
    expect(result.prompt).not.toMatch(/Exclude these words|<Video|<Audio|first frame|last frame/);
    config.imageScene!.nodes[0].description = "@[ref:missing] runs";
    expect(() => compileImagePrompt(config)).toThrow("The prompt cites a reference that no longer exists.");
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
    config.imageScene!.nodes[0].description = "@[ref:identity] suspended mid-stride";
    const prompt = compileImagePrompt(config).prompt;
    expect(prompt).toContain("<Subject 1> is Woman, providing identity and appearance from the supplied reference conditioning.");
    expect(prompt).toContain("Use <Subject 1> for Woman's identity and appearance from the supplied reference conditioning.");
    expect(prompt).not.toMatch(/Additional visual guidance: Woman|<Picture|<Video|safetensors/);
    config.references[0].refmods![0].strength = 0;
    // With nothing to condition on, the mention reads as the plain name.
    expect(compileImagePrompt(config).prompt).not.toMatch(/<Subject|@\[ref:/);
    expect(compileImagePrompt(config).prompt).toContain("Woman suspended mid-stride.");
    expect(compileImagePrompt(config).prompt).toMatch(/^integrated_multimodal_description: \[Shot 1\]/);
  });
  it("keeps picture numbering independent of refmod and text subjects", () => {
    const config = photo();
    config.references = [
      { id: "disabled", kind: "text", name: "Disabled", description: "", intendedUse: [], createdAt: config.createdAt, refmods: [{ id: "off", name: "Off", sourcePath: "D:/off.safetensors", strength: 0, copies: 1 }] },
      { id: "style", kind: "text", name: "Style", description: "", intendedUse: ["style"], createdAt: config.createdAt, refmods: [{ id: "style-mod", name: "Style", sourcePath: "D:/style.safetensors", strength: 1, copies: 1 }] },
      { id: "runner", kind: "image", name: "Runner", description: "Red jersey", relativePath: "references/runner.png", intendedUse: ["character"], createdAt: config.createdAt },
    ];
    config.imageScene!.nodes[0].description = "@[ref:disabled] and a @[ref:style] frame around @[ref:runner]";
    const prompt = compileImagePrompt(config).prompt;
    expect(prompt).toContain("<Subject 1> is Style, providing visual style from the supplied reference conditioning.");
    expect(prompt).toContain("<Subject 2> is Runner, providing identity and appearance from <Picture 1>.");
    expect(prompt).not.toMatch(/Disabled,|is Disabled|<Subject 3>|<Picture 2>|<Video/);
  });
  it("passes only the references the prompt cites, from any node or the background", () => {
    const config = photo();
    config.references = [
      { id: "hero", kind: "image", name: "Hero", description: "", relativePath: "references/hero.png", intendedUse: ["character"], createdAt: config.createdAt },
      { id: "sky", kind: "text", name: "Sky", description: "", content: "Violet dusk", intendedUse: [], createdAt: config.createdAt },
      { id: "clip", kind: "video", name: "Clip", description: "", relativePath: "references/clip.mp4", intendedUse: [], createdAt: config.createdAt },
    ];
    config.imageScene!.referenceIds = ["sky"];
    expect(compileImagePrompt(config).references).toEqual([]);
    const scene = addImageNode(config.imageScene!, "image-root", "object");
    scene.nodes.at(-1)!.description = "@[ref:hero] waving";
    config.imageScene = { ...scene, background: "A @[ref:sky] over the hills" };
    expect(compileImagePrompt(config).references.map((reference) => reference.id)).toEqual(["hero", "sky"]);
    config.imageScene.background = "@[ref:clip]";
    expect(() => compileImagePrompt(config)).toThrow("the prompt cites the video reference 'Clip'");
  });
});
