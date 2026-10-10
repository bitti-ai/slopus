// @vitest-environment jsdom
import { expect, it } from "vitest";
import fixture from "../../fixtures/image-draft-commands.json";
import { executeAgentCommands, type ProjectCommand } from "./runtime";
import { createProjectConfig, parseProjectConfig } from "./project";
import { restoreGeneratedImage } from "./imageHistory";
import { compileImagePrompt } from "./imagePrompt";
import { imageDraftCommandSchema } from "./imageDraftCommands";

const project = () => createProjectConfig({ name: "Drafts", prompt: "Existing video", resolution: "1080p", aspectRatio: "16:9", targetDurationSeconds: 10 });

it("prepares independent image-bar drafts, persists edits across selection and leaves video settings alone", async () => {
  const before = project();
  const config = await executeAgentCommands(before, fixture.commands as ProjectCommand[]);
  const reopened = parseProjectConfig(JSON.parse(JSON.stringify(config)));
  expect(reopened.assets.map((asset) => [asset.id, asset.name, asset.imageDraft])).toEqual([["poster", "Poster", true], ["banner", "Banner", true]]);
  expect(reopened.assets.every((asset) => !asset.relativePath && !asset.sourcePath)).toBe(true);
  expect(reopened.assets[0].imageGeneration).toMatchObject({ resolution: "768p", aspectRatio: "1:1", scene: { steps: 30, seed: 42, background: "Snowy mountains" }, references: [{ id: "ref-balloon" }] });
  expect(reopened.imageScene?.nodes).toHaveLength(2);
  expect(reopened.imageScene?.nodes[0].description).toBe("@[ref:ref-balloon] floats beside the mountains");
  const banner = restoreGeneratedImage(reopened, "banner");
  expect(banner.imageScene?.nodes).toHaveLength(1);
  expect(banner.imageSettings).toMatchObject({ resolution: "416p", aspectRatio: "16:9" });
  expect(compileImagePrompt(banner).prompt).toContain("A boat on a lake");
  expect(reopened.settings).toEqual(before.settings);
  expect(reopened.generationJobs).toEqual(before.generationJobs);
  expect(reopened.timeline).toEqual(before.timeline);
  expect(before.assets).toEqual([]);
});

it.each(fixture.invalid)("rejects invalid draft command transactionally: %j", async (command) => {
  const current = await executeAgentCommands(project(), fixture.commands as ProjectCommand[]);
  const before = structuredClone(current);
  await expect(executeAgentCommands(current, [{ op: "image.configure", background: "Must not stick" }, command as ProjectCommand])).rejects.toThrow();
  expect(current).toEqual(before);
});

it("rejects authored paths and selection of a finished image", async () => {
  expect(imageDraftCommandSchema.safeParse({ op: "image.draft.add", id: "bad", name: "Bad", prompt: "No", relativePath: "invented.png" }).success).toBe(false);
  const current = await executeAgentCommands(project(), fixture.commands as ProjectCommand[]);
  current.assets[1] = { ...current.assets[1], imageDraft: false, relativePath: "media/banner.jpg" };
  await expect(executeAgentCommands(current, [{ op: "image.draft.select", id: "banner" }])).rejects.toThrow("Editable image draft");
});
