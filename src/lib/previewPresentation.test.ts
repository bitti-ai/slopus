// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { presentPreviewFrame, PreviewMedia } from "./previewPresentation";
import type { Compositor } from "./exportPipeline";
import type { TimelineClip } from "./project";

const clip = (id: string): TimelineClip => ({ id, assetId: id, trackId: "video", startMs: 0, durationMs: 1000, sourceStartMs: 0, label: id, color: null, status: "approved" });
const compositor = (): Compositor => ({ kind: "webgpu", clear: vi.fn(), draw: vi.fn(), take: vi.fn(), dispose: vi.fn() });
const video = (ready = true) => {
  const element = document.createElement("video");
  Object.defineProperties(element, { readyState: { value: ready ? 4 : 1, configurable: true }, videoWidth: { value: 320 }, videoHeight: { value: 180 } });
  return element;
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("persistent preview presentation", () => {
  it("keeps the outgoing pixels until the incoming frame is available, then replaces them in the same surface", () => {
    const frames: { source: unknown; close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal("VideoFrame", class {
      close = vi.fn();
      constructor(public source: unknown) { frames.push(this); }
    });
    const media = new PreviewMedia();
    const first = video(), second = video(false);
    media.set("first", first); media.set("second", second);
    const output = compositor();
    expect(presentPreviewFrame(output, media, [clip("first")], 900)).toBe(true);
    expect(presentPreviewFrame(output, media, [clip("second")], 1000)).toBe(false);
    // Clearing for a cut before capturing its frame was the black-frame risk.
    expect(output.clear).toHaveBeenCalledTimes(1);
    Object.defineProperty(second, "readyState", { value: 4 });
    expect(presentPreviewFrame(output, media, [clip("second")], 1017)).toBe(true);
    expect(output.clear).toHaveBeenCalledTimes(2);
    expect(frames.map((frame) => frame.source)).toEqual([first, second]);
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1));
  });

  it("does not clear for a pending trim seek, an absent layer or an undecoded image", () => {
    const output = compositor();
    const media = new PreviewMedia();
    const pending = video();
    Object.defineProperty(pending, "seeking", { value: true });
    media.set("seek", pending);
    media.set("image", document.createElement("img"));
    for (const id of ["seek", "missing", "image"]) expect(presentPreviewFrame(output, media, [clip(id)], 1000)).toBe(false);
    expect(output.clear).not.toHaveBeenCalled();
  });

  it("captures all layers before submitting any pixels and closes partial captures", () => {
    const close = vi.fn();
    vi.stubGlobal("VideoFrame", class { close = close; });
    const media = new PreviewMedia();
    media.set("top", video());
    const output = compositor();
    expect(presentPreviewFrame(output, media, [clip("top"), clip("lower")], 1000)).toBe(false);
    expect(output.clear).not.toHaveBeenCalled();
    expect(output.draw).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("clears intentional timeline gaps instead of holding footage across them", () => {
    const output = compositor();
    expect(presentPreviewFrame(output, new PreviewMedia(), [], 1000)).toBe(true);
    expect(output.clear).toHaveBeenCalledTimes(1);
    expect(output.draw).not.toHaveBeenCalled();
  });

  it("redraws when a prepared frame arrives and detaches discarded media", () => {
    const media = new PreviewMedia();
    const redraw = vi.fn();
    const unsubscribe = media.subscribe(redraw);
    const first = video(), replacement = video();
    media.set("clip", first);
    first.dispatchEvent(new Event("loadeddata"));
    media.set("clip", replacement);
    first.dispatchEvent(new Event("seeked"));
    replacement.dispatchEvent(new Event("seeked"));
    media.set("clip", null);
    replacement.dispatchEvent(new Event("seeked"));
    expect(redraw).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
