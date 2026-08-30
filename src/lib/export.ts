/* ============================================================================
   export.ts — what an export IS, worked out with arithmetic only.

   Everything in this file is pure: it takes a project and the user's export
   settings and works out the frame-by-frame shape of the output file. It never
   touches WebCodecs, WebGPU, mp4box or the filesystem — that is
   exportPipeline.ts, which consumes the plan this module produces.

   The split exists so the timing maths can be tested without a GPU: which clip
   is on screen at time T, and which moment of the source file that output frame
   has to come from, are the two questions an editor gets wrong silently.
   ========================================================================== */

import {
  clipLook,
  clipTransform,
  clipTransition,
  type AspectRatio,
  type ClipLook,
  type ClipTransform,
  type ClipTransition,
  type ProjectConfig,
  type Resolution,
  type TimelineClip,
  type TimelineTrack,
} from "./project";

export type FrameRate = ProjectConfig["settings"]["frameRate"];
export type OutputCodecId = "h264" | "vp9" | "av1";
export type QualityId = "draft" | "balanced" | "high";

export interface ExportSettings {
  resolution: Resolution;
  frameRate: FrameRate;
  codec: OutputCodecId;
  quality: QualityId;
}

export interface ClipVisualSettings {
  transform: ClipTransform;
  look: ClipLook;
  transition: ClipTransition;
}

export interface ClipFrameStyle extends ClipVisualSettings {
  /** Opacity after both Look and the transition at this moment are applied. */
  opacity: number;
  /** Horizontal source reveal, used by wipe transitions. */
  revealStart: number;
  revealEnd: number;
}

export const clipVisualSettings = (clip: TimelineClip): ClipVisualSettings => ({
  transform: clipTransform(clip),
  look: clipLook(clip),
  transition: clipTransition(clip),
});

/** Resolve the time-varying part of a clip's visual treatment. */
export function clipFrameStyle(visual: ClipVisualSettings, elapsedMs: number): ClipFrameStyle {
  const transition = visual.transition;
  const progress = transition.type === "cut"
    ? 1
    : Math.max(0, Math.min(1, elapsedMs / transition.durationMs));
  return {
    ...visual,
    opacity: (visual.look.opacity / 100) * (transition.type === "fade" ? progress : 1),
    revealStart: transition.type === "wipe-right" ? 1 - progress : 0,
    revealEnd: transition.type === "wipe-left" ? progress : 1,
  };
}

export interface OutputCodec {
  id: OutputCodecId;
  label: string;
  /** The track codec name mp4-muxer expects. */
  muxer: "avc" | "vp9" | "av1";
  /** Codec strings tried in order against `VideoEncoder.isConfigSupported`. */
  candidates: (width: number, height: number, frameRate: number) => string[];
  detail: string;
}

/* H.264 levels, as the byte that ends an `avc1.` codec string. The encoder
   rejects a configuration whose level cannot hold the frame size and rate, so
   the level is derived from the actual output rather than hard-coded. */
function avcLevel(width: number, height: number, frameRate: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = macroblocks * frameRate;
  if (macroblocks <= 3600 && rate <= 108_000) return "1f"; // 3.1
  if (macroblocks <= 8192 && rate <= 245_760) return "28"; // 4.0
  if (macroblocks <= 8704 && rate <= 522_240) return "2a"; // 4.2
  if (macroblocks <= 22_080 && rate <= 589_824) return "33"; // 5.1
  return "34"; // 5.2
}

export const OUTPUT_CODECS: readonly OutputCodec[] = [
  {
    id: "h264",
    label: "H.264 / AVC",
    muxer: "avc",
    /* High, then Main, then Baseline at the same level. Hardware encoders
       differ on which profiles they expose, so the first one this machine
       actually accepts is the one used — never a guess. */
    candidates: (width, height, frameRate) => {
      const level = avcLevel(width, height, frameRate);
      return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.4200${level}`];
    },
    detail: "Plays everywhere. The baseline choice for an .mp4.",
  },
  {
    id: "vp9",
    label: "VP9",
    muxer: "vp9",
    candidates: () => ["vp09.00.10.08"],
    detail: "Smaller files at the same quality; not every player reads VP9 inside .mp4.",
  },
  {
    id: "av1",
    label: "AV1",
    muxer: "av1",
    candidates: () => ["av01.0.08M.08", "av01.0.04M.08"],
    detail: "Newest codec, smallest files, slowest to encode and least widely supported.",
  },
];

export function outputCodec(id: OutputCodecId): OutputCodec {
  const codec = OUTPUT_CODECS.find((candidate) => candidate.id === id);
  if (!codec) throw new Error(`Unknown output codec: ${id}`);
  return codec;
}

export interface QualityPreset {
  id: QualityId;
  label: string;
  /** Bits spent per pixel per frame. Bitrate is derived, never typed in. */
  bitsPerPixel: number;
  detail: string;
}

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  { id: "draft", label: "Draft", bitsPerPixel: 0.04, detail: "Fastest and smallest. Visible compression in motion." },
  { id: "balanced", label: "Balanced", bitsPerPixel: 0.09, detail: "The usual choice for a delivery file." },
  { id: "high", label: "High", bitsPerPixel: 0.16, detail: "Large files. Keeps detail in grain and fast motion." },
];

export function qualityPreset(id: QualityId): QualityPreset {
  const preset = QUALITY_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) throw new Error(`Unknown quality preset: ${id}`);
  return preset;
}

/* Every frame size the app knows, written out rather than derived.

   The resolution names the SHORT edge, so one setting means the same height of
   picture in every aspect ratio the project offers: 768p is 1376×768 wide,
   768×1376 tall, 768×768 square and 768×960 at 4:5.

   These are a TABLE and not a formula because the sizes MiniMax H3 generates at
   are not the ones arithmetic would pick. Both edges have to be a multiple of
   32, and the nearest such pair is not the ratio rounded off: 16:9 at 1344 is
   2432×1344, which no expression of 1344 and 16/9 produces. Deriving these
   would mean deriving the wrong numbers precisely.

   So the ratios here are approximate — 736×416 is 1.769 against 16:9's 1.778 —
   and that is the trade the multiple of 32 buys. The four legacy rows keep the
   exact pixels the old short-edge formula produced, because a project saved at
   1080p must open at 1920×1080 and not one pixel else. */
const FRAME_SIZES: Record<Resolution, Record<AspectRatio, readonly [number, number]>> = {
  "416p": { "16:9": [736, 416], "9:16": [416, 736], "1:1": [416, 416], "4:5": [416, 512] },
  "544p": { "16:9": [960, 544], "9:16": [544, 960], "1:1": [544, 544], "4:5": [544, 672] },
  "640p": { "16:9": [1152, 640], "9:16": [640, 1152], "1:1": [640, 640], "4:5": [640, 800] },
  "768p": { "16:9": [1376, 768], "9:16": [768, 1376], "1:1": [768, 768], "4:5": [768, 960] },
  "1088p": { "16:9": [1920, 1088], "9:16": [1088, 1920], "1:1": [1088, 1088], "4:5": [1088, 1376] },
  "1344p": { "16:9": [2432, 1344], "9:16": [1344, 2432], "1:1": [1344, 1344], "4:5": [1344, 1696] },
  // Not offered for a new project; see LEGACY_RESOLUTIONS in project.ts.
  "720p": { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [720, 720], "4:5": [720, 900] },
  "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080], "4:5": [1080, 1350] },
  "4k": { "16:9": [3840, 2160], "9:16": [2160, 3840], "1:1": [2160, 2160], "4:5": [2160, 2700] },
};

export function outputDimensions(resolution: Resolution, aspectRatio: AspectRatio): { width: number; height: number } {
  const [width, height] = FRAME_SIZES[resolution][aspectRatio];
  return { width, height };
}

/** The canvas sent to MiniMax H3. Current project sizes already satisfy the
 * model's 32-pixel grid. Legacy export sizes remain exact on disk and at
 * export, but their generation canvas is expanded to the nearest valid grid. */
export function generationDimensions(resolution: Resolution, aspectRatio: AspectRatio): { width: number; height: number } {
  const { width, height } = outputDimensions(resolution, aspectRatio);
  return {
    width: Math.ceil(width / 32) * 32,
    height: Math.ceil(height / 32) * 32,
  };
}

/** A frame size in the only terms that mean anything to the person choosing it.
 *  Everywhere a resolution is SHOWN uses this rather than the id: "416p" names
 *  the short edge and leaves the other one a guess, and at 16:9 the guess is
 *  wrong by 24 pixels. */
export function resolutionLabel(resolution: Resolution, aspectRatio: AspectRatio): string {
  const { width, height } = outputDimensions(resolution, aspectRatio);
  return `${width} × ${height}`;
}

/** The export starts as the project already describes itself. Nothing here is
 *  invented: resolution and frame rate are the project's own settings. */
export function defaultExportSettings(config: ProjectConfig): ExportSettings {
  return {
    resolution: config.settings.resolution,
    frameRate: config.settings.frameRate,
    codec: "h264",
    quality: "balanced",
  };
}

export function bitrateFor(width: number, height: number, frameRate: number, quality: QualityId): number {
  return Math.round(width * height * frameRate * qualityPreset(quality).bitsPerPixel);
}

/** Bytes the encoder is being ASKED to produce. A rate-controlled encoder lands
 *  near its target rather than on it, so this is labelled an estimate wherever
 *  it is shown. */
export function estimatedBytes(bitrate: number, durationMs: number): number {
  return Math.round((bitrate / 8) * (durationMs / 1000));
}

/* ---------------------------------------------------------------------------
   The plan
   --------------------------------------------------------------------------- */

export type ExportSegment =
  | {
      kind: "clip";
      clipId: string;
      assetId: string;
      label: string;
      /** First output frame index this clip fills. */
      startFrame: number;
      /** One past the last output frame index it fills. */
      endFrame: number;
      /** The clip's own position on the timeline, in ms. */
      clipStartMs: number;
      /** Where inside the source file the clip begins, in ms. */
      clipSourceStartMs: number;
      visual: ClipVisualSettings;
    }
  | { kind: "gap"; startFrame: number; endFrame: number };

/* The shape of the soundtrack, kept here rather than in the pipeline because
   the export PAGE has to be able to state its cost before anything runs.

   48 kHz stereo: the rate every AAC encoder accepts and the one nothing on a
   timeline has to be downsampled to reach. */
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;

/** How much memory the mixed soundtrack occupies while an export runs.
 *
 *  The mix is one Float32 per channel per sample and it is built BEFORE the
 *  muxer opens — an .mp4's track list is fixed the moment the file is created,
 *  so whether there is sound has to be settled first — and then held until the
 *  last video frame has been encoded. That is 23 MB a minute, so a five
 *  minute cut holds 115 MB across the whole render and an hour holds 1.4 GB,
 *  roughly three times that at the peak of mixing while the decoded sources are
 *  still alive. Nobody should meet that number by running out of memory. */
export function audioMixBytes(durationMs: number): number {
  return Math.max(0, Math.floor((durationMs / 1000) * AUDIO_SAMPLE_RATE)) * AUDIO_CHANNELS * 4;
}

/** Where "this is a lot of memory" starts. 200 MB is a little under 15 minutes
 *  of timeline: below it the mix is a rounding error next to the decoded video,
 *  above it it is a number worth reading before pressing Export. */
const AUDIO_MIX_NOTE_BYTES = 200_000_000;

/** One audio clip, as much of it as lands inside the file.
 *
 *  The picture decides how long the file is, so sound past the last frame is
 *  not in it. Rather than dropping such a clip silently or stretching the file
 *  to fit it, the audible part is worked out here and the remainder is reported
 *  as a note the user reads before pressing Export. */
export interface AudioSegment {
  clipId: string;
  assetId: string;
  label: string;
  /** Where this lands in the OUTPUT, in ms from the start of the file. */
  startMs: number;
  /** How much of it lands in the output, in ms. */
  durationMs: number;
  /** Where inside the source file the audible part begins, in ms. */
  sourceStartMs: number;
}

/** Every audio clip's audible part, in timeline order.
 *
 *  Overlaps are NOT resolved here: two clips over the same moment are two
 *  segments, and the mixer sums them, the way a mixing desk does. Silence is
 *  not a segment — a gap is simply a stretch no segment covers. */
export function audioSegments(config: ProjectConfig, durationMs: number): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (const track of config.timeline.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of track.clips) {
      const start = Math.max(0, clip.startMs);
      const end = Math.min(durationMs, clip.startMs + clip.durationMs);
      if (end <= start) continue;
      segments.push({
        clipId: clip.id,
        assetId: clip.assetId,
        label: clip.label,
        startMs: start,
        durationMs: end - start,
        // A clip dragged to a negative start would begin further into its file.
        sourceStartMs: clip.sourceStartMs + (start - clip.startMs),
      });
    }
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

export interface ExportPlan {
  width: number;
  height: number;
  frameRate: FrameRate;
  durationMs: number;
  frameCount: number;
  backgroundColor: string;
  segments: ExportSegment[];
  /** Video clips that contribute at least one frame to the file. */
  clipCount: number;
  /** Frames with nothing over them; they get the project's background colour. */
  gapFrames: number;
  /** Clips on audio tracks, muted tracks included. */
  audioClipCount: number;
  /** The audible part of each one. Empty means the file has no sound, and the
   *  notes say why. */
  audio: AudioSegment[];
  /** Reasons this export cannot run at all. Empty means it can. */
  blockers: string[];
  /** True things about the output the user has to be told before they press go. */
  notes: string[];
}

/** Container formats mp4box can demux today. webm and mkv import fine and play
 *  in the app, but nothing here can take them apart yet, so a clip built on one
 *  blocks the export instead of quietly rendering as background. */
const DEMUXABLE_VIDEO = new Set(["video/mp4", "video/quicktime"]);
const DRAWABLE_IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** The moment output frame `frameIndex` has to be taken from inside the source
 *  file, in milliseconds. This is the whole of the trim maths: an output frame
 *  sits at `frameIndex / frameRate` on the timeline, and the source moment is
 *  that far past the clip's start, offset by where the clip begins in its file. */
export function sourceTimeMsForFrame(
  segment: Extract<ExportSegment, { kind: "clip" }>,
  frameIndex: number,
  frameRate: number,
): number {
  return segment.clipSourceStartMs + ((frameIndex * 1000) / frameRate - segment.clipStartMs);
}

/** The clip a viewer sees at `timeMs`.
 *
 *  Tracks are drawn top to bottom in array order, so the FIRST video track that
 *  has something at this moment wins — an overlay covers the story beneath it.
 *  Within one track two clips can overlap after a drag; the later one is the
 *  more recent edit, so it is the one on top. */
export function visibleClipAt(tracks: TimelineTrack[], timeMs: number): TimelineClip | null {
  for (const track of tracks) {
    if (track.kind !== "video") continue;
    let best: TimelineClip | null = null;
    for (const clip of track.clips) {
      if (timeMs < clip.startMs || timeMs >= clip.startMs + clip.durationMs) continue;
      if (!best || clip.startMs >= best.startMs) best = clip;
    }
    if (best) return best;
  }
  return null;
}

/** Where the picture ends. Audio is not muxed yet, so a soundtrack that runs
 *  past the last shot cannot extend the file — claiming otherwise would promise
 *  frames that do not exist. */
export function videoDurationMs(config: ProjectConfig): number {
  return config.timeline.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
}

export function buildExportPlan(config: ProjectConfig, settings: ExportSettings): ExportPlan {
  const { width, height } = outputDimensions(settings.resolution, config.settings.aspectRatio);
  const frameRate = settings.frameRate;
  const tracks = config.timeline.tracks;
  const videoTracks = tracks.filter((track) => track.kind === "video");
  const durationMs = videoDurationMs(config);
  const frameCount = Math.round((durationMs * frameRate) / 1000);

  /* Resolve every output frame first, then run the identical answers together.
     Deriving segments from clip boundaries instead would disagree with the
     encoder loop the moment two clips overlap. */
  const segments: ExportSegment[] = [];
  let gapFrames = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const clip = visibleClipAt(videoTracks, (frame * 1000) / frameRate);
    const last = segments[segments.length - 1];
    if (!clip) {
      gapFrames += 1;
      if (last && last.kind === "gap") last.endFrame = frame + 1;
      else segments.push({ kind: "gap", startFrame: frame, endFrame: frame + 1 });
      continue;
    }
    if (last && last.kind === "clip" && last.clipId === clip.id) {
      last.endFrame = frame + 1;
      continue;
    }
    segments.push({
      kind: "clip",
      clipId: clip.id,
      assetId: clip.assetId,
      label: clip.label,
      startFrame: frame,
      endFrame: frame + 1,
      clipStartMs: clip.startMs,
      clipSourceStartMs: clip.sourceStartMs,
      visual: clipVisualSettings(clip),
    });
  }

  const usedClipIds = new Set(segments.flatMap((segment) => (segment.kind === "clip" ? [segment.clipId] : [])));
  const audioClipCount = tracks
    .filter((track) => track.kind === "audio")
    .reduce((total, track) => total + track.clips.length, 0);

  const blockers: string[] = [];
  if (frameCount === 0) {
    blockers.push("There are no video clips on the timeline, so there is nothing to render.");
  }
  const missing: string[] = [];
  const locationless: string[] = [];
  const undecodable: string[] = [];
  for (const segment of segments) {
    if (segment.kind !== "clip") continue;
    const asset = config.assets.find((candidate) => candidate.id === segment.assetId);
    if (!asset) {
      missing.push(segment.label);
      continue;
    }
    /* An asset carries EITHER a path inside the project or an absolute one
       outside it — imported video and audio are never copied in, so they only
       ever have the second. Neither means there is no file to read, and the run
       would die on the first frame; say so here, where the button still is. */
    if (!asset.relativePath && !asset.sourcePath) {
      locationless.push(`${segment.label} (${asset.name})`);
    }
    const drawable = DEMUXABLE_VIDEO.has(asset.mimeType) || DRAWABLE_IMAGE.has(asset.mimeType);
    if (!drawable) undecodable.push(`${segment.label} (${asset.name}, ${asset.mimeType})`);
  }
  if (missing.length > 0) {
    blockers.push(`These clips point at media that is not in this project: ${missing.join(", ")}.`);
  }
  if (locationless.length > 0) {
    blockers.push(`These clips point at media with no file recorded for it at all: ${locationless.join(", ")}.`);
  }
  if (undecodable.length > 0) {
    blockers.push(
      `PolStudio can only take apart .mp4 and .mov video and still images so far. These clips use something else: ${undecodable.join(", ")}.`,
    );
  }

  const audio = audioSegments(config, durationMs);
  const notes: string[] = [];
  if (audio.length > 0) {
    const overlapping = audio.filter((segment, index) =>
      audio.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          other.startMs < segment.startMs + segment.durationMs &&
          segment.startMs < other.startMs + other.durationMs,
      ),
    ).length;
    notes.push(
      `${audio.length} audio ${audio.length === 1 ? "clip is" : "clips are"} mixed into an AAC track${
        overlapping > 0 ? `, ${overlapping} of them overlapping — overlaps are summed, as on a mixing desk` : ""
      }. Anything no clip covers is silence.`,
    );
  }
  /* The mix is held whole, in memory, for the length of the render. On a short
     cut that is not worth a sentence; on a long one it is the thing most likely
     to end the export, and it was not being said anywhere. */
  const mixBytes = audioMixBytes(durationMs);
  if (audio.length > 0 && mixBytes >= AUDIO_MIX_NOTE_BYTES) {
    notes.push(
      `The whole soundtrack is mixed in memory before the file is opened and held until the last frame: about ${formatBytes(mixBytes)} for ${formatDuration(durationMs)}, and roughly three times that at the moment of mixing while the source files are still decoded.`,
    );
  }
  /* Audio the file cannot hold, counted rather than dropped in silence. The
     picture decides the length; sound past the last frame has nowhere to go. */
  const audible = new Set(audio.map((segment) => segment.clipId));
  const beyondPicture = tracks
    .filter((track) => track.kind === "audio" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((clip) => !audible.has(clip.id)).length;
  if (beyondPicture > 0) {
    notes.push(
      `${beyondPicture} audio ${beyondPicture === 1 ? "clip starts" : "clips start"} after the last video frame, so ${beyondPicture === 1 ? "it is" : "they are"} not in the file: the picture decides how long it is.`,
    );
  }
  const trimmed = audio.filter((segment) => segment.startMs + segment.durationMs >= durationMs).length;
  if (trimmed > 0 && durationMs > 0) {
    notes.push(
      `The sound stops with the picture at ${formatDuration(durationMs)}, where ${trimmed === 1 ? "one clip is" : `${trimmed} clips are`} cut off.`,
    );
  }
  const mutedClips = tracks
    .filter((track) => track.kind === "audio" && track.muted)
    .reduce((total, track) => total + track.clips.length, 0);
  if (mutedClips > 0) {
    notes.push(`${mutedClips} audio ${mutedClips === 1 ? "clip is" : "clips are"} on a muted track and will not be heard.`);
  }
  if (gapFrames > 0) {
    notes.push(
      `${gapFrames} of ${frameCount} frames have no clip over them and will be solid ${config.settings.backgroundColor}.`,
    );
  }
  const unusedClips = videoTracks
    .flatMap((track) => track.clips)
    .filter((clip) => !usedClipIds.has(clip.id));
  if (unusedClips.length > 0) {
    notes.push(
      `${unusedClips.length} video ${unusedClips.length === 1 ? "clip is" : "clips are"} hidden underneath another track and will not appear.`,
    );
  }

  return {
    width,
    height,
    frameRate,
    durationMs,
    frameCount,
    backgroundColor: config.settings.backgroundColor,
    segments,
    clipCount: usedClipIds.size,
    gapFrames,
    audioClipCount,
    audio,
    blockers,
    notes,
  };
}

/* ---------------------------------------------------------------------------
   Geometry shared by the preview and the compositor
   --------------------------------------------------------------------------- */

export interface FittedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The source frame, scaled to fit inside the output and centred. Nothing is
 *  cropped; whatever is left over is background. The preview and the export
 *  compositor both call this, so what you see is the frame you get. */
export function fitRect(sourceWidth: number, sourceHeight: number, outWidth: number, outHeight: number): FittedRect {
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width: outWidth, height: outHeight };
  const scale = Math.min(outWidth / sourceWidth, outHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (outWidth - width) / 2, y: (outHeight - height) / 2, width, height };
}

/* ---------------------------------------------------------------------------
   Formatting
   --------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** mm:ss.mmm — an editor needs the fraction, and hours would be noise for a
 *  timeline measured in seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** A file name the OS will accept, derived from the project's own name. */
export function suggestedFileName(projectName: string): string {
  const cleaned = projectName
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleaned || "PolStudio export"}.mp4`;
}
