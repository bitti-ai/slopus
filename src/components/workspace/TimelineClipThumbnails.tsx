import { useEffect, useMemo, useState } from "react";
import { readProjectFileUrl } from "../../lib/persistence";
import { type GenerationJob, type TimelineClip } from "../../lib/project";
import {
  TIMELINE_THUMBNAIL_INTERVAL_MS,
  timelineThumbnailRelativePath,
  writeTimelineThumbnailDataUrl,
} from "../../lib/timelineThumbnails";
import { shotPoster } from "./ShotThumbnail";

interface TimelineStill {
  timeMs: number;
  url: string;
}

/** Cached scene frames laid over the span of source footage a clip uses. The
 * strip remains source-time accurate when a clip is trimmed, split or moved. */
export function TimelineClipThumbnails({ folderPath, job, clip }: {
  folderPath: string;
  job: GenerationJob;
  clip: TimelineClip;
}) {
  const sourceEndMs = clip.sourceStartMs + clip.durationMs;
  const times = useMemo(() => {
    const first = Math.floor(clip.sourceStartMs / TIMELINE_THUMBNAIL_INTERVAL_MS) * TIMELINE_THUMBNAIL_INTERVAL_MS;
    const result: number[] = [];
    for (let timeMs = Math.max(0, first); timeMs < sourceEndMs; timeMs += TIMELINE_THUMBNAIL_INTERVAL_MS) {
      result.push(timeMs);
    }
    return result;
  }, [clip.sourceStartMs, sourceEndMs]);
  const [stills, setStills] = useState<TimelineStill[]>([]);

  useEffect(() => {
    if (job.status !== "completed" || !job.outputRelativePath || times.length === 0) {
      setStills([]);
      return;
    }
    const outputRelativePath = job.outputRelativePath;
    let live = true;
    const objectUrls: string[] = [];
    void Promise.all(times.map(async (timeMs): Promise<TimelineStill | null> => {
      try {
        const cached = await readProjectFileUrl(folderPath, timelineThumbnailRelativePath(job.id, timeMs), "image/jpeg");
        if (cached) {
          objectUrls.push(cached);
          return { timeMs, url: cached };
        }
      } catch {
        // Older projects have no disk cache. Decode the same source frame once,
        // show it now, and quietly seed the cache for the next visit.
      }
      const generated = await shotPoster(folderPath, outputRelativePath, timeMs / 1_000);
      if (!generated.poster) return null;
      void writeTimelineThumbnailDataUrl(folderPath, job.id, timeMs, generated.poster).catch(() => undefined);
      return { timeMs, url: generated.poster };
    })).then((loaded) => {
      if (live) setStills(loaded.filter((still): still is TimelineStill => still !== null));
      else objectUrls.forEach((url) => URL.revokeObjectURL(url));
    });
    return () => {
      live = false;
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [folderPath, job.id, job.outputRelativePath, job.status, times]);

  if (stills.length === 0) return null;
  return <span className="timeline-clip__thumbnails" aria-hidden="true">
    {stills.map((still) => <img
      key={still.timeMs}
      src={still.url}
      alt=""
      draggable={false}
      style={{
        left: `${(still.timeMs - clip.sourceStartMs) / clip.durationMs * 100}%`,
        width: `${TIMELINE_THUMBNAIL_INTERVAL_MS / clip.durationMs * 100}%`,
      }}
    />)}
  </span>;
}
