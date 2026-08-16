import { describe, expect, it } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import {
  compileMiniMaxH3Prompt,
  createProjectConfig,
  deriveH3Style,
  isReferenceUsable,
  normalizeProjectPath,
  parseProjectConfig,
  projectFilePath,
  projectNameFromPrompt,
  projectReferenceSchema,
  seedProjectWorkspace,
  usableImageReferences,
  type ProjectReference,
} from "./project";

/** Body of one compiled section, for both prompt shapes: T2VA writes
 *  `name: value` on one line, full-reference mode writes `name:\nvalue`, and in
 *  both cases sections are separated by a blank line. */
const section = (compiled: string, name: string): string =>
  // No "m" flag on purpose: detailed_description spans two lines, and a
  // multiline `$` would end the capture at the first line break.
  compiled.match(new RegExp(`(?:^|\\n\\n)${name}:[ \\n]([\\s\\S]*?)(?=\\n\\n|$)`))?.[1] ?? "";

const now = "2026-01-01T00:00:00.000Z";
const textReference = (over: Partial<ProjectReference> = {}): ProjectReference => projectReferenceSchema.parse({
  id: "ref-1", kind: "text", name: "Mara", description: "Calm architect in charcoal wool.",
  intendedUse: ["character"], createdAt: now, ...over,
});
const imageReference = (over: Partial<ProjectReference> = {}): ProjectReference => projectReferenceSchema.parse({
  id: "ref-img", kind: "image", name: "Harbor facade", description: "Pale stone fins.",
  relativePath: "references/harbor.jpg", intendedUse: ["location"], createdAt: now, ...over,
});

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
    // Base guide §4.1: [Shot 1] opens with the style, and carries no timestamp (§4.2).
    expect(job.compiledPrompt).toMatch(/integrated_multimodal_description: \[Shot 1\] Live-action, cinematic, /);
    expect(job.compiledPrompt).not.toMatch(/\[Shot 1\] At \d/);
    // §4.7: no abstract mood words or statements of emotional function.
    expect(job.compiledPrompt).toContain("non_diegetic_music: N/A");
  });

  it("selects the H3 style from the user's own words rather than inventing one", () => {
    // Base guide §4.1: "for T2VA, select it from the user's text".
    expect(deriveH3Style("A watercolour short about a heron")).toBe("Watercolor");
    expect(deriveH3Style("A 2D animated title sequence")).toBe("2D-animated");
    expect(deriveH3Style("A claymation breakfast scene")).toBe("Claymation");
    expect(deriveH3Style("A documentary about harbour pilots")).toBe("Live-action, documentary");
    expect(deriveH3Style("A quiet lighthouse at dawn")).toBe("Live-action, cinematic");
  });

  it("switches to the six-section full-reference shape when references are bound", () => {
    const reference = (over: Partial<ProjectReference>): ProjectReference => projectReferenceSchema.parse({
      id: "ref-1", kind: "text", name: "Mara", description: "Calm architect in charcoal wool.",
      intendedUse: ["character"], createdAt: new Date().toISOString(), ...over,
    });
    const image = reference({ id: "ref-2", kind: "image", name: "Harbor facade", relativePath: "references/harbor.jpg", description: "Pale stone fins." });
    const compiled = compileMiniMaxH3Prompt("A quiet lighthouse at dawn", [image, reference({})]);

    // Ref guide §1: six sections, this exact order. detailed_description
    // REPLACES integrated_multimodal_description (§5.2).
    expect(compiled.match(/^[a-z_]+:/gm)).toEqual([
      "subject_definitions:",
      "summary:",
      "retention_analysis:",
      "detailed_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ]);
    expect(compiled).not.toContain("integrated_multimodal_description");

    // §2.2: an image defining a character/scene/style is cited INSIDE its
    // <Subject N> line and never becomes a standalone <Picture N> entry.
    expect(compiled).toContain("<Subject 1> is Harbor facade, shown in <Picture 1>.");
    expect(compiled).not.toMatch(/^<Picture \d+> is /m);
    // A text reference has no asset, so it cites no picture.
    expect(compiled).toContain("<Subject 2> is Mara.");

    // §3: task-type prefix; no <Audio N> because no audio asset exists (§2.4).
    expect(compiled).toContain("summary:\n[reference generation] ");
    expect(compiled).not.toContain("<Audio");

    // §4.1: fixed relationship markers, one line per label. §5.4: no (Sx) here.
    expect(compiled).toContain("<Subject 1> (appears in [Shot 1]): fully_preserved - ");
    expect(compiled).toContain("<Subject 2> (appears in [Shot 1]): fully_preserved - ");

    // §5.2: the style opening precedes [Shot 1] in full-reference mode.
    expect(compiled).toMatch(/detailed_description:\nThe target video is in a live-action, cinematic style\.\n\[Shot 1\] /);
  });

  it("numbers <Picture N> in the order the engine consumes reference_paths", () => {
    // vidfab.rs iterates reference_paths sequentially, so index 0 is <Picture 1>.
    const img = (id: string, name: string, path: string): ProjectReference => projectReferenceSchema.parse({
      id, kind: "image", name, description: "A reference.", relativePath: path,
      intendedUse: ["style"], createdAt: new Date().toISOString(),
    });
    const first = img("a", "Alpha", "references/a.jpg");
    const second = img("b", "Beta", "references/b.jpg");
    const compiled = compileMiniMaxH3Prompt("A shot", [first, second]);
    expect(compiled).toContain("<Subject 1> is Alpha, shown in <Picture 1>.");
    expect(compiled).toContain("<Subject 2> is Beta, shown in <Picture 2>.");
    expect(usableImageReferences([first, second]).map((r) => r.relativePath)).toEqual([
      "references/a.jpg", "references/b.jpg",
    ]);
  });

  it("ignores blank references so they cannot take a binding slot", () => {
    const blank = projectReferenceSchema.parse({
      id: "blank", kind: "text", name: "New definition", description: "",
      intendedUse: ["style"], createdAt: new Date().toISOString(),
    });
    expect(isReferenceUsable(blank)).toBe(false);
    // With only a blank reference, the prompt stays in T2VA shape.
    expect(compileMiniMaxH3Prompt("A shot", [blank])).toContain("integrated_multimodal_description:");
  });

  it("terminates the brief so it cannot fuse into the sentence that follows", () => {
    const compiled = compileMiniMaxH3Prompt(
      "a cat walking across a sunny kitchen floor",
      [imageReference(), textReference()],
    );
    // summary: "... floor <Subject 1> and <Subject 2> provide ..." was one
    // fused sentence before the terminal stop was added.
    const summary = section(compiled, "summary");
    expect(summary).not.toContain("floor <Subject 1>");
    expect(summary).toContain("floor. <Subject 1>");
    // detailed_description: "... floor The shot features ..." likewise.
    const detailed = section(compiled, "detailed_description");
    expect(detailed).not.toContain("floor The shot features");
    expect(detailed).toContain("floor. The shot features");
  });

  it("never gives an already-punctuated brief a second terminal mark", () => {
    for (const [brief, tail] of [
      ["A cat naps on the sill.", "sill."],
      ["Watch the cat leap!", "leap!"],
      ["Where did the cat go?", "go?"],
      ["The cat pauses…", "pauses…"],
    ]) {
      const compiled = compileMiniMaxH3Prompt(brief, [textReference()]);
      expect(section(compiled, "summary")).toContain(`${tail} <Subject 1>`);
      expect(section(compiled, "detailed_description")).toContain(`${tail} The shot features`);
      expect(compiled).not.toContain(`${tail}.`);
    }
  });

  it("keeps the default soundscape free of any ambience the user never described", () => {
    // Base guide §4.6: N/A only on an explicit request for silence, so a line
    // must still be emitted — but it may not invent a place or a weather.
    const soundscape = section(compileMiniMaxH3Prompt("a rocket launch over the ocean"), "overall_soundscape");
    expect(soundscape.trim().length).toBeGreaterThan(0);
    expect(soundscape.trim()).not.toBe("N/A");
    for (const invented of ["room tone", "wind", "rain", "traffic", "birds", "indoor", "street"]) {
      expect(soundscape.toLowerCase()).not.toContain(invented);
    }
  });

  it("never compiles an audio-tagged reference as a visible subject", () => {
    // Ref guide §2.1: <Subject N> is VISIBLE content, so a note about sound is
    // dropped rather than announced on screen — and no <Audio N> is invented
    // for it either (§2.5).
    const audioOnly = textReference({ id: "ref-score", name: "Score idea", description: "Sparse piano.", intendedUse: ["audio"] });
    const compiled = compileMiniMaxH3Prompt("A quiet lighthouse at dawn", [audioOnly]);
    expect(compiled).not.toContain("<Subject");
    expect(compiled).not.toContain("<Audio");
    expect(compiled).not.toContain("Score idea");
    expect(compiled).not.toContain("Sparse piano");
    // With no usable visual reference left, the prompt falls back to T2VA.
    expect(compiled.match(/^[a-z_]+:/gm)).toEqual([
      "integrated_multimodal_description:",
      "overall_soundscape:",
      "non_diegetic_music:",
    ]);
  });

  it("still compiles a reference that carries a visual tag alongside audio", () => {
    const narrator = textReference({ id: "ref-narrator", name: "Narrator", description: "On-camera, warm low voice.", intendedUse: ["character", "audio"] });
    const compiled = compileMiniMaxH3Prompt("A quiet lighthouse at dawn", [narrator]);
    expect(compiled).toContain("<Subject 1> is Narrator.");
    expect(compiled).toContain("<Subject 1> (appears in [Shot 1]): fully_preserved - ");
  });

  it("drops an audio-tagged image from both the prompt and reference_paths together", () => {
    // The two filters must agree: GeneratorView builds referencePaths from
    // usableImageReferences while the prompt numbers <Picture N> from the
    // compiler's list, and vidfab.rs consumes the array positionally.
    const audioImage = imageReference({ id: "img-audio", name: "Waveform note", relativePath: "references/waveform.png", intendedUse: ["audio"] });
    const visualImage = imageReference({ id: "img-visual", name: "Harbor facade", relativePath: "references/harbor.jpg", intendedUse: ["location"] });
    const references = [audioImage, visualImage];

    expect(usableImageReferences(references).map((reference) => reference.id)).toEqual(["img-visual"]);
    const compiled = compileMiniMaxH3Prompt("A shot", references);
    expect(compiled).toContain("<Subject 1> is Harbor facade, shown in <Picture 1>.");
    expect(compiled).not.toContain("<Picture 2>");
    expect(compiled).not.toContain("<Subject 2>");
    expect(compiled).not.toContain("Waveform note");
  });

  it("keeps canonical style casing in the detailed-description opening", () => {
    // Base guide §4.1 names them "3D CG" and "2D-animated"; toLowerCase()
    // turned those into "3d cg" and "2d-animated".
    expect(deriveH3Style("A 3D CGI creature short")).toBe("3D CG");
    expect(compileMiniMaxH3Prompt("A 3D CGI creature short", [textReference()]))
      .toContain("The target video is in a 3D CG style.");
    expect(deriveH3Style("A 2D anime chase across rooftops")).toBe("2D-animated");
    expect(compileMiniMaxH3Prompt("A 2D anime chase across rooftops", [textReference()]))
      .toContain("The target video is in a 2D-animated style.");
  });

  it("resolves project-relative reference paths to absolute for the engine", () => {
    // enqueue_vidfab_generation never receives the project folder and vidfab.rs
    // uses the string verbatim, so the frontend must send an absolute path.
    expect(projectFilePath("C:\\Projects\\Lighthouse", "references/a.jpg")).toBe("C:\\Projects\\Lighthouse\\references\\a.jpg");
    expect(projectFilePath("/home/nn/lighthouse", "references/a.jpg")).toBe("/home/nn/lighthouse/references/a.jpg");
    expect(projectFilePath("/home/nn/lighthouse/", "references/a.jpg")).toBe("/home/nn/lighthouse/references/a.jpg");
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
