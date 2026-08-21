// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseRendered, renderedSummary, saveGeneratedScene } from "./generatedVideo";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invoked = vi.mocked(invoke);
const scope = globalThis as unknown as Record<string, unknown>;

/** A render waiting in Rust's memory, as `generated_summary` reports it. */
const summary = (over: Record<string, unknown> = {}) => ({
  jobId: "job-01", width: 1344, height: 768, frameCount: 120, fps: 24,
  audioChannels: 2, audioSampleRate: 48_000, audioSamples: 480_000, ...over,
});

const desktop = () => { scope.__TAURI_INTERNALS__ = {}; };

beforeEach(() => {
  invoked.mockReset();
  delete scope.__TAURI_INTERNALS__;
  delete scope.VideoEncoder;
  delete scope.VideoFrame;
});
afterEach(() => {
  delete scope.__TAURI_INTERNALS__;
  delete scope.VideoEncoder;
  delete scope.VideoFrame;
});

/* jsdom has no WebCodecs, so nothing here encodes anything — and that is
   exactly the half worth pinning in a test. What a save does BEFORE the
   encoder is where it can be wrong in ways that cost the user a render: asking
   the wrong side of the app, keeping hold of half a gigabyte of frames after a
   failure, or reporting a file that was never written. */
describe("saving a rendered scene", () => {
  it("cannot save from the browser preview, and says which half is missing", async () => {
    await expect(saveGeneratedScene({ folderPath: "/p", jobId: "job-01" })).rejects.toThrow(/desktop app/);
    expect(invoked).not.toHaveBeenCalled();
  });

  it("says a webview with no encoder cannot make a video file", async () => {
    desktop();
    await expect(saveGeneratedScene({ folderPath: "/p", jobId: "job-01" })).rejects.toThrow(/no WebCodecs VideoEncoder/);
    // Nothing was asked of Rust: there is no point pulling frames that cannot
    // be encoded.
    expect(invoked).not.toHaveBeenCalled();
  });

  it("says when the frames are gone rather than writing an empty file", async () => {
    desktop();
    scope.VideoEncoder = class {};
    scope.VideoFrame = class {};
    invoked.mockResolvedValueOnce(null);
    await expect(saveGeneratedScene({ folderPath: "/p", jobId: "job-01" })).rejects.toThrow(/no longer in memory/);
    expect(invoked).toHaveBeenCalledWith("generated_summary", { jobId: "job-01" });
  });

  it("hands the frames back even when the encode never starts", async () => {
    desktop();
    /* An encoder that refuses every configuration. Hundreds of megabytes are
       waiting in Rust at this point, and a save that gives up without
       releasing them leaks the lot for the life of the app. */
    scope.VideoEncoder = { isConfigSupported: async () => ({ supported: false }) };
    scope.VideoFrame = class {};
    invoked.mockImplementation(async (command: string) => (command === "generated_summary" ? summary() : true));
    await expect(saveGeneratedScene({ folderPath: "/p", jobId: "job-01" })).rejects.toThrow(/refused every H.264/);
    expect(invoked).toHaveBeenCalledWith("release_generated_frames", { jobId: "job-01" });
  });

  it("refuses a render with no pictures in it", async () => {
    desktop();
    scope.VideoEncoder = class {};
    scope.VideoFrame = class {};
    invoked.mockResolvedValueOnce(summary({ frameCount: 0 }));
    await expect(saveGeneratedScene({ folderPath: "/p", jobId: "job-01" })).rejects.toThrow(/no pictures/);
  });
});

describe("what the app asks Rust about a render", () => {
  it("reports nothing waiting in the browser preview instead of calling a command that is not there", async () => {
    await expect(renderedSummary("job-01")).resolves.toBeNull();
    await expect(releaseRendered("job-01")).resolves.toBe(false);
    expect(invoked).not.toHaveBeenCalled();
  });

  it("never lets a failed release become a failed save", async () => {
    desktop();
    invoked.mockRejectedValueOnce(new Error("the queue lock is poisoned"));
    await expect(releaseRendered("job-01")).resolves.toBe(false);
  });
});
