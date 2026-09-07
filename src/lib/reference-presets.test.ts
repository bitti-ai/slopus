import { describe, expect, it } from "vitest";
import { KNOWN_CHARACTERS } from "./known-characters";
import { LOCATION_GROUPS } from "./expanded-reference-options";
import { composeLocationPrompt, locationSelectionFromPrompt, REFERENCE_PRESETS, type PresetReferenceType } from "./reference-presets";

const TYPES: PresetReferenceType[] = ["animal", "character", "product", "location", "style"];

describe("reference preset catalog", () => {
  it("includes distinct animal presets with ready-to-use descriptions", () => {
    const animals = REFERENCE_PRESETS.filter((preset) => preset.type === "animal");
    expect(animals).toHaveLength(80);
    expect(new Set(animals.map((preset) => preset.name)).size).toBe(80);
    expect(animals.map((preset) => preset.name)).toEqual(expect.arrayContaining(["Golden retriever", "Bengal tiger", "Emperor penguin", "Octopus"]));
    expect(animals.every((preset) => preset.prompt === `${preset.name}.`)).toBe(true);
  });

  it("tracks the upstream known-good characters and keeps the other catalogs unique", () => {
    expect(KNOWN_CHARACTERS).toHaveLength(503);
    expect(KNOWN_CHARACTERS).toContainEqual(["Ariana Grande", "Ariana Grande", "Real Person / Celebrity"]);
    expect(KNOWN_CHARACTERS).toContainEqual(["The Thirteenth Doctor", "Jodie Whittaker", "Doctor Who"]);
    expect(KNOWN_CHARACTERS.map(([name]) => String(name))).not.toContain("Glenn Rhee");
    expect(REFERENCE_PRESETS.filter((preset) => preset.type === "product")).toHaveLength(100);
    expect(REFERENCE_PRESETS.filter((preset) => preset.type === "location")).toHaveLength(100);
    expect(REFERENCE_PRESETS.filter((preset) => preset.type === "style")).toHaveLength(100);
  });

  it("organizes every prepared type into subcategories", () => {
    for (const type of TYPES) {
      const subcategories = new Set(
        REFERENCE_PRESETS.filter((preset) => preset.type === type).map((preset) => preset.subcategory),
      );
      expect(subcategories.size, type).toBeGreaterThanOrEqual(6);
    }
  });

  it("keeps identifiers unique and descriptions short", () => {
    const ids = REFERENCE_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.max(...REFERENCE_PRESETS.map((preset) => preset.prompt.length))).toBeLessThanOrEqual(100);
  });

  it("bundles icons for the existing character, product, location and style presets without treating it as a generation reference", () => {
    const visual = REFERENCE_PRESETS.filter((preset) => preset.type === "character" || preset.type === "product" || preset.type === "location" || preset.type === "style");
    expect(visual).toHaveLength(810);
    expect(visual.every((preset) => typeof preset.icon === "string" && preset.icon.length > 0)).toBe(true);
  });

  it("does not multiply products or styles by adjectives", () => {
    expect(REFERENCE_PRESETS.some((preset) => /^(Eco|Premium|Rugged|Textured|Bright) /.test(preset.name))).toBe(false);
  });

  it("keeps time, weather and season out of base locations and composes them independently", () => {
    const names = LOCATION_GROUPS.flatMap((group) => group.options);
    expect(names.some((name) => /\b(night|dawn|dusk|misty|storm|winter|summer|spring|autumn)\b/i.test(name))).toBe(false);
    const coastal = REFERENCE_PRESETS.find((preset) => preset.type === "location" && preset.name === "Coastal village")!;
    const prompt = composeLocationPrompt(coastal, { time: "night", season: "winter" });
    expect(prompt).toBe("Coastal village, at night, in winter.");
    expect(locationSelectionFromPrompt(prompt)).toEqual({ preset: coastal, settings: { time: "night", season: "winter" } });
  });
});
