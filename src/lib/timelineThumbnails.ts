import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./persistence";

/** Timeline stills are anchored to source time, not clip time. Trimming or
 * splitting a clip can therefore reuse the same small cache without moving or
 * regenerating any files. */
export const TIMELINE_THUMBNAIL_INTERVAL_MS = 2_000;

export const timelineThumbnailRelativePath = (jobId: string, timeMs: number): string =>
  `thumbnails/timeline/${jobId}/${Math.max(0, Math.round(timeMs)).toString().padStart(8, "0")}.jpg`;

export async function writeTimelineThumbnail(folderPath: string, jobId: string, timeMs: number, bytes: Uint8Array): Promise<void> {
  if (!isTauri() || bytes.byteLength === 0) return;
  await invoke("write_timeline_thumbnail", bytes, {
    headers: {
      "x-thumbnail-folder": encodeURIComponent(folderPath),
      "x-thumbnail-job": encodeURIComponent(jobId),
      "x-thumbnail-time": String(Math.max(0, Math.round(timeMs))),
    },
  });
}

export async function writeTimelineThumbnailDataUrl(folderPath: string, jobId: string, timeMs: number, dataUrl: string): Promise<void> {
  if (!isTauri()) return;
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  await writeTimelineThumbnail(folderPath, jobId, timeMs, bytes);
}

export async function purgeTimelineThumbnails(folderPath: string, jobId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("purge_timeline_thumbnails", { folderPath, jobId });
}
