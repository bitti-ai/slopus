import { describe, expect, it } from "vitest";
import completeFixture from "../../fixtures/project-v1-complete.json";
import createdFixture from "../../fixtures/project-v1-created.json";
import wireComplete from "../../fixtures/rust-serialized-complete.json";
import wireCreated from "../../fixtures/rust-serialized-created.json";
import {
  compileMiniMaxH3Prompt,
  compileMiniMaxH3PromptSegments,
  compileGenerationJobPrompt,
  createDraftGenerationJob,
  parseProjectConfig,
  projectReferenceSchema,
  type ProjectReference,
} from "./project";
import {
  countShotTags,
  hasCameraMovement,
  normalizeShotTagSelection,
  selectedShotTagOptions,
  shotTagClauses,
  shotTagTerms,
  SHOT_TAG_GROUPS,
  SHOT_TAG_ID_PATTERN,
  toggleShotTag,
  type ShotTagSelection,
} from "./shot-tags";

const now = "2026-01-01T00:00:00.000Z";
const textReference = (over: Partial<ProjectReference> = {}): ProjectReference => projectReferenceSchema.parse({
  id: "ref-1", kind: "text", name: "Mara", description: "Calm architect in charcoal wool.",
  intendedUse: ["character"], createdAt: now, ...over,
});

/** The tags used in the worked example throughout this file and in the
 *  fixtures: a slow, small macro push in soft practical light. */
const macroPush: ShotTagSelection = {
  visualStyle: ["live-action-cinematic"],
  shotSize: ["extreme-close-up"],
  cameraAngle: ["low-angle"],
  lens: ["macro-lens"],
  cameraMovement: ["push-in"],
  cameraSpeed: ["slow"],
  cameraAmplitude: ["small"],
  lighting: ["soft-light", "practical-light"],
  timeOfDay: ["golden-hour"],
  mood: ["intimate"],
  motionPace: ["slow-motion"],
};

describe("shot tag taxonomy", () => {
  it("keeps every id in the shape both validators enforce, and keeps them unique", () => {
    // The ids are persisted, and `is_shot_tag_id` in src-tauri/src/lib.rs
    // decides whether a file carrying them can be written back. A taxonomy
    // entry that fails this regex is a shot the desktop app would refuse to
    // save AFTER the user tagged it.
    const groupIds = new Set<string>();
    for (const group of SHOT_TAG_GROUPS) {
      expect(SHOT_TAG_ID_PATTERN.test(group.id), `group id ${group.id}`).toBe(true);
      expect(groupIds.has(group.id), `duplicate group id ${group.id}`).toBe(false);
      groupIds.add(group.id);
      const optionIds = new Set<string>();
      for (const option of group.options) {
        expect(SHOT_TAG_ID_PATTERN.test(option.id), `option id ${option.id}`).toBe(true);
        expect(optionIds.has(option.id), `duplicate option id ${group.id}/${option.id}`).toBe(false);
        optionIds.add(option.id);
        // A tag with no term contributes nothing to the prompt while looking
        // like it does — the picker would be lying about what it changes.
        expect(option.term.trim().length, `empty term for ${group.id}/${option.id}`).toBeGreaterThan(0);
        expect(option.label.trim().length).toBeGreaterThan(0);
      }
    }
    // Camera motion has to be expressible as amplitude AND speed, not just as
    // a named move — that is what the guide asks for.
    expect(SHOT_TAG_GROUPS.map((group) => group.id)).toEqual(expect.arrayContaining(["cameraMovement", "cameraSpeed", "cameraAmplitude"]));
  });

  it("resolves terms in the taxonomy's own order, not the order boxes were ticked", () => {
    const ticked: ShotTagSelection = { lighting: ["practical-light", "soft-light"] };
    // Otherwise the same set of tags compiles to different bytes on different
    // days, and every save shows a diff nobody made.
    expect(shotTagTerms(ticked, "lighting")).toEqual(["soft light", "practical light"]);
  });

  it("takes one option in a single-choice group and any number in a multiple one", () => {
    const single = toggleShotTag(toggleShotTag({}, "shotSize", "wide"), "shotSize", "close-up");
    expect(single.shotSize).toEqual(["close-up"]);
    const many = toggleShotTag(toggleShotTag({}, "lighting", "soft-light"), "lighting", "backlight");
    expect(many.lighting).toEqual(["soft-light", "backlight"]);
    // Unticking the last option leaves no empty group behind.
    expect(toggleShotTag({ mood: ["calm"] }, "mood", "calm")).toEqual({});
  });

  it("normalizes exactly the way the Rust validator does", () => {
    // Three steps, same order, same result — see normalize_shot_tags in
    // src-tauri/src/lib.rs. Drift here means the two layers write different
    // bytes for the same selection.
    expect(normalizeShotTagSelection({ mood: [] })).toBeNull();
    expect(normalizeShotTagSelection({ lighting: ["soft-light", "soft-light", "backlight"] }))
      .toEqual({ lighting: ["soft-light", "backlight"] });
    expect(normalizeShotTagSelection(null)).toBeNull();
    // A tag from a newer build is the user's, not this build's, so it survives.
    expect(normalizeShotTagSelection({ weather: ["light-rain"] })).toEqual({ weather: ["light-rain"] });
  });

  it("counts only the tags this build can turn into words", () => {
    expect(countShotTags({ mood: ["calm"], weather: ["light-rain"] })).toBe(1);
    expect(selectedShotTagOptions({ mood: ["calm"] })[0].option.term).toBe("calm");
  });

  it("drops movement speed and amplitude when there is no movement to qualify", () => {
    // On their own they describe nothing, so putting them in the prompt would
    // be words the user gets no benefit from and did not intend as a sentence.
    const orphaned: ShotTagSelection = { cameraSpeed: ["slow"], cameraAmplitude: ["large"] };
    expect(hasCameraMovement(orphaned)).toBe(false);
    expect(shotTagClauses(orphaned).clauses).toEqual([]);
    expect(compileMiniMaxH3Prompt("a rocket launch", [], orphaned)).not.toContain("slow speed");

    const qualified = { ...orphaned, cameraMovement: ["push-in"] };
    expect(shotTagClauses(qualified).clauses[0]).toEqual({ label: "Camera movement", terms: ["push in", "slow speed", "large amplitude"] });
  });
});

describe("compiling tags into the MiniMax H3 prompt", () => {
  it("keeps a tagless shot byte-identical to what it has always produced", () => {
    // Every existing project is tagless. The tag work must not silently move a
    // single character of the prompt those shots already send.
    const withoutTags = compileMiniMaxH3Prompt("a rocket launch over the ocean at dawn");
    expect(withoutTags).toBe(compileGenerationJobPrompt(parseProjectConfig(createdFixture).generationJobs[0]));
    expect(compileMiniMaxH3Prompt("a rocket launch over the ocean at dawn", [], {})).toBe(withoutTags);
    expect(compileMiniMaxH3Prompt("a rocket launch over the ocean at dawn", [], null)).toBe(withoutTags);
  });

  it("writes the tags into the T2VA field in the guide's order", () => {
    const compiled = compileMiniMaxH3Prompt("hands shaping wet clay on a spinning wheel", [], macroPush);
    expect(compiled).toBe([
      "integrated_multimodal_description: [Shot 1] Live-action, cinematic, extreme close-up, low angle, macro lens, "
      + "hands shaping wet clay on a spinning wheel. Camera movement: push in, slow speed, small amplitude. "
      + "Lighting: soft light, practical light. Time of day: golden hour. Mood: intimate. Motion: slow motion.",
      "overall_soundscape: The ambient sound and physical action sounds are those the scene and actions described above naturally produce. Nothing beyond what that description already establishes is added.",
      "non_diegetic_music: N/A",
    ].join("\n\n"));
  });

  it("keeps the six full-reference sections, with the tags inside the shot", () => {
    const compiled = compileMiniMaxH3Prompt("hands shaping wet clay", [textReference()], macroPush);
    // The section list and its order are the contract; tags never add or move a
    // section, they only fill the one shot.
    expect(compiled.split("\n\n").map((section) => section.split(":")[0]))
      .toEqual(["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]);
    // §5.2: the style opening comes BEFORE [Shot 1] in this shape.
    expect(compiled).toContain("The target video is in a live-action, cinematic style.\n[Shot 1] Extreme close-up, low angle, macro lens, hands shaping wet clay.");
    expect(compiled).toContain("The shot features <Subject 1>, matching the definitions above. Camera movement: push in, slow speed, small amplitude.");
    expect(compiled).toContain("<Subject 1>: Calm architect in charcoal wool.");
  });

  it("lets a chosen look replace the one guessed from the words", () => {
    // Untagged, the words decide: "claymation" in the brief picks Claymation.
    expect(compileMiniMaxH3Prompt("a claymation fox")).toContain("[Shot 1] Claymation, a claymation fox");
    // Tagged, the user's choice wins outright rather than being appended
    // alongside a second, contradictory style.
    const tagged = compileMiniMaxH3Prompt("a claymation fox", [], { visualStyle: ["watercolor"] });
    expect(tagged).toContain("[Shot 1] Watercolor, a claymation fox");
    expect(tagged).not.toContain("Claymation");
  });

  it("ignores a tag id it has no words for instead of guessing at one", () => {
    const compiled = compileMiniMaxH3Prompt("a rocket launch", [], { weather: ["light-rain"], mood: ["calm"] });
    expect(compiled).toContain("Mood: calm.");
    expect(compiled).not.toContain("light-rain");
    expect(compiled).not.toContain("weather");
  });

  it("marks the user's own prose apart from the terms their tags added", () => {
    const brief = "hands shaping wet clay on a spinning wheel";
    const segments = compileMiniMaxH3PromptSegments(brief, [], macroPush);
    // The preview is these segments; the engine gets their concatenation. One
    // cannot drift from the other because there is only one compilation.
    expect(segments.map((segment) => segment.value).join("")).toBe(compileMiniMaxH3Prompt(brief, [], macroPush));
    expect(segments.filter((segment) => segment.kind === "brief").map((segment) => segment.value)).toEqual([brief]);
    // Every tag-attributed run is terms straight out of the taxonomy. The field
    // names around them ("Camera movement: ", "Lighting: ") are Slopus's own
    // scaffolding and must NOT be coloured as something the user chose.
    expect(segments.filter((segment) => segment.kind === "tag").map((segment) => segment.value)).toEqual([
      "Live-action, cinematic",
      "extreme close-up, low angle, macro lens",
      "push in, slow speed, small amplitude",
      "soft light, practical light",
      "golden hour",
      "intimate",
      "slow motion",
    ]);
    expect(segments.some((segment) => segment.kind === "frame" && segment.value === " Camera movement: ")).toBe(true);
    // The stop after the user's words is Slopus's punctuation, not theirs.
    expect(segments.some((segment) => segment.kind === "frame" && segment.value === ".")).toBe(true);
  });

  it("puts a draft's tags on the shot and compiles them from scene data", () => {
    // Tags are per-SHOT now, so a draft made from one line puts them on the one
    // shot it opens with. The legacy per-job `shotTags` key is not written any
    // more; it is only ever read, off files that already carry it.
    const job = createDraftGenerationJob("hands shaping wet clay", { shotTags: { cameraMovement: ["push-in"], mood: [] }, now });
    expect(job.shots?.[0].settings).toEqual({ cameraMovement: ["push-in"] });
    expect(job).not.toHaveProperty("compiledPrompt");
    expect(compileGenerationJobPrompt(job)).toContain("Camera movement: push in.");
    // Nothing tagged means no key at all, so an untagged shot writes the file
    // it always wrote.
    expect("settings" in (createDraftGenerationJob("hands shaping wet clay", { now }).shots?.[0] ?? {})).toBe(false);
  });
});

describe("shot tags across both validators", () => {
  it("still loads a job written before shot tags existed", () => {
    // Neither fixture has the key: one is the frontend's own output, the other
    // is the bytes Rust really writes for it.
    expect("shotTags" in createdFixture.generationJobs[0]).toBe(false);
    expect("shotTags" in wireCreated.generationJobs[0]).toBe(false);
    for (const legacy of [createdFixture, wireCreated]) {
      expect(parseProjectConfig(legacy).generationJobs[0].shotTags ?? null).toBeNull();
    }
    // And an explicit null survives too: Rust holds the field as an Option, and
    // a bare `.optional()` would reject the null a struct without
    // skip_serializing_if emits.
    const explicitNull = structuredClone(createdFixture) as Record<string, any>;
    explicitNull.generationJobs[0].shotTags = null;
    expect(parseProjectConfig(explicitNull).generationJobs[0].shotTags ?? null).toBeNull();
  });

  it("reads back the tags the Rust validator wrote, unchanged", () => {
    // rust-serialized-complete.json is regenerated by `cargo test` from
    // validate_and_normalize_config. This is the round trip that matters: the
    // backend writes the file before the frontend ever parses it.
    const written = wireComplete.generationJobs[0].shotTags;
    expect(written).toBeTruthy();
    expect(parseProjectConfig(wireComplete).generationJobs[0].shotTags).toEqual(written);
    // Rust normalizes group order; the source fixture and the bytes it produced
    // must therefore still describe the same selection.
    expect(normalizeShotTagSelection(completeFixture.generationJobs[0].shotTags)).toEqual(written);
    // And the tags actually reach a prompt rather than sitting inert in a file.
    const job = parseProjectConfig(wireComplete).generationJobs[0];
    expect(compileMiniMaxH3Prompt(job.creativeBrief, [], job.shotTags))
      .toContain("Camera movement: push in, slow speed, small amplitude.");
  });

  it("rejects an id neither validator would accept", () => {
    // `is_shot_tag_id` refuses these in Rust; if zod took them the frontend
    // would write a file the desktop app could no longer save.
    for (const bad of [{ "Camera Movement": ["push-in"] }, { cameraMovement: ["Push In"] }, { cameraMovement: [""] }]) {
      const config = structuredClone(completeFixture) as Record<string, any>;
      config.generationJobs[0].shotTags = bad;
      expect(() => parseProjectConfig(config), JSON.stringify(bad)).toThrow();
    }
  });
});
