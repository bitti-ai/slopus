import { describe, expect, it } from "vitest";
import { KNOWN_CHARACTERS } from "./known-characters";
import { CLOTHING_SETTING_GROUPS, LOCATION_GROUPS } from "./expanded-reference-options";
import { clothingSelectionFromPrompt, composeClothingPrompt, composeLocationPrompt, hasPresetIcon, locationSelectionFromPrompt, REFERENCE_PRESETS, selectedReferencePreset, type PresetReferenceType } from "./reference-presets";

const TYPES: PresetReferenceType[] = ["animal", "character", "clothing", "accessory", "product", "location", "style"];

describe("reference preset catalog", () => {
  it("offers common clothing and accessories without multiplying items by color or fabric", () => {
    const clothes = REFERENCE_PRESETS.filter((preset) => preset.type === "clothing");
    const accessories = REFERENCE_PRESETS.filter((preset) => preset.type === "accessory");
    expect(clothes.map((preset) => preset.name)).toEqual(expect.arrayContaining(["T-shirt", "Jeans", "Casual dress", "Jacket", "Two-piece suit", "Sneakers"]));
    expect(accessories.map((preset) => preset.name)).toEqual(expect.arrayContaining(["Glasses", "Sunglasses", "Necklace", "Ring", "Wristwatch", "Handbag"]));
    for (const presets of [clothes, accessories]) {
      expect(new Set(presets.map((preset) => preset.name)).size).toBe(presets.length);
      expect(presets.every((preset) => preset.prompt === `${preset.name}.`)).toBe(true);
    }
  });

  it("restores clothing colors and fabrics from saved prompts and keeps the base preset for icons", () => {
    const shirt = REFERENCE_PRESETS.find((preset) => preset.type === "clothing" && preset.name === "T-shirt")!;
    expect(composeClothingPrompt(shirt, { color: "navy-blue", fabric: "cotton" })).toBe("T-shirt, in navy blue, made of cotton.");
    for (const group of CLOTHING_SETTING_GROUPS) {
      for (const option of group.options) {
        const settings = { [group.id]: option.id };
        expect(clothingSelectionFromPrompt(composeClothingPrompt(shirt, settings))).toEqual({ preset: shirt, settings });
      }
    }
    const prompt = composeClothingPrompt(shirt, { color: "navy-blue", fabric: "cotton" });
    expect(clothingSelectionFromPrompt(prompt)?.settings).toEqual({ color: "navy-blue", fabric: "cotton" });
    expect(selectedReferencePreset({ id: "shirt", name: "My shirt", kind: "text", description: prompt, intendedUse: ["clothing"], createdAt: "2026-10-03T12:00:00Z" })).toEqual(shirt);
    expect(composeClothingPrompt(shirt, {})).toBe("T-shirt.");
    expect(clothingSelectionFromPrompt("T-shirt, with a hand-painted logo.")).toBeUndefined();
    expect(clothingSelectionFromPrompt("T-shirt, in red, in blue.")).toBeUndefined();
  });
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

  it("keeps the catalog usable before icons are generated and accepts optional bundled artwork", () => {
    const visual = REFERENCE_PRESETS.filter((preset) => preset.type === "character" || preset.type === "product" || preset.type === "location" || preset.type === "style");
    expect(visual).toHaveLength(810);
    const preset = { ...visual[0], icon: undefined };
    expect(hasPresetIcon(preset)).toBe(false);
    expect(hasPresetIcon({ ...preset, icon: "/bundled-icon.jpg" })).toBe(true);
    expect(REFERENCE_PRESETS.every((item) => /^[a-zA-Z0-9_-]{1,160}$/.test(item.id))).toBe(true);
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
