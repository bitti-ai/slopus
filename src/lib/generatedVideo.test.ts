// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audioSamplesFromIpc, bytesFromIpc, releaseRendered, renderedSummary, resampleInterleaved, saveGeneratedScene } from "./generatedVideo";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const muxed = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  audioChunks: 0,
  videoChunks: 0,
}));
vi.mock("mp4-muxer", () => ({
  ArrayBufferTarget: class { buffer = new Uint8Array([1, 2, 3, 4]).buffer; },
  Muxer: class {
    constructor(config: Record<string, unknown>) { muxed.configs.push(config); }
    addVideoChunk() { muxed.videoChunks += 1; }
    addAudioChunk() { muxed.audioChunks += 1; }
    finalize() { /* the fake target already owns its test bytes */ }
  },
}));

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
  muxed.configs.length = 0;
  muxed.audioChunks = 0;
  muxed.videoChunks = 0;
  delete scope.__TAURI_INTERNALS__;
  delete scope.VideoEncoder;
  delete scope.VideoFrame;
  delete scope.AudioEncoder;
  delete scope.AudioData;
});
afterEach(() => {
  delete scope.__TAURI_INTERNALS__;
  delete scope.VideoEncoder;
  delete scope.VideoFrame;
  delete scope.AudioEncoder;
  delete scope.AudioData;
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

describe("generated audio at the Rust/webview boundary", () => {
  it("reads raw response bytes as little-endian float samples, not as byte-valued samples", () => {
    const original = new Float32Array([0.25, -0.5, 0.75, -1]);
    const rawBytes = Array.from(new Uint8Array(original.buffer));
    expect(Array.from(audioSamplesFromIpc(rawBytes, 4))).toEqual(Array.from(original));
  });

  it("keeps the exact window of an IPC byte view", () => {
    const backing = new Uint8Array([99, 1, 2, 3, 4, 88]);
    expect(Array.from(bytesFromIpc(backing.subarray(1, 5)))).toEqual([1, 2, 3, 4]);
  });

  it("refuses a truncated or mismatched PCM body", () => {
    expect(() => audioSamplesFromIpc([0, 0, 0], 1)).toThrow(/whole 32-bit PCM/);
    expect(() => audioSamplesFromIpc([0, 0, 0, 0], 2)).toThrow(/promised 2 audio samples/);
  });

  it("resamples every interleaved channel without crossing channel boundaries", () => {
    const stereo = new Float32Array([0, 10, 1, 11, 2, 12]);
    expect(Array.from(resampleInterleaved(stereo, 2, 3, 6))).toEqual([
      0, 10,
      0.5, 10.5,
      1, 11,
      1.5, 11.5,
      2, 12,
      2, 12,
    ]);
  });

  it("still saves the pictures when this webview cannot encode AAC", async () => {
    desktop();

    class FakeVideoFrame { close() { /* owned by the test */ } }
    class FakeVideoEncoder {
      static isConfigSupported = async (config: unknown) => ({ supported: true, config });
      state = "configured";
      encodeQueueSize = 0;
      private output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
      constructor(init: VideoEncoderInit) { this.output = init.output; }
      configure() { /* accepted */ }
      encode() { this.output({} as EncodedVideoChunk); }
      async flush() { /* synchronous fake output */ }
      close() { this.state = "closed"; }
    }
    class FakeAudioEncoder {
      static isConfigSupported = async () => ({ supported: false });
    }
    scope.VideoFrame = FakeVideoFrame;
    scope.VideoEncoder = FakeVideoEncoder;
    scope.AudioData = class {};
    scope.AudioEncoder = FakeAudioEncoder;

    invoked.mockImplementation(async (command: string) => {
      if (command === "generated_summary") return summary({ width: 1, height: 1, frameCount: 1, audioSampleRate: 32_000, audioSamples: 4 });
      if (command === "generated_frame") return [1, 2, 3, 255];
      if (command === "write_generated_video") return { relativePath: "media/generated/job-01.mp4", bytes: 4 };
      return true;
    });

    await expect(saveGeneratedScene({ folderPath: "C:\\Project", jobId: "job-01" })).resolves.toMatchObject({
      relativePath: "media/generated/job-01.mp4",
      note: expect.stringMatching(/without sound/),
    });
    expect(invoked).not.toHaveBeenCalledWith("generated_audio", expect.anything());
    expect(muxed.configs[0]).not.toHaveProperty("audio");
    expect(muxed.videoChunks).toBe(1);
    expect(invoked).toHaveBeenCalledWith("release_generated_frames", { jobId: "job-01" });
  });

  it("encodes vidfab's interleaved PCM and adds an AAC track to the saved MP4", async () => {
    desktop();
    const audioData: Array<Record<string, unknown>> = [];

    class FakeVideoFrame { close() { /* owned by the test */ } }
    class FakeVideoEncoder {
      static isConfigSupported = async (config: unknown) => ({ supported: true, config });
      state = "configured";
      encodeQueueSize = 0;
      private output: (chunk: EncodedVideoChunk, meta?: EncodedVideoChunkMetadata) => void;
      constructor(init: VideoEncoderInit) { this.output = init.output; }
      configure() { /* accepted */ }
      encode() { this.output({} as EncodedVideoChunk); }
      async flush() { /* synchronous fake output */ }
      close() { this.state = "closed"; }
    }
    class FakeAudioData {
      constructor(init: AudioDataInit) { audioData.push(init as unknown as Record<string, unknown>); }
      close() { /* owned by the test */ }
    }
    class FakeAudioEncoder {
      static isConfigSupported = async (config: unknown) => ({ supported: true, config });
      state = "configured";
      encodeQueueSize = 0;
      private output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => void;
      constructor(init: AudioEncoderInit) { this.output = init.output; }
      configure() { /* accepted */ }
      encode() { this.output({} as EncodedAudioChunk); }
      async flush() { /* synchronous fake output */ }
      close() { this.state = "closed"; }
    }
    scope.VideoFrame = FakeVideoFrame;
    scope.VideoEncoder = FakeVideoEncoder;
    scope.AudioData = FakeAudioData;
    scope.AudioEncoder = FakeAudioEncoder;

    const pcm = new Float32Array([0.25, -0.5, 0.75, -1]);
    invoked.mockImplementation(async (command: string) => {
      if (command === "generated_summary") return summary({ width: 1, height: 1, frameCount: 1, audioSampleRate: 32_000, audioSamples: pcm.length });
      if (command === "generated_frame") return [1, 2, 3, 255];
      if (command === "generated_audio") return Array.from(new Uint8Array(pcm.buffer));
      if (command === "write_generated_video") return { relativePath: "media/generated/job-01.mp4", bytes: 4 };
      return true;
    });

    await expect(saveGeneratedScene({ folderPath: "C:\\Project", jobId: "job-01" })).resolves.toMatchObject({
      relativePath: "media/generated/job-01.mp4",
      note: null,
    });
    expect(muxed.videoChunks).toBe(1);
    expect(muxed.audioChunks).toBeGreaterThan(0);
    expect(muxed.configs[0]).toMatchObject({ audio: { codec: "aac", numberOfChannels: 2, sampleRate: 32_000 } });
    expect(audioData[0]).toMatchObject({ format: "f32", numberOfChannels: 2, numberOfFrames: 2, sampleRate: 32_000, timestamp: 0 });
    expect(Array.from(audioData[0].data as Float32Array)).toEqual(Array.from(pcm));
    expect(invoked).toHaveBeenCalledWith("release_generated_frames", { jobId: "job-01" });
  });
});
