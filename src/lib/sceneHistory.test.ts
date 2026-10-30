import { describe, expect, it, vi } from "vitest";
import { createProjectConfig, generationAssetId, parseProjectConfig, type ProjectConfig, type SceneGenerationVersion } from "./project";
import { completeSceneGeneration, duplicateScene, makeSceneGenerationPrimary, removeSceneDraft, removeSceneGeneration, saveSceneDrafts, sceneInput, selectSceneGeneration, sceneUsedSeed, SCENE_GENERATION_HISTORY_LIMIT } from "./sceneHistory";
import { ProjectSession } from "./projectSession";

const initial = () => createProjectConfig({ name: "History", prompt: "A quiet scene", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 5 });

it("reports recorded seeds, falls back to legacy fixed seeds and leaves unknown random seeds unset", () => {
  const version = take(initial(), "seed-test");
  expect(sceneUsedSeed({ ...version, scene: { ...version.scene, seed: -1 }, generationSnapshot: '{"seed":123}' })).toBe(123);
  expect(sceneUsedSeed({ ...version, scene: { ...version.scene, seed: 42 }, generationSnapshot: "legacy" })).toBe(42);
  expect(sceneUsedSeed({ ...version, scene: { ...version.scene, seed: -1 }, generationSnapshot: '{"seed":-1}' })).toBeUndefined();
});

it("keeps original reference latents across upscaled primaries, history pruning and reloads", () => {
  let config = finish(initial(), "original");
  const id = config.generationJobs[0].id;
  for (let i = 0; i < 6; i++) {
    config = completeSceneGeneration(config, id, { ...take(config, `upscale-${i}`), originalLatentRelativePath: "latents/original.safetensors", upscaleFactor: 2 });
    config = parseProjectConfig(JSON.parse(JSON.stringify(config)));
    expect(config.generationJobs[0].latentRelativePath).toBe("latents/original.safetensors");
  }
  const history = config.generationJobs[0].generationHistory!;
  expect(history.versions).toHaveLength(SCENE_GENERATION_HISTORY_LIMIT);
  expect(history.versions.at(-1)?.latentRelativePath).toBe("latents/upscale-5.safetensors");
  config = makeSceneGenerationPrimary(config, id, history.versions[0].id);
  expect(config.generationJobs[0].latentRelativePath).toBe("latents/original.safetensors");
});
function take(config: ProjectConfig, id: string): SceneGenerationVersion {
  const job = config.generationJobs[0];
  return { id, createdAt: new Date(0).toISOString(), scene: sceneInput(job), generationSnapshot: id, latentRelativePath: `latents/${id}.safetensors`,
    media: { id: generationAssetId(job.id), name: job.title, kind: "generated", mimeType: "video/mp4", relativePath: `media/${id}.mp4`, width: 736, height: 416, durationMs: 5000, createdAt: new Date(0).toISOString(), hasAudio: true } };
}
function finish(config: ProjectConfig, id: string) { return completeSceneGeneration(config, config.generationJobs[0].id, take(config, id)); }
const edit = (config: ProjectConfig, music: string) => saveSceneDrafts({ ...config, generationJobs: config.generationJobs.map(j => ({ ...j, music, steps: music === "First" ? 4 : 8, seed: music === "First" ? 10 : 20,
  shots: j.shots!.map(shot => ({ ...shot, action: music, speech: `${music} speech` })) })) }, config);

describe("scene generation history", () => {
  it("removes a selected draft, restores primary settings and supports undo and redo", () => {
    const config = edit(finish(edit(initial(), "First"), "one"), "Pending");
    const id = config.generationJobs[0].id;
    config.generationJobs[0].title = "Renamed scene";
    const session = new ProjectSession({ folderPath: "C:/history", config }, vi.fn(async () => {}));
    session.edit(current => removeSceneDraft(current, id));
    const removed = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config)));
    expect(removed.generationJobs[0]).toMatchObject({ title: "Renamed scene", music: "First", steps: 4, seed: 10,
      outputRelativePath: "media/one.mp4", latentRelativePath: "latents/one.safetensors", generationHistory: { draft: null, primaryId: "one", selectedId: "one" } });
    expect(removed.generationJobs[0].generationHistory!.versions).toEqual(config.generationJobs[0].generationHistory!.versions);
    expect(session.getSnapshot().config.assets).toBe(config.assets);
    expect(session.getSnapshot().config.timeline).toBe(config.timeline);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0]).toMatchObject({ music: "Pending", generationHistory: { selectedId: null, draft: { music: "Pending" } } });
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0].generationHistory!.draft).toBeNull();
  });

  it("removes an unselected draft without switching the selected or primary Take", () => {
    let config = edit(finish(edit(finish(edit(initial(), "First"), "one"), "Second"), "two"), "Pending");
    const id = config.generationJobs[0].id;
    config = selectSceneGeneration(config, id, "one");
    config = saveSceneDrafts(removeSceneDraft(config, id));
    expect(config.generationJobs[0]).toMatchObject({ music: "First", outputRelativePath: "media/two.mp4",
      generationHistory: { draft: null, primaryId: "two", selectedId: "one" } });
    expect(edit(config, "New draft").generationJobs[0].generationHistory!.draft?.music).toBe("New draft");
  });

  it("keeps the only draft and blocks draft removal during generation", () => {
    const empty = initial();
    expect(removeSceneDraft(empty, empty.generationJobs[0].id)).toBe(empty);
    const config = edit(finish(initial(), "one"), "Pending");
    for (const status of ["queued", "generating", "ready"] as const) {
      const busy = { ...config, generationJobs: config.generationJobs.map(job => ({ ...job, status })) };
      expect(removeSceneDraft(busy, busy.generationJobs[0].id)).toBe(busy);
    }
  });

  it.each([false, true])("renames a scene without creating a draft, including legacy history %s", legacy => {
    const config = finish(initial(), "one");
    if (legacy) delete config.generationJobs[0].generationHistory;
    const originalTitle = config.generationJobs[0].title;
    const session = new ProjectSession({ folderPath: "C:/history", config }, vi.fn(async () => {}));
    session.edit(current => ({ ...current, generationJobs: current.generationJobs.map(job => ({ ...job, title: "Renamed scene" })) }));
    const renamed = parseProjectConfig(JSON.parse(JSON.stringify(session.getSnapshot().config))).generationJobs[0];
    expect(renamed.title).toBe("Renamed scene");
    expect(renamed.generationHistory!.selectedId).toBe(renamed.generationHistory!.primaryId);
    expect(renamed.generationHistory!.draft).toBeNull();
    expect(renamed.generationHistory!.versions).toHaveLength(1);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0].title).toBe(originalTitle);
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0]).toMatchObject({ title: "Renamed scene", generationHistory: { draft: null } });
  });

  it("keeps the renamed scene title when switching takes and restoring an existing draft", () => {
    let config = edit(finish(edit(initial(), "First"), "one"), "Pending");
    const id = config.generationJobs[0].id, draft = config.generationJobs[0].generationHistory!.draft;
    config = saveSceneDrafts({ ...config, generationJobs: config.generationJobs.map(job => ({ ...job, title: "Renamed scene" })) }, config);
    expect(config.generationJobs[0].generationHistory!.draft).toBe(draft);
    config = selectSceneGeneration(config, id, "one");
    expect(config.generationJobs[0]).toMatchObject({ title: "Renamed scene", music: "First", generationHistory: { selectedId: "one" } });
    config = selectSceneGeneration(config, id, null);
    expect(config.generationJobs[0]).toMatchObject({ title: "Renamed scene", music: "Pending", generationHistory: { selectedId: null } });
  });

  it("selects a completed take without creating a draft after renaming during generation", () => {
    let config = finish(initial(), "one");
    const submitted = take(config, "two"), id = config.generationJobs[0].id;
    config = { ...config, generationJobs: config.generationJobs.map(job => ({ ...job, title: "Renamed while rendering", status: "generating" as const })) };
    config = completeSceneGeneration(config, id, submitted);
    expect(config.generationJobs[0]).toMatchObject({ title: "Renamed while rendering", generationHistory: { selectedId: "two", primaryId: "two", draft: null } });
  });

  it("removes an unselected take without changing the primary or current draft", () => {
    let config = finish(edit(initial(), "First"), "one");
    config = edit(finish(edit(config, "Second"), "two"), "Pending");
    const id = config.generationJobs[0].id;
    const removed = removeSceneGeneration(config, id, "one");
    expect(removed.generationJobs[0]).toMatchObject({ music: "Pending", outputRelativePath: "media/two.mp4",
      generationHistory: { primaryId: "two", selectedId: null, draft: { music: "Pending" } } });
    expect(removed.generationJobs[0].generationHistory!.versions.map(v => v.id)).toEqual(["two"]);
    expect(removed.assets).toEqual(config.assets);
    expect(removeSceneGeneration(removed, id, "one")).toBe(removed);
  });
  it.each(["queued", "generating", "ready"] as const)("removes non-primary history while %s without changing the live job", status => {
    const base = finish(edit(finish(edit(initial(), "First"), "one"), "Second"), "two");
    const id = base.generationJobs[0].id;
    for (const config of [edit(base, "Pending"), selectSceneGeneration(base, id, "one"), base]) {
      const busy = { ...config, generationJobs: config.generationJobs.map(job => ({ ...job, status, progress: 0.4 })) };
      const before = busy.generationJobs[0];
      const removed = removeSceneGeneration(busy, id, "one");
      expect({ ...removed.generationJobs[0], generationHistory: undefined }).toEqual({ ...before, generationHistory: undefined });
      expect(removed.generationJobs[0].generationHistory!.versions.map(v => v.id)).toEqual(["two"]);
      expect(removed.generationJobs[0].generationHistory!.primaryId).toBe("two");
      expect(removed.generationJobs[0].generationHistory!.selectedId).toBe(before.generationHistory!.selectedId === "one" ? null : before.generationHistory!.selectedId);
      if (before.generationHistory!.selectedId === "one") expect(removed.generationJobs[0].generationHistory!.draft).toEqual(sceneInput(before));
      expect(removed.assets).toBe(busy.assets);
      expect(removed.timeline).toBe(busy.timeline);
      expect(removeSceneGeneration(busy, id, "two")).toBe(busy);
      expect(removeSceneGeneration(removed, id, "one")).toBe(removed);
    }
  });
  it("keeps a completed generation through undo and redo of a take removed while rendering", () => {
    let config = finish(edit(finish(edit(initial(), "First"), "one"), "Second"), "two");
    const id = config.generationJobs[0].id;
    config = selectSceneGeneration(config, id, "one");
    config.generationJobs[0].status = "generating";
    const submitted = take(config, "three");
    const session = new ProjectSession({ folderPath: "C:/history", config }, vi.fn(async () => {}));
    session.edit(current => removeSceneGeneration(current, id, "one"));
    expect(session.getSnapshot().config.generationJobs[0]).toMatchObject({ status: "generating", music: "First", generationHistory: { selectedId: null, draft: { music: "First" } } });
    session.update(current => completeSceneGeneration(current, id, submitted));
    expect(session.getSnapshot().config.generationJobs[0].generationHistory!.versions.map(v => v.id)).toEqual(["two", "three"]);
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0].generationHistory!.versions.map(v => v.id)).toEqual(["one", "two", "three"]);
    expect(session.redo()).toBe(true);
    const completed = session.getSnapshot().config.generationJobs[0];
    expect(completed.generationHistory!.versions.map(v => v.id)).toEqual(["two", "three"]);
    expect(completed).toMatchObject({ status: "completed", outputRelativePath: "media/three.mp4", music: "First", generationHistory: { primaryId: "three", selectedId: "three" } });
  });
  it("promotes the newest remaining take when removing the primary and restores selected inputs", () => {
    let config = finish(edit(initial(), "First"), "one");
    config = finish(edit(config, "Second"), "two");
    const id = config.generationJobs[0].id;
    const removed = parseProjectConfig(removeSceneGeneration(config, id, "two"));
    expect(removed.generationJobs[0]).toMatchObject({ music: "First", steps: 4, seed: 10, outputRelativePath: "media/one.mp4",
      latentRelativePath: "latents/one.safetensors", generationSnapshot: "one", generationHistory: { primaryId: "one", selectedId: "one" } });
    expect(removed.assets.find(a => a.id === generationAssetId(id))?.relativePath).toBe("media/one.mp4");
    const selectedOlder = selectSceneGeneration(config, id, "one");
    expect(removeSceneGeneration(selectedOlder, id, "one").generationJobs[0]).toMatchObject({ music: "Second", generationHistory: { primaryId: "two", selectedId: "two" } });
  });
  it("returns the last take to a draft with timeline placeholders and supports undo and redo", () => {
    const config = edit(finish(edit(initial(), "First"), "one"), "Pending");
    const id = config.generationJobs[0].id, assetId = generationAssetId(id), track = config.timeline.tracks[0];
    track.clips = [{ id: "clip", assetId, trackId: track.id, label: "Scene", startMs: 0, sourceStartMs: 0, durationMs: 5000, status: "generated" }];
    const session = new ProjectSession({ folderPath: "C:/history", config }, vi.fn(async () => {}));
    session.edit(current => removeSceneGeneration(current, id, "one"));
    const removed = parseProjectConfig(session.getSnapshot().config);
    expect(removed.generationJobs[0]).toMatchObject({ status: "draft", stage: "queued", music: "Pending", outputRelativePath: null, latentRelativePath: null,
      generationSnapshot: null, generationHistory: { versions: [], selectedId: null, primaryId: null, draft: { music: "Pending" } } });
    expect(removed.assets.find(a => a.id === assetId)?.relativePath).toBeNull();
    expect(removed.timeline.tracks[0].clips[0]).toMatchObject({ id: "clip", assetId, status: "draft" });
    expect(session.undo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0].outputRelativePath).toBe("media/one.mp4");
    expect(session.redo()).toBe(true);
    expect(session.getSnapshot().config.generationJobs[0].generationHistory!.versions).toHaveLength(0);
  });
  it("can remove a legacy generation without re-adopting the old output", () => {
    const config = initial(); config.generationJobs[0].outputRelativePath = "media/legacy.mp4"; config.generationJobs[0].status = "completed";
    const id = config.generationJobs[0].id;
    const removed = saveSceneDrafts(removeSceneGeneration(config, id, `legacy-${id}`), config);
    expect(removed.generationJobs[0].generationHistory!.versions).toHaveLength(0);
    expect(removed.generationJobs[0].outputRelativePath).toBeNull();
  });
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
  it("removes a draft when its edits are reverted to a saved take", () => {
    let config = finish(edit(initial(), "First"), "one");
    config = edit(config, "Pending");
    expect(config.generationJobs[0].generationHistory!.draft).toBeTruthy();
    config = edit(config, "First");
    expect(config.generationJobs[0].generationHistory).toMatchObject({ selectedId: "one", draft: null });
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
  it.each(["prompt", "long-shot"] as const)("duplicates %s inputs as a Prompt scene with fresh identity and no output or history", (sceneType) => {
    const config = finish(edit(initial(), "First"), "one");
    config.generationJobs[0].sceneType = sceneType;
    const duplicated = duplicateScene(config, config.generationJobs[0].id)!;
    const original = config.generationJobs[0], copy = duplicated.config.generationJobs[1];
    expect(copy).toMatchObject({ title: `${original.title} copy`, music: "First", steps: 4, seed: 10, status: "draft", sceneType: "prompt" });
    expect(original.sceneType).toBe(sceneType);
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
