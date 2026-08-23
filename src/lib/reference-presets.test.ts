import { describe, expect, it } from "vitest";
import { REFERENCE_PRESETS, type PresetReferenceType } from "./reference-presets";

const TYPES: PresetReferenceType[] = ["character", "product", "location", "style"];

describe("reference preset catalog", () => {
  it("offers about 500 choices for every prepared type", () => {
    for (const type of TYPES) {
      const count = REFERENCE_PRESETS.filter((preset) => preset.type === type).length;
      expect(count, type).toBeGreaterThanOrEqual(499);
      expect(count, type).toBeLessThanOrEqual(520);
    }
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
});
