import { invoke } from "@tauri-apps/api/core";
import type { ProjectReference } from "./project";
import { referenceTime } from "./referenceVideoTrim";

/** Copy only a frame the user picks, at source resolution, into a persistent
 * PNG attachment. Scrubbing continues to use the hardware video preview. */
export async function captureReferenceVideoFrame(folderPath: string, name: string, video: HTMLVideoElement): Promise<NonNullable<NonNullable<ProjectReference["video"]>["frames"]>[number]> {
  if (video.seeking || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("Wait for the video frame to finish loading.");
  }
  video.pause();
  const timeSeconds = video.currentTime;
  const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not capture the video frame.");
  context.drawImage(video, 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const id = `ref-frame-${crypto.randomUUID()}`;
  const relativePath = await invoke<string>("write_reference_frame", bytes, { headers: {
    "x-reference-folder": encodeURIComponent(folderPath),
    "x-reference-frame": id,
  } });
  return { id, name: `${name} at ${referenceTime(timeSeconds)}`, relativePath, timeSeconds };
}
