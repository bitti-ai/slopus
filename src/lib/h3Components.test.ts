// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { H3_VIDEO_VAE_ID, H3_AUDIO_VAE_ID, H3_TEXT_ENCODER_ID, SOL_H3_VAE_URL } from "./h3Components";
import { engineProviderSetting, loadGeneratorTemplateSettings, minimaxOriginalTemplate, minimaxFastTemplate, mossImageTemplate, saveGeneratorTemplateSettings, templateNeedsDownload } from "./settings";
import { downloadH3Component, downloadTemplateWeights, getWeightDownloadState, refreshDownloadedWeights, removeTemplateWeights } from "./weightDownloads";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("./persistence", () => ({ isTauri: () => true }));
const files = new Map<string, string>();
beforeEach(() => {
  localStorage.clear(); files.clear(); vi.clearAllMocks();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "weight_download_hardware") return [];
    if (command === "find_downloaded_weights") return Object.fromEntries(args.urls.filter((url: string) => files.has(url)).map((url: string) => [url, files.get(url)]));
    if (command === "check_weight_files") return Object.fromEntries(args.paths.map((path: string) => [path, [...files.values()].includes(path)]));
    if (command === "download_weight") { const path = `D:/weights/${args.url.split("/").pop()}`; files.set(args.url, path); return path; }
    if (command === "remove_downloaded_weights") for (const [url, path] of files) if (args.paths.includes(path)) files.delete(url);
  });
});
const downloads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "download_weight").map(([, args]) => (args as { url: string }).url);

it("seeds typed VAEs including Sol and preserves FastH3's INT8 selection", () => {
  const settings = loadGeneratorTemplateSettings();
  expect(settings.h3Components?.templates).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: H3_VIDEO_VAE_ID, type: "video" }),
    expect.objectContaining({ id: H3_AUDIO_VAE_ID, type: "audio" }),
    expect.objectContaining({ name: "Sol H3 VAE", type: "video", path: SOL_H3_VAE_URL }),
  ]));
  const fast = settings.templates.find(({ id }) => id === "minimax-h3-fast")!;
  expect(fast.paths.videoVae).toBe(minimaxFastTemplate().paths.videoVae);
  expect(fast.videoVaeId).not.toBe(H3_VIDEO_VAE_ID);
});

it("migrates custom paths and selects the old default generator's encoder once", () => {
  const custom = { ...minimaxOriginalTemplate(), id: "custom", name: "Custom", sources: {},
    paths: { transformer: "D:/model", videoVae: "D:/video", audioVae: "D:/audio", textEncoder: "D:/text", tokenizer: "D:/tokenizer" } };
  localStorage.setItem("slopus.generator-templates.v1", JSON.stringify({ templates: [minimaxOriginalTemplate(), custom], defaultTemplateId: custom.id, catalogVersion: 17 }));
  const migrated = loadGeneratorTemplateSettings();
  expect(migrated.templates[1].paths).toEqual(custom.paths);
  expect(migrated.templates[0].paths.textEncoder).toBe("D:/text");
  expect(migrated.h3Components!.templates.find((entry) => entry.id === migrated.h3Components!.defaultTextEncoderId)).toMatchObject({ path: "D:/text", tokenizer: "D:/tokenizer" });
  expect(loadGeneratorTemplateSettings()).toEqual(migrated);
});

it("resolves the latest default encoder for H3 submissions without changing MOSS", () => {
  const settings = loadGeneratorTemplateSettings();
  const template = settings.templates.find(({ id }) => id === "minimax-h3-original")!;
  settings.h3Components!.templates.push({ id: "custom-text", name: "Custom text", type: "textEncoder", path: "D:/custom-text", tokenizer: "D:/custom-tokenizer", sources: [] });
  settings.h3Components!.defaultTextEncoderId = "custom-text";
  saveGeneratorTemplateSettings(settings);
  const provider = engineProviderSetting(template.paths, undefined, template.attention, [], "prompt", [], false, template.sources, template);
  expect(provider.options).toMatchObject({ textEncoder: "D:/custom-text", tokenizer: "D:/custom-tokenizer" });
  const moss = mossImageTemplate(); moss.paths.textEncoder = "D:/moss-text";
  expect(engineProviderSetting(moss.paths, undefined, moss.attention, [], "prompt", [], false, moss.sources, moss).options.textEncoder).toBe("D:/moss-text");
});

it("downloads a linked Sol VAE and the default encoder, reuses them, and repairs a missing file", async () => {
  const settings = loadGeneratorTemplateSettings();
  for (const template of settings.templates.filter((entry) => ["minimax-h3-original", "minimax-h3-references"].includes(entry.id))) template.videoVaeId = "sol-h3-vae";
  saveGeneratorTemplateSettings(settings);
  await downloadTemplateWeights("minimax-h3-original");
  expect(getWeightDownloadState()?.error).toBeNull();
  expect(downloads()).toContain(SOL_H3_VAE_URL);
  expect(downloads()).toContain(minimaxOriginalTemplate().paths.textEncoder);
  expect(downloads()).not.toContain(minimaxOriginalTemplate().paths.videoVae);
  expect(templateNeedsDownload(loadGeneratorTemplateSettings().templates.find((entry) => entry.id === "minimax-h3-original")!)).toBe(false);
  vi.clearAllMocks();
  await downloadTemplateWeights("minimax-h3-references");
  expect(downloads()).toHaveLength(1);
  files.delete(SOL_H3_VAE_URL); vi.clearAllMocks();
  await downloadTemplateWeights("minimax-h3-original");
  expect(downloads()).toEqual([SOL_H3_VAE_URL]);
});

it("downloads shared templates on their own and keeps them when removing a generator", async () => {
  await downloadH3Component(H3_TEXT_ENCODER_ID);
  expect(getWeightDownloadState()).toMatchObject({ completed: 1, active: false, error: null });
  vi.clearAllMocks();
  await downloadTemplateWeights("minimax-h3-original");
  expect(downloads()).not.toContain(minimaxOriginalTemplate().paths.textEncoder);
  await removeTemplateWeights("minimax-h3-original");
  expect(files.has(minimaxOriginalTemplate().paths.textEncoder)).toBe(true);
  expect(files.has(minimaxOriginalTemplate().paths.videoVae)).toBe(true);
});

it("does not replace an edited shared source when a download completes", async () => {
  const normal = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "download_weight" && args.url === SOL_H3_VAE_URL) {
      const current = loadGeneratorTemplateSettings();
      const sol = current.h3Components!.templates.find((entry) => entry.id === "sol-h3-vae")!;
      sol.path = "D:/my-vae"; sol.sources = [];
      saveGeneratorTemplateSettings(current);
    }
    return normal(command, args);
  });
  await downloadH3Component("sol-h3-vae");
  expect(loadGeneratorTemplateSettings().h3Components!.templates.find((entry) => entry.id === "sol-h3-vae")?.path).toBe("D:/my-vae");
});

it("refreshes missing dependencies even when their generator has not been opened", async () => {
  await downloadTemplateWeights("minimax-h3-original");
  files.delete(minimaxOriginalTemplate().paths.textEncoder);
  await refreshDownloadedWeights();
  expect(loadGeneratorTemplateSettings().h3Components!.templates.find((entry) => entry.id === H3_TEXT_ENCODER_ID)?.path).toBe(minimaxOriginalTemplate().paths.textEncoder);
});
