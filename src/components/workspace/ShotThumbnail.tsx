import { Ban, Clock3, Film, LoaderCircle, Pause, Play, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import { sceneDurationSeconds, type GenerationJob } from "../../lib/project";

/* A real frame of ONE shot, taken from the scene's own video file.
 *
 * A scene is rendered as a single .mp4 in the project folder, and a shot is a
 * span inside it — so the picture of shot 3 is the frame at the moment shot 3
 * begins. Nothing here invents art: before a scene has been rendered there is
 * no frame to show and this says which state it is in instead, the same rule
 * the reference cards and the media thumbs follow.
 *
 * The file is opened ONCE per scene, not once per card. A four-shot scene asks
 * for four frames of the same .mp4, and a component that read the file per
 * thumbnail would pull a few hundred megabytes through the webview four times
 * over. Requests are queued per file: the first one opens it, seeks to every
 * time that is waiting — including ones that arrive while it is open — and
 * hands each card a small JPEG data URL.
 *
 * As in MediaThumbnail, no FFmpeg and no WebCodecs: the <video> element already
 * owns a hardware decoder and one still frame is all this needs. */

// Two physical pixels per typical 320px card keeps posters sharp on high-DPI
// displays without retaining full-resolution render frames in the cache.
const THUMB_WIDTH = 640;
/** How long a seek may take before the frame it was going to draw is given up
 *  on. A seek that neither lands nor errors settles nothing, and awaiting it
 *  would leave every card behind it in the queue spinning for the life of the
 *  panel. */
const SEEK_LIMIT_MS = 4_000;
/** Posters represent the cut itself: every shot card shows the exact frame at
 *  its own startSeconds. */
/** Small JPEGs, but not free. Bounded like MediaThumbnail's own cache. */
const CACHE_LIMIT = 96;
const PLAY_EVENT = "polstudio:play-generated-shot";

/** Drawn frames, keyed by file and time. */
const POSTERS = new Map<string, string>();
/** Files that opened and would not give up a picture, so the next card does not
 *  read the whole thing again for the same silence. */
const UNREADABLE = new Set<string>();
/** Files there is nothing to read — the browser preview has no project folder.
 *  Kept apart from UNREADABLE because that is not a failure to report. */
const ABSENT = new Set<string>();

interface Waiting {
  seconds: number;
  settle: (result: PosterResult) => void;
}

/** Requests still waiting on a file, and the files currently open. */
const QUEUES = new Map<string, Waiting[]>();
const OPEN = new Set<string>();

/** A drawn frame, or the reason there is none. `failed` separates "this file
 *  could not be previewed", which is worth a warning, from "there is no file to
 *  read here", which is not. */
export interface PosterResult {
  poster: string | null;
  failed: boolean;
}

const NOTHING: PosterResult = { poster: null, failed: false };
const BROKEN: PosterResult = { poster: null, failed: true };

const fileKey = (folderPath: string, relativePath: string) => `${folderPath}::${relativePath}`;
const posterKey = (file: string, seconds: number) => `${file}@${seconds.toFixed(2)}`;

function remember(key: string, poster: string) {
  if (POSTERS.size >= CACHE_LIMIT) {
    const oldest = POSTERS.keys().next().value;
    if (oldest !== undefined) POSTERS.delete(oldest);
  }
  POSTERS.set(key, poster);
}

const settled = (element: HTMLMediaElement, event: string) =>
  new Promise<void>((resolve, reject) => {
    element.addEventListener(event, () => resolve(), { once: true });
    element.addEventListener("error", () => reject(new Error("This file could not be decoded.")), { once: true });
  });

const orGiveUp = (promise: Promise<void>, limitMs: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, limitMs);
    const done = () => { clearTimeout(timer); resolve(); };
    promise.then(done, done);
  });

/* Drawing is the part that can fail on its own — a computer with no 2D canvas,
   a frame the decoder will not hand over — and it must not take the rest of the
   queue down with it. */
function tryDraw(video: HTMLVideoElement): string | null {
  try {
    const { videoWidth: width, videoHeight: height } = video;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, THUMB_WIDTH / width);
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return null;
  }
}

/* Hand the file back: the decoder and the whole blob go with it. */
const release = (element: HTMLMediaElement) => {
  try {
    element.removeAttribute("src");
    element.load();
  } catch {
    /* nothing to do about it */
  }
};

/** The answer for a file nothing more can be read from, given to everyone still
 *  waiting on it. */
function abandon(file: string, result: PosterResult) {
  const queue = QUEUES.get(file);
  QUEUES.delete(file);
  queue?.forEach((waiting) => waiting.settle(result));
}

async function drain(folderPath: string, relativePath: string, file: string): Promise<void> {
  const video = document.createElement("video");
  let url: string | null = null;
  try {
    url = await readMediaFileUrl(folderPath, { relativePath }, "video/mp4");
    // Browser preview: there is no project folder, so there is nothing to show
    // and nothing has gone wrong.
    if (!url) {
      ABSENT.add(file);
      abandon(file, NOTHING);
      return;
    }
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.src = url;
    await settled(video, "loadeddata");
    /* Drained rather than iterated: a card that mounts while the file is open
       joins this same pass instead of opening it a second time. */
    for (;;) {
      const next = QUEUES.get(file)?.shift();
      if (!next) break;
      const key = posterKey(file, next.seconds);
      const already = POSTERS.get(key);
      if (already) {
        next.settle({ poster: already, failed: false });
        continue;
      }
      /* The last frame is not a valid seek target in every container, and a
         shot that starts exactly at the end of the scene would ask for it. */
      const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : next.seconds;
      const target = Math.min(Math.max(next.seconds, 0), end);
      if (Math.abs(video.currentTime - target) > 0.01) {
        const seek = settled(video, "seeked");
        video.currentTime = target;
        // A seek that fails costs this frame its offset and nothing else —
        // whatever the decoder is holding is still a frame of this scene.
        await orGiveUp(seek, SEEK_LIMIT_MS);
      }
      const poster = tryDraw(video);
      if (poster) {
        remember(key, poster);
        next.settle({ poster, failed: false });
      } else {
        next.settle(BROKEN);
      }
    }
  } catch {
    UNREADABLE.add(file);
    abandon(file, BROKEN);
  } finally {
    release(video);
    if (url) URL.revokeObjectURL(url);
    OPEN.delete(file);
    /* Anything that arrived while the file was being handed back. Re-opening is
       the only way to serve it, and it cannot loop: the pass above empties the
       queue before it ever reaches here. */
    const left = QUEUES.get(file);
    if (left && left.length > 0) {
      if (UNREADABLE.has(file)) abandon(file, BROKEN);
      else if (ABSENT.has(file)) abandon(file, NOTHING);
      else {
        OPEN.add(file);
        void drain(folderPath, relativePath, file);
      }
    } else {
      QUEUES.delete(file);
    }
  }
}

/** The frame at `seconds` into the scene's video file. Exported for tests. */
export function shotPoster(folderPath: string, relativePath: string, seconds: number): Promise<PosterResult> {
  const file = fileKey(folderPath, relativePath);
  const cached = POSTERS.get(posterKey(file, seconds));
  if (cached) return Promise.resolve({ poster: cached, failed: false });
  if (UNREADABLE.has(file)) return Promise.resolve(BROKEN);
  if (ABSENT.has(file)) return Promise.resolve(NOTHING);
  return new Promise<PosterResult>((settle) => {
    const queue = QUEUES.get(file) ?? [];
    queue.push({ seconds, settle });
    QUEUES.set(file, queue);
    if (!OPEN.has(file)) {
      OPEN.add(file);
      void drain(folderPath, relativePath, file);
    }
  });
}

/** What a card says when there is no frame. Every one of these is a state of
 *  the scene the user can see and act on, never a shrug. */
function placeholder(job: GenerationJob, failed: boolean, cancelling: boolean): { icon: ReactNode; word: string } {
  if (cancelling && (job.status === "queued" || job.status === "generating")) {
    return { icon: <LoaderCircle size={18} className="spin" />, word: "Cancelling..." };
  }
  switch (job.status) {
    case "generating": return { icon: <LoaderCircle size={18} className="spin" />, word: `Rendering ${Math.round(job.progress * 100)}%` };
    case "queued": return { icon: <Clock3 size={18} />, word: "Waiting to render" };
    case "ready": return { icon: <LoaderCircle size={18} className="spin" />, word: "Saving the file" };
    case "failed": return { icon: <TriangleAlert size={18} />, word: "Didn’t finish" };
    case "cancelled": return { icon: <Ban size={18} />, word: "Cancelled" };
    case "completed": return job.outputRelativePath
      ? failed
        ? { icon: <TriangleAlert size={18} />, word: "No preview" }
        : { icon: <Film size={18} />, word: "Opening the file…" }
      : { icon: <TriangleAlert size={18} />, word: "No file saved" };
    default: return { icon: <Film size={18} />, word: "Not rendered yet" };
  }
}

export function formatEstimatedTimeLeft(milliseconds: number): string {
  const totalSeconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  if (totalSeconds < 60) return `About ${totalSeconds}s left`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `About ${hours}h ${minutes}m left`;
  return `About ${minutes}m ${seconds}s left`;
}

export function ShotThumbnail({ folderPath, job, seconds, endSeconds = sceneDurationSeconds(job), shotNumber, estimatedCompletionAt = null, cancelling = false, onPlay }: {
  folderPath: string;
  /** The scene this shot belongs to: it owns the file and the status. */
  job: GenerationJob;
  /** Where the shot starts, in seconds from the head of the scene. */
  seconds: number;
  /** The next cut (or scene end). Playback never crosses this point. */
  endSeconds?: number;
  shotNumber: number;
  /** Live rendering estimate derived from observed progress; never persisted. */
  estimatedCompletionAt?: number | null;
  /** Cancel was requested but the engine has not reported its terminal state. */
  cancelling?: boolean;
  /** Opens this shot in the editor when playback begins. */
  onPlay?: () => void;
}) {
  const relativePath = job.status === "completed" ? job.outputRelativePath : null;
  const at = seconds;
  const playbackId = `${job.id}@${seconds}`;
  const [result, setResult] = useState<PosterResult>(() =>
    relativePath ? { poster: POSTERS.get(posterKey(fileKey(folderPath, relativePath), at)) ?? null, failed: false } : NOTHING);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [loadingPlayback, setLoadingPlayback] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playFailed, setPlayFailed] = useState(false);
  const [estimateNow, setEstimateNow] = useState(() => Date.now());
  const videoRef = useRef<HTMLVideoElement>(null);
  const requestRef = useRef(0);
  const cutTimerRef = useRef<number | null>(null);

  const clearCutTimer = () => {
    if (cutTimerRef.current !== null) window.clearTimeout(cutTimerRef.current);
    cutTimerRef.current = null;
  };

  const finishPlayback = () => {
    clearCutTimer();
    videoRef.current?.pause();
    setPlaying(false);
    setPlaybackUrl(null);
  };

  const playToCut = async (video: HTMLVideoElement) => {
    clearCutTimer();
    try {
      await video.play();
      setPlaying(true);
      const rate = video.playbackRate > 0 ? video.playbackRate : 1;
      cutTimerRef.current = window.setTimeout(finishPlayback, Math.max(0, (endSeconds - video.currentTime) * 1_000 / rate));
    } catch {
      setPlayFailed(true);
    }
  };

  useEffect(() => {
    if (!relativePath) {
      setResult(NOTHING);
      return;
    }
    let live = true;
    void shotPoster(folderPath, relativePath, at).then((value) => { if (live) setResult(value); });
    return () => { live = false; };
  }, [folderPath, relativePath, at]);

  useEffect(() => {
    const stopOtherShot = (event: Event) => {
      if ((event as CustomEvent<string>).detail === playbackId) return;
      requestRef.current += 1;
      setLoadingPlayback(false);
      finishPlayback();
    };
    window.addEventListener(PLAY_EVENT, stopOtherShot);
    return () => window.removeEventListener(PLAY_EVENT, stopOtherShot);
  }, [playbackId]);

  useEffect(() => () => {
    requestRef.current += 1;
    clearCutTimer();
  }, []);
  useEffect(() => () => {
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  }, [playbackUrl]);

  useEffect(() => {
    if (job.status !== "generating" || estimatedCompletionAt === null || cancelling) return;
    setEstimateNow(Date.now());
    const timer = window.setInterval(() => setEstimateNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [job.status, estimatedCompletionAt, cancelling]);

  const stopAtCut = () => {
    const video = videoRef.current;
    if (!video || video.currentTime + 0.02 < endSeconds) return;
    finishPlayback();
  };

  const togglePlayback = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!relativePath || loadingPlayback) return;
    const video = videoRef.current;
    if (video) {
      if (!video.paused) {
        clearCutTimer();
        video.pause();
        setPlaying(false);
      } else {
        onPlay?.();
        window.dispatchEvent(new CustomEvent<string>(PLAY_EVENT, { detail: playbackId }));
        if (video.currentTime < seconds || video.currentTime >= endSeconds) video.currentTime = seconds;
        await playToCut(video);
      }
      return;
    }

    const request = ++requestRef.current;
    onPlay?.();
    window.dispatchEvent(new CustomEvent<string>(PLAY_EVENT, { detail: playbackId }));
    setLoadingPlayback(true);
    setPlayFailed(false);
    try {
      const url = await readMediaFileUrl(folderPath, { relativePath }, "video/mp4");
      if (request !== requestRef.current) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      if (!url) throw new Error("The generated file is not available in this view.");
      setPlaybackUrl(url);
    } catch {
      if (request === requestRef.current) setPlayFailed(true);
    } finally {
      if (request === requestRef.current) setLoadingPlayback(false);
    }
  };

  if (result.poster) {
    const action = playFailed ? "Playback unavailable" : loadingPlayback ? "Opening shot" : playing ? "Pause" : "Play";
    return <button
      type="button"
      className="shot-thumb shot-thumb--poster shot-thumb--playable"
      aria-label={`${action} shot ${shotNumber} of ${job.title}`}
      title={`${action} this shot only (${seconds.toFixed(1)}s–${endSeconds.toFixed(1)}s)`}
      onClick={(event) => void togglePlayback(event)}
    >
      {playbackUrl
        ? <video
          ref={videoRef}
          src={playbackUrl}
          playsInline
          onLoadedMetadata={(event) => {
            event.currentTarget.currentTime = Math.min(seconds, Math.max(0, event.currentTarget.duration - 0.01));
            void playToCut(event.currentTarget);
          }}
          onTimeUpdate={stopAtCut}
          onEnded={stopAtCut}
        />
        : <img src={result.poster} alt="" loading="lazy" />}
      <span className={`shot-thumb__play ${loadingPlayback ? "shot-thumb__play--loading" : ""}`} aria-hidden="true">
        {loadingPlayback ? <LoaderCircle size={20} className="spin" /> : playing ? <Pause size={20} /> : playFailed ? <TriangleAlert size={20} /> : <Play size={20} fill="currentColor" />}
      </span>
    </button>;
  }
  const { icon, word } = placeholder(job, result.failed, cancelling);
  const estimateLine = job.status === "generating" && !cancelling
    ? estimatedCompletionAt === null
      ? "Estimating time left…"
      : formatEstimatedTimeLeft(estimatedCompletionAt - estimateNow)
    : null;
  return <span className={`shot-thumb shot-thumb--${job.status}`} role="img" aria-label={`Shot ${shotNumber} — ${word}${estimateLine ? `. ${estimateLine}` : ""}`}>
    {icon}
    <em>{word}</em>
    {estimateLine && <small className="shot-thumb__eta">{estimateLine}</small>}
    {job.status === "generating" && <span className="shot-thumb__progress" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, job.progress * 100))}%` }} />
    </span>}
  </span>;
}
