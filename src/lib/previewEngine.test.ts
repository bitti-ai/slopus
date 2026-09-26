import { describe, expect, it } from "vitest";
import { PreviewEngine } from "./previewEngine";

describe("the preview engine's status", () => {
  it("publishes playback once per sample, counting kept pictures as dropped, and forgets it on stop", () => {
    const engine = new PreviewEngine();
    let published = 0;
    engine.subscribe(() => { published += 1; });
    engine.tick(true); // not playing: ignored
    engine.start();
    for (let index = 0; index < 58; index++) engine.tick(true);
    engine.tick(false); engine.tick(false);
    expect(published).toBe(0);
    engine.sample(1000);
    expect(engine.getSnapshot().playback).toEqual({ fps: 58, dropped: 2 });
    engine.tick(false);
    engine.sample(1000);
    expect(engine.getSnapshot().playback).toEqual({ fps: 0, dropped: 3 });
    expect(published).toBe(2);
    engine.stop();
    expect(engine.getSnapshot().playback).toBeNull();
  });

  it("says nothing about a monitor that drew no ticks, and keeps one GPU answer", () => {
    const engine = new PreviewEngine();
    engine.start();
    engine.sample(1000);
    expect(engine.getSnapshot().playback).toBeNull();
    engine.setGpu({ kind: "webgpu", name: "nvidia ampere" });
    const snapshot = engine.getSnapshot();
    engine.setGpu({ kind: "webgpu", name: "nvidia ampere" });
    expect(engine.getSnapshot()).toBe(snapshot);
  });
});
