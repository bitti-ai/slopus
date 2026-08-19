import { Image as ImageIcon, Music2, TriangleAlert, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import type { ProjectAsset } from "../../lib/project";

/* A real picture of the media, not a striped placeholder — and, from the same
 * decode, the file's real length and size.
 *
 * Project files live outside the webview's reach, so the bytes come back
 * through a Tauri command as a blob URL. That blob is the whole file — a
 * 300 MB clip is 300 MB of memory — so it is decoded ONCE, drawn into a small
 * canvas, and revoked immediately. What survives is a ~320px JPEG data URL,
 * which is what the panel actually shows.
 *
 * The same <video> that gives up the frame already knows `duration`,
 * `videoWidth`, and `videoHeight`, so measuring the asset costs nothing beyond
 * the read this component was already doing. Nothing else in PolStudio has
 * decoded these files yet, so this is where an imported asset stops being
 * `durationMs: null` and becomes a number — and a clip dropped from it stops
 * being a stand-in five seconds long.
 *
 * No FFmpeg and no WebCodecs here on purpose: the <video> element already owns
 * a hardware decoder, and one still frame is all this needs. */

const THUMB_WIDTH = 320;
/* Frame zero of a shot that fades in is a black rectangle, which reads as a
   broken thumbnail. Half a second in is past the fade and still cheap to seek. */
const POSTER_TIME_SECONDS = 0.5;

/* Switching panel tabs unmounts these, and re-decoding a folder of video every
   time would be felt. Bounded, because a data URL is small but not free. */
const POSTER_CACHE = new Map<string, string>();
const CACHE_LIMIT = 64;
/* Files the browser opened but could tell us nothing about — a stream with no
   declared duration, a container it half-understands. Without this the asset
   stays unmeasured, "unmeasured" reads as "try again", and every remount reads
   the whole file back for the same silence. */
const UNMEASURABLE = new Set<string>();

/** What the webview actually measured. A field is null when it was not
 *  measured — never a plausible stand-in. Milliseconds and pixels. */
export interface MeasuredMedia {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

const NOTHING_MEASURED: MeasuredMedia = { durationMs: null, width: null, height: null };
const measuredSomething = (measured: MeasuredMedia) =>
  measured.durationMs !== null || measured.width !== null || measured.height !== null;

/* A media element reports `duration` as NaN before metadata arrives and
   Infinity for a live or unseekable stream. Neither is a length. */
const durationMsOf = (element: HTMLMediaElement): number | null =>
  Number.isFinite(element.duration) && element.duration > 0 ? Math.round(element.duration * 1000) : null;

const pixelsOf = (value: number): number | null => (Number.isFinite(value) && value > 0 ? value : null);

function cachePoster(key: string, poster: string) {
  if (POSTER_CACHE.size >= CACHE_LIMIT) {
    const oldest = POSTER_CACHE.keys().next().value;
    if (oldest !== undefined) POSTER_CACHE.delete(oldest);
  }
  POSTER_CACHE.set(key, poster);
}

function drawPoster(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error("The frame has no size.");
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, THUMB_WIDTH / width);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This computer gave no 2D canvas.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

const settled = (element: HTMLMediaElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    element.addEventListener(event, () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error("This file could not be decoded.")), { once: true });
  });

async function videoPoster(url: string): Promise<{ poster: string; measured: MeasuredMedia }> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  await settled(video, "loadeddata");
  // Read the numbers before the seek: this is the one moment the whole file is
  // open, and a failed seek must not cost the measurement too.
  const measured: MeasuredMedia = {
    durationMs: durationMsOf(video),
    width: pixelsOf(video.videoWidth),
    height: pixelsOf(video.videoHeight),
  };
  const target = Number.isFinite(video.duration) ? Math.min(video.duration / 2, POSTER_TIME_SECONDS) : 0;
  // A seek that never lands would leave the thumbnail loading forever; frame
  // zero is a perfectly good fallback, so a failure here is not fatal.
  if (target > 0) {
    const seeked = settled(video, "seeked");
    video.currentTime = target;
    await seeked.catch(() => undefined);
  }
  const poster = drawPoster(video, video.videoWidth, video.videoHeight);
  // Detach the source so the decoder and the blob are released now.
  video.removeAttribute("src");
  video.load();
  return { poster, measured };
}

async function imagePoster(url: string): Promise<{ poster: string; measured: MeasuredMedia }> {
  const image = new Image();
  image.src = url;
  await image.decode();
  // A still has a size and no length. Leaving durationMs null is the whole
  // point: how long a still is on screen is the cut's decision, not the file's.
  return {
    poster: drawPoster(image, image.naturalWidth, image.naturalHeight),
    measured: { durationMs: null, width: pixelsOf(image.naturalWidth), height: pixelsOf(image.naturalHeight) },
  };
}

/* Sound has no picture to draw, but it has the length the timeline needs, and
   `preload="metadata"` is enough to read it. */
async function measureAudio(url: string): Promise<MeasuredMedia> {
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = url;
  await settled(audio, "loadedmetadata");
  const measured: MeasuredMedia = { durationMs: durationMsOf(audio), width: null, height: null };
  audio.removeAttribute("src");
  audio.load();
  return measured;
}

/** Whether this asset still has something worth measuring. A still never gets
 *  a duration, so asking for one forever would re-read the file on every
 *  mount; sound never gets a size. */
const wantsMeasuring = (asset: ProjectAsset) =>
  asset.kind === "image" ? !asset.width || !asset.height : !asset.durationMs;

export function MediaThumbnail({ folderPath, asset, onMeasured }: {
  folderPath: string;
  asset: ProjectAsset;
  /** Called once with whatever the decode could measure, so the project can
   *  record the file's real length instead of carrying nulls. Omit it and this
   *  component only draws. */
  onMeasured?: (measured: MeasuredMedia) => void;
}) {
  const cacheKey = `${folderPath}::${asset.sourcePath ?? asset.relativePath}`;
  const [poster, setPoster] = useState<string | null>(() => POSTER_CACHE.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);
  /* Held in a ref because the parent passes a fresh closure on every render,
     and a callback in the dependency list would re-read the file each time. */
  const report = useRef(onMeasured);
  report.current = onMeasured;

  const needsPoster = asset.kind !== "audio" && !POSTER_CACHE.has(cacheKey);
  const needsMeasuring = Boolean(onMeasured) && !UNMEASURABLE.has(cacheKey) && wantsMeasuring(asset);

  useEffect(() => {
    // Nothing to draw and nothing left to learn: sound has no picture, a cached
    // poster is already the answer, and a measured asset stays measured.
    if (!needsPoster && !needsMeasuring) return;
    let live = true;
    setFailed(false);
    void (async () => {
      let url: string | null = null;
      try {
        url = await readMediaFileUrl(folderPath, { relativePath: asset.relativePath, sourcePath: asset.sourcePath }, asset.mimeType);
        // Browser preview: there is no project folder, so there is nothing to
        // show and nothing has gone wrong. The kind icon stands in.
        if (!url) return;
        let measured = NOTHING_MEASURED;
        if (asset.kind === "audio") {
          measured = await measureAudio(url);
        } else {
          const value = asset.kind === "image" ? await imagePoster(url) : await videoPoster(url);
          cachePoster(cacheKey, value.poster);
          measured = value.measured;
          if (live) setPoster(value.poster);
        }
        // Only ever hand up numbers something read off the file. When the file
        // gave none, remember that rather than reading it again next mount.
        if (measuredSomething(measured)) report.current?.(measured);
        else UNMEASURABLE.add(cacheKey);
      } catch {
        UNMEASURABLE.add(cacheKey);
        if (live) setFailed(true);
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    })();
    return () => { live = false; };
  }, [cacheKey, folderPath, asset.relativePath, asset.sourcePath, asset.mimeType, asset.kind, needsPoster, needsMeasuring]);

  if (poster) {
    return <span className="media-thumb media-thumb--poster">
      <img src={poster} alt={`First frames of ${asset.name}`} loading="lazy" />
    </span>;
  }
  /* Three states, said plainly: sound never has a picture, a file the project
     points at but cannot read is a problem worth seeing, and everything else
     is the placeholder that was always here. */
  const icon = asset.kind === "audio" ? <Music2 size={22} />
    : failed ? <TriangleAlert size={22} />
      : asset.kind === "image" ? <ImageIcon size={22} /> : <Video size={22} />;
  return <span
    className="media-thumb"
    role="img"
    aria-label={failed ? `${asset.name} — preview unavailable` : asset.name}
    title={failed ? "PolStudio couldn’t read this file to make a preview." : undefined}
  >{icon}</span>;
}
