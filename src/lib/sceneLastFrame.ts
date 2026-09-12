import { invoke } from "@tauri-apps/api/core";
import { demux } from "./exportPipeline";
import { readMediaFileBytes } from "./persistence";
import { sceneLastFramePath } from "./project";

/** Decode the final keyframe group into a full-resolution conditioning image. */
export async function saveSceneLastFrame(folderPath: string, outputRelativePath: string): Promise<string> {
  const relativePath = sceneLastFramePath(outputRelativePath);
  const source = await demux(await readMediaFileBytes(folderPath, { relativePath: outputRelativePath }), "Previous scene");
  if (!source.samples.length) throw new Error("The previous scene contains no video frames.");
  let start = source.samples.length - 1;
  while (start > 0 && !source.samples[start].key) start -= 1;
  const state: { frame: VideoFrame | null; error: Error | null } = { frame: null, error: null };
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (!state.frame || frame.timestamp >= state.frame.timestamp) {
        state.frame?.close();
        state.frame = frame;
      } else frame.close();
    },
    error: (error) => { state.error = error; },
  });
  try {
    decoder.configure({ ...source.config, hardwareAcceleration: "prefer-hardware" });
    for (let index = start; index < source.samples.length; index += 1) {
      if (state.error) throw state.error;
      const sample = source.samples[index];
      decoder.decode(new EncodedVideoChunk({ type: sample.key ? "key" : "delta", timestamp: sample.timestampUs, duration: sample.durationUs, data: sample.data }));
      while (decoder.decodeQueueSize > 8 && !state.error) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await decoder.flush();
    if (state.error) throw state.error;
    const frame = state.frame;
    if (!frame) throw new Error("Could not decode the previous scene's last frame.");
    const canvas = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create the previous scene's last-frame image.");
    context.drawImage(frame, 0, 0);
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    await invoke("write_scene_last_frame", bytes, { headers: {
      "x-generated-folder": encodeURIComponent(folderPath),
      "x-generated-job": encodeURIComponent(relativePath.split("/").pop()!.replace(/\.png$/, "")),
    } });
    return relativePath;
  } finally {
    state.frame?.close();
    if (decoder.state !== "closed") decoder.close();
  }
}
