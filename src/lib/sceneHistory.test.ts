import { describe, expect, it, vi } from "vitest";
import { createProjectConfig, generationAssetId, parseProjectConfig, type ProjectConfig, type SceneGenerationVersion } from "./project";
import { completeSceneGeneration, duplicateScene, makeSceneGenerationPrimary, saveSceneDrafts, sceneInput, selectSceneGeneration, SCENE_GENERATION_HISTORY_LIMIT } from "./sceneHistory";
import { ProjectSession } from "./projectSession";

const initial = () => createProjectConfig({ name: "History", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 5 });
function take(config: ProjectConfig, id: string): SceneGenerationVersion {
  const job = config.generationJobs[0];
  return { id, createdAt: new Date(0).toISOString(), scene: sceneInput(job), generationSnapshot: id, latentRelativePath: `latents/${id}.safetensors`,
    media: { id: generationAssetId(job.id), name: job.title, kind: "generated", mimeType: "video/mp4", relativePath: `media/${id}.mp4`, width: 736, height: 416, durationMs: 5000, createdAt: new Date(0).toISOString(), hasAudio: true } };
}
function finish(config: ProjectConfig, id: string) { return completeSceneGeneration(config, config.generationJobs[0].id, take(config, id)); }
const edit = (config: ProjectConfig, music: string) => saveSceneDrafts({ ...config, generationJobs: config.generationJobs.map(j => ({ ...j, music, steps: music === "First" ? 4 : 8, seed: music === "First" ? 10 : 20,
  shots: j.shots!.map(shot => ({ ...shot, action: music, speech: `${music} speech` })) })) }, config);

describe("scene generation history", () => {
  it("restores complete scene inputs while retaining a separate primary output and editable draft", () => {
    let config = finish(edit(initial(), "First"), "one");
    config = finish(edit(config, "Second"), "two");
    const id = config.generationJobs[0].id;
    config = edit(config, "Pending");
    config = selectSceneGeneration(config, id, "one");
    expect(config.generationJobs[0]).toMatchObject({ music: "First", steps: 4, seed: 10, outputRelativePath: "media/two.mp4", generationHistory: { selectedId: "one", primaryId: "two", draft: { music: "Pending" } } });
    expect(config.generationJobs[0].shots![0]).toMatchObject({ action: "First", speech: "First speech" });
    config = selectSceneGeneration(config, id, null);
    expect(config.generationJobs[0]).toMatchObject({ music: "Pending", steps: 8, seed: 20 });
    expect(config.generationJobs[0].generationHistory!.versions[0].scene.music).toBe("First");
  });
  it("removes optional settings when restoring a take that never had them", () => {
    let config = finish(initial(), "one");
    config = { ...config, generationJobs: config.generationJobs.map(j => ({ ...j, audioSteps: 8, latentUpscale: true, backdropColor: "green" as const })) };
    const selected = selectSceneGeneration(config, config.generationJobs[0].id, "one").generationJobs[0];
    expect(selected.audioSteps).toBeUndefined(); expect(selected.latentUpscale).toBeUndefined(); expect(selected.backdropColor).toBeUndefined();
    expect(selected.generationHistory!.draft).toMatchObject({ audioSteps: 8, latentUpscale: true });
  });
  it("promotes an older take on the stable timeline asset without overwriting the draft", () => {
    let config = finish(edit(initial(), "First"), "one"); config = finish(edit(config, "Second"), "two"); config = edit(config, "Pending");
    const id = config.generationJobs[0].id, assetId = generationAssetId(id), track = config.timeline.tracks[0];
    track.clips = [{ id: "clip", assetId, trackId: track.id, label: "Scene", startMs: 0, sourceStartMs: 0, durationMs: 5000, status: "generated" }];
    config = makeSceneGenerationPrimary(config, id, "one");
    expect(config.assets.find(a => a.id === assetId)?.relativePath).toBe("media/one.mp4");
    expect(config.generationJobs[0]).toMatchObject({ music: "Pending", latentRelativePath: "latents/one.safetensors", outputRelativePath: "media/one.mp4", generationSnapshot: "one", generationHistory: { primaryId: "one", selectedId: null } });
    expect(config.timeline.tracks[0].clips[0].assetId).toBe(assetId);
  });
  it("keeps edits made during rendering and replays completion without duplicate versions", () => {
    let config = finish(initial(), "one"); const submitted = take(config, "two"), id = config.generationJobs[0].id;
    config = edit(config, "Typed while rendering");
    config = completeSceneGeneration(config, id, submitted);
    expect(config.generationJobs[0]).toMatchObject({ music: "Typed while rendering", generationHistory: { selectedId: null, draft: { music: "Typed while rendering" }, primaryId: "two" } });
    config = completeSceneGeneration(config, id, submitted);
    expect(config.generationJobs[0].generationHistory!.versions).toHaveLength(2);
  });
  it("retains four complete takes using a policy independent of the serialized array", () => {
    let config = initial();
    for (let i = 0; i < 7; i++) config = finish(config, `take-${i}`);
    const history = config.generationJobs[0].generationHistory!;
    expect(history.versions.map(v => v.id)).toEqual(["take-3", "take-4", "take-5", "take-6"]);
    expect(history.versions).toHaveLength(SCENE_GENERATION_HISTORY_LIMIT);
    history.versions.push({ ...history.versions[0], id: "future" });
    expect(parseProjectConfig(JSON.parse(JSON.stringify(config))).generationJobs[0].generationHistory!.versions).toHaveLength(5);
  });
  it("duplicates inputs and shots with fresh identity and no output or generation history", () => {
    const config = finish(edit(initial(), "First"), "one");
    const duplicated = duplicateScene(config, config.generationJobs[0].id)!;
    const original = config.generationJobs[0], copy = duplicated.config.generationJobs[1];
    expect(copy).toMatchObject({ title: `${original.title} copy`, music: "First", steps: 4, seed: 10, status: "draft" });
    expect(copy.id).not.toBe(original.id); expect(copy.shots![0].id).not.toBe(original.shots![0].id);
    expect(copy.outputRelativePath).toBeFalsy(); expect(copy.generationHistory).toBeUndefined(); expect(copy.clipId).toBeFalsy();
    copy.shots![0].action = "Changed"; expect(original.shots![0].action).toBe("First");
  });
  it("preserves histories and drafts across project persistence and undo of edits", () => {
    const config = finish(edit(initial(), "First"), "one");
    const session = new ProjectSession({ folderPath: "C:/history", config }, vi.fn(async () => {}));
    session.edit(c => edit(c, "Draft"));
    const restored = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
    expect(restored.generationJobs[0].generationHistory!.draft?.music).toBe("Draft");
    expect(session.undo()).toBe(true); expect(session.getSnapshot().config.generationJobs[0].music).toBe("First");
    expect(session.redo()).toBe(true); expect(session.getSnapshot().config.generationJobs[0].music).toBe("Draft");
  });
  it("adopts an existing video before an edit and blocks switching while rendering", () => {
    const config = initial(); config.generationJobs[0].outputRelativePath = "media/legacy.mp4"; config.generationJobs[0].status = "completed";
    const edited = edit(config, "New");
    expect(edited.generationJobs[0].generationHistory!.versions[0].scene.music).not.toBe("New");
    edited.generationJobs[0].status = "generating";
    expect(selectSceneGeneration(edited, edited.generationJobs[0].id, edited.generationJobs[0].generationHistory!.versions[0].id).generationJobs[0].music).toBe("New");
  });
});
