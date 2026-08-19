import { Image as ImageIcon, Music2, TriangleAlert, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { readProjectFileUrl } from "../../lib/persistence";
import type { ProjectAsset } from "../../lib/project";

/* A real picture of the media, not a striped placeholder.
 *
 * Project files live outside the webview's reach, so the bytes come back
 * through a Tauri command as a blob URL. That blob is the whole file — a
 * 300 MB clip is 300 MB of memory — so it is decoded ONCE, drawn into a small
 * canvas, and revoked immediately. What survives is a ~320px JPEG data URL,
 * which is what the panel actually shows.
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

const settled = (element: HTMLVideoElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    element.addEventListener(event, () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error("This file could not be decoded.")), { once: true });
  });

async function videoPoster(url: string): Promise<string> {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = url;
  await settled(video, "loadeddata");
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
  return poster;
}

async function imagePoster(url: string): Promise<string> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return drawPoster(image, image.naturalWidth, image.naturalHeight);
}

export function MediaThumbnail({ folderPath, asset }: { folderPath: string; asset: ProjectAsset }) {
  const cacheKey = `${folderPath}::${asset.relativePath}`;
  const [poster, setPoster] = useState<string | null>(() => POSTER_CACHE.get(cacheKey) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Sound has no picture, and a cached poster is already the answer.
    if (asset.kind === "audio" || POSTER_CACHE.has(cacheKey)) return;
    let live = true;
    setFailed(false);
    void (async () => {
      let url: string | null = null;
      try {
        url = await readProjectFileUrl(folderPath, asset.relativePath, asset.mimeType);
        // Browser preview: there is no project folder, so there is nothing to
        // show and nothing has gone wrong. The kind icon stands in.
        if (!url) return;
        const value = asset.kind === "image" ? await imagePoster(url) : await videoPoster(url);
        cachePoster(cacheKey, value);
        if (live) setPoster(value);
      } catch {
        if (live) setFailed(true);
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    })();
    return () => { live = false; };
  }, [cacheKey, folderPath, asset.relativePath, asset.mimeType, asset.kind]);

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
