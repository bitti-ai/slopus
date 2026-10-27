import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { musicExportSongs, musicExportSupport, runMusicExport, type RunMusicExportOptions } from "./musicExport";
import { readMediaFileBytes } from "./persistence";
import { createProjectConfig } from "./project";
import { newSong } from "./music";
import { ExportCancelled } from "./exportPipeline";

vi.mock("./persistence", () => ({ readMediaFileBytes: vi.fn(async () => new ArrayBuffer(1)) }));
const frames = 20000;
const channels = [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(-0.5)];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("OfflineAudioContext", class { async decodeAudioData() { return { length: frames, sampleRate: 48000, numberOfChannels: 2, getChannelData: (index: number) => channels[index] }; } });
});
afterEach(() => vi.unstubAllGlobals());
const options = (): RunMusicExportOptions => ({ folderPath: "D:/Music", asset: { id: "audio", kind: "audio", name: "Song", mimeType: "audio/wav", relativePath: "media/song.wav", createdAt: "now" },
  title: "Song", settings: { format: "wav", bitrate: 192000 }, cancelled: () => false, onProgress: vi.fn() });

it("exports real stereo PCM WAV with complete samples and a valid header", async () => {
  const request = options();
  const bytes = await runMusicExport(request);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => new TextDecoder().decode(bytes.subarray(at, at + 4));
  expect(tag(0)).toBe("RIFF"); expect(tag(8)).toBe("WAVE");
  expect(data.getUint32(4, true)).toBe(bytes.length - 8);
  let format = false, samples = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const length = data.getUint32(at + 4, true), start = at + 8;
    if (tag(at) === "fmt ") {
      format = true;
      expect(data.getUint16(start, true)).toBe(1);
      expect(data.getUint16(start + 2, true)).toBe(2);
      expect(data.getUint32(start + 4, true)).toBe(48000);
      expect(data.getUint16(start + 14, true)).toBe(16);
    }
    if (tag(at) === "data") {
      samples = true; expect(length).toBe(frames * 4);
      expect(data.getInt16(start, true)).toBeCloseTo(8192, -1);
      expect(data.getInt16(start + 2, true)).toBeCloseTo(-16384, -1);
      expect(data.getInt16(start + length - 2, true)).toBeCloseTo(-16384, -1);
    }
    at = start + length + (length % 2);
  }
  expect(format && samples).toBe(true);
  expect(request.onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: "finishing", framesDone: frames }));
});

it("probes native encoding support at the selected bitrate and rejects unavailable compressed formats", async () => {
  vi.stubGlobal("AudioData", class {});
  const support = vi.fn(async (config: AudioEncoderConfig) => ({ supported: config.codec === "opus" && config.bitrate === 192000 }));
  vi.stubGlobal("AudioEncoder", class { static isConfigSupported = support; });
  expect(await musicExportSupport("m4a", 192000)).toBe(false);
  expect(await musicExportSupport("webm", 192000)).toBe(true);
  expect(await musicExportSupport("ogg", 192000)).toBe(true);
  expect(await musicExportSupport("webm", 320000)).toBe(false);
  expect(await musicExportSupport("wav", 192000)).toBe(true);
  expect(support).toHaveBeenCalledWith({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 });
  await expect(runMusicExport({ ...options(), settings: { format: "m4a", bitrate: 192000 } })).rejects.toThrow(/cannot be encoded/);
  expect(readMediaFileBytes).not.toHaveBeenCalled();
});

it.each(["mp3", "flac"] as const)("encodes real %s with the bundled fallback when WebCodecs is unavailable", async (format) => {
  vi.stubGlobal("AudioEncoder", undefined); vi.stubGlobal("AudioData", undefined);
  expect(await musicExportSupport(format, 192000)).toBe(true);
  const bytes = await runMusicExport({ ...options(), settings: { format, bitrate: 192000 } });
  const { Input, BufferSource, ALL_FORMATS } = await import("mediabunny");
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    expect(await track?.getCodec()).toBe(format);
    expect(track?.numberOfChannels).toBe(2);
    expect(track?.sampleRate).toBe(48000);
    expect(await input.computeDuration()).toBeCloseTo(frames / 48000, 1);
    if (format === "flac") expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("fLaC");
  } finally { input.dispose(); }
});

it.each(["wav", "mp3", "flac"] as const)("cancels %s before reading and during encoding without returning a partial file", async (format) => {
  const request = { ...options(), settings: { format, bitrate: 192000 } };
  await expect(runMusicExport({ ...request, cancelled: () => true })).rejects.toBeInstanceOf(ExportCancelled);
  expect(readMediaFileBytes).not.toHaveBeenCalled();
  let cancelled = false;
  await expect(runMusicExport({ ...request, cancelled: () => cancelled, onProgress: (progress) => { if (progress.phase === "rendering") cancelled = true; } })).rejects.toBeInstanceOf(ExportCancelled);
});

it("lists generated songs across folders, excluding drafts and missing audio", () => {
  const config = createProjectConfig({ name: "Music", prompt: "", aspectRatio: "16:9", resolution: "416p", targetDurationSeconds: 30 });
  const song = { ...newSong("yue2", 32, "jazz"), title: "Evening", assetId: "audio" };
  config.musicFolders = [{ id: "jazz", name: "Jazz" }];
  config.musicSongs = [newSong(), song, { ...newSong(), assetId: "missing", status: "completed" }];
  config.assets = [options().asset];
  expect(musicExportSongs(config)).toEqual([{ song, asset: config.assets[0], label: "Jazz / Evening" }]);
});
