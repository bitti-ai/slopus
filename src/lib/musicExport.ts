import type { AudioCodec } from "mediabunny";
import type { ProjectAsset, ProjectConfig } from "./project";
import { musicFolderLabel } from "./music";
import { readMediaFileBytes } from "./persistence";
import { ExportCancelled, type ExportProgress } from "./exportPipeline";
import { finishCodec } from "./codecWait";

export type MusicExportFormat = "m4a" | "webm" | "ogg" | "wav" | "mp3" | "flac";
export interface MusicExportSettings { format: MusicExportFormat; bitrate: number }
export const MUSIC_EXPORT_FORMATS: readonly { value: MusicExportFormat; label: string; codec: AudioCodec; nativeCodec?: string }[] = [
  { value: "mp3", label: "MP3", codec: "mp3" },
  { value: "flac", label: "FLAC · Lossless", codec: "flac" },
  { value: "m4a", label: "M4A · AAC", codec: "aac", nativeCodec: "mp4a.40.2" },
  { value: "webm", label: "WebM · Opus", codec: "opus", nativeCodec: "opus" },
  { value: "ogg", label: "Ogg · Opus", codec: "opus", nativeCodec: "opus" },
  { value: "wav", label: "WAV · 16-bit PCM", codec: "pcm-s16" },
];
export const MUSIC_EXPORT_BITRATES = [96, 128, 192, 256, 320].map((value) => ({ value: String(value * 1000), label: `${value} kbps` }));
export const MUSIC_EXPORT_SAMPLE_RATE = 48_000;
export const musicExportUsesBitrate = (format: MusicExportFormat) => format !== "wav" && format !== "flac";

const encoders = new Map<"mp3" | "flac", Promise<void>>();
function registerMusicEncoder(codec: "mp3" | "flac") {
  let pending = encoders.get(codec);
  if (!pending) {
    pending = (codec === "mp3"
      ? import("@mediabunny/mp3-encoder").then(({ registerMp3Encoder }) => registerMp3Encoder())
      : import("@mediabunny/flac-encoder").then(({ registerFlacEncoder }) => registerFlacEncoder()))
      .catch((reason) => { encoders.delete(codec); throw reason; });
    encoders.set(codec, pending);
  }
  return pending;
}

export function musicExportSongs(config: ProjectConfig) {
  return (config.musicSongs ?? []).flatMap((song) => {
    const asset = config.assets.find((asset) => asset.id === song.assetId && asset.kind === "audio" && asset.relativePath);
    if (!asset) return [];
    const folder = song.folderId ? musicFolderLabel(config.musicFolders ?? [], song.folderId) : "";
    return [{ song, asset, label: folder ? `${folder} / ${song.title}` : song.title }];
  });
}

/** Probe encoding, not decoding: a playable codec need not be exportable. */
export async function musicExportSupport(format: MusicExportFormat, bitrate: number, channels = 2): Promise<boolean> {
  const choice = MUSIC_EXPORT_FORMATS.find((item) => item.value === format);
  if (!choice || typeof OfflineAudioContext === "undefined") return false;
  if (choice.codec === "mp3" || choice.codec === "flac") {
    try {
      const { canEncodeAudio, Quality } = await import("mediabunny");
      const options = { sampleRate: MUSIC_EXPORT_SAMPLE_RATE, numberOfChannels: channels,
        ...(choice.codec === "mp3" ? { quality: new Quality({ bitrate }) } : {}) };
      if (await canEncodeAudio(choice.codec, options)) return true;
      await registerMusicEncoder(choice.codec);
      return await canEncodeAudio(choice.codec, options);
    } catch { return false; }
  }
  if (!choice.nativeCodec) return true;
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined") return false;
  try {
    return Boolean((await AudioEncoder.isConfigSupported({ codec: choice.nativeCodec, sampleRate: MUSIC_EXPORT_SAMPLE_RATE,
      numberOfChannels: channels, bitrate })).supported);
  } catch { return false; }
}

export interface RunMusicExportOptions {
  folderPath: string; asset: ProjectAsset; title: string; settings: MusicExportSettings;
  cancelled: () => boolean; onProgress: (progress: ExportProgress) => void;
}

export async function runMusicExport(options: RunMusicExportOptions): Promise<Uint8Array> {
  const check = () => { if (options.cancelled()) throw new ExportCancelled(); };
  check();
  if (musicExportUsesBitrate(options.settings.format) && !MUSIC_EXPORT_BITRATES.some((item) => Number(item.value) === options.settings.bitrate)) throw new Error("Choose a supported music bitrate.");
  const choice = MUSIC_EXPORT_FORMATS.find((item) => item.value === options.settings.format);
  if (!choice || !await musicExportSupport(choice.value, options.settings.bitrate)) throw new Error("This audio format cannot be encoded on this device. Choose another format.");
  options.onProgress({ phase: "preparing", framesDone: 0, frameCount: 1, detail: "Reading song…" });
  const bytes = await readMediaFileBytes(options.folderPath, options.asset);
  check();
  options.onProgress({ phase: "mixing", framesDone: 0, frameCount: 1, detail: "Decoding audio…" });
  // Web Audio resamples to 48 kHz. This matches Opus's output clock and keeps
  // support probing and encoding on the same sample rate for every format.
  let decoded = await new OfflineAudioContext(2, 1, MUSIC_EXPORT_SAMPLE_RATE).decodeAudioData(bytes);
  check();
  if (!decoded.length) throw new Error("The song contains no audio samples.");
  if (decoded.numberOfChannels > 2) {
    const context = new OfflineAudioContext(2, decoded.length, decoded.sampleRate);
    const source = context.createBufferSource(); source.buffer = decoded; source.connect(context.destination); source.start();
    decoded = await context.startRendering();
    check();
  }
  if (!await musicExportSupport(choice.value, options.settings.bitrate, decoded.numberOfChannels)) throw new Error("This audio format cannot encode the song's channels. Choose another format.");
  const { Output, BufferTarget, Mp3OutputFormat, FlacOutputFormat, Mp4OutputFormat, WebMOutputFormat, OggOutputFormat, WavOutputFormat, AudioSampleSource, AudioSample, Quality } = await import("mediabunny");
  check();
  const format = choice.value === "m4a" ? new Mp4OutputFormat({ fastStart: "in-memory" })
    : choice.value === "webm" ? new WebMOutputFormat() : choice.value === "ogg" ? new OggOutputFormat()
      : choice.value === "mp3" ? new Mp3OutputFormat() : choice.value === "flac" ? new FlacOutputFormat() : new WavOutputFormat();
  const output = new Output({ format, target: new BufferTarget() });
  let packets = 0;
  const source = new AudioSampleSource({ codec: choice.codec, ...(musicExportUsesBitrate(choice.value) ? { quality: new Quality({ bitrate: options.settings.bitrate }) } : {}), onEncodedPacket: () => { packets++; } });
  output.addAudioTrack(source, { name: options.title });
  output.setMetadataTags({ title: options.title });
  const waiting = { stage: "Music encoding", check, progress: () => packets };
  try {
    await output.start();
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const block = 16_384;
    for (let offset = 0; offset < decoded.length; offset += block) {
      check();
      const count = Math.min(block, decoded.length - offset);
      const planar = new Float32Array(count * channels.length);
      channels.forEach((channel, index) => planar.set(channel.subarray(offset, offset + count), index * count));
      const sample = new AudioSample({ format: "f32-planar", sampleRate: decoded.sampleRate, numberOfChannels: channels.length,
        timestamp: offset / decoded.sampleRate, data: planar });
      try { await finishCodec(source.add(sample), waiting); } finally { sample.close(); }
      options.onProgress({ phase: "rendering", framesDone: offset + count, frameCount: decoded.length, detail: `Encoding ${choice.label}…` });
      // PCM encoding may resolve synchronously; yield for progress and Cancel.
      if (offset % (block * 8) === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    check();
    source.close();
    options.onProgress({ phase: "finishing", framesDone: decoded.length, frameCount: decoded.length, detail: "Finishing audio file…" });
    await finishCodec(output.finalize(), waiting);
    check();
    if (!output.target.buffer?.byteLength) throw new Error("Audio export produced no data.");
    return new Uint8Array(output.target.buffer);
  } catch (reason) {
    await output.cancel().catch(() => undefined);
    throw reason;
  }
}
