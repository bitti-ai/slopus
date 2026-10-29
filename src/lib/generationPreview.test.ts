// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { validGenerationPreview } from "./generationPreview";
import { engineProviderSetting, EMPTY_ENGINE_SETTINGS } from "./settings";
import { saveGenerationPreviewsEnabled } from "./generationPreviewSettings";
import { saveOtherWeightPath, TAEH3_URL } from "./upscalers";
afterEach(() => localStorage.clear());

it("only configures available H3 preview weights when enabled and removes stale settings", () => {
  const base = { enabled: true, model: null, options: { previewVae: "stale" } };
  const options = (modelType = "minimax-h3") => engineProviderSetting(EMPTY_ENGINE_SETTINGS, base, "sage2", [], "prompt", [], false, {}, { modelType }).options;
  expect(options()).not.toHaveProperty("previewVae");
  saveOtherWeightPath(TAEH3_URL, "C:/weights/taeh3.safetensors");
  expect(options()).toHaveProperty("previewVae", "C:/weights/taeh3.safetensors");
  expect(options("moss")).not.toHaveProperty("previewVae");
  saveGenerationPreviewsEnabled(false);
  expect(options()).not.toHaveProperty("previewVae");
});

it("rejects malformed and excessive worker preview payloads", () => {
  const valid = { jobId: "job", step: 0, width: 168, height: 96, fps: 7, frames: ["jpeg"] };
  expect(validGenerationPreview(valid)).toBe(true);
  for (const patch of [{ frames: [] }, { frames: Array(129).fill("jpeg") }, { frames: ["x".repeat(262145)] },
    { fps: Infinity }, { fps: 0 }, { width: 257 }, { height: -2 }, { step: -1 }]) {
    expect(validGenerationPreview({ ...valid, ...patch })).toBe(false);
  }
});
