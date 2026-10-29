export interface GenerationPreview {
  jobId: string;
  step: number;
  width: number;
  height: number;
  fps: number;
  /** Base64 JPEG frames; transient and never written into the project. */
  frames: string[];
}

export function validGenerationPreview(value: GenerationPreview): boolean {
  return Boolean(value && typeof value.jobId === "string" && Number.isInteger(value.step) && value.step >= 0
    && [value.width, value.height].every((size) => Number.isInteger(size) && size > 0 && size <= 256 && size % 2 === 0)
    && Number.isFinite(value.fps) && value.fps > 0 && value.fps <= 60
    && Array.isArray(value.frames) && value.frames.length > 0 && value.frames.length <= 128
    && value.frames.every((frame) => typeof frame === "string" && frame.length > 0 && frame.length <= 262144)
    && value.frames.reduce((bytes, frame) => bytes + frame.length, 0) <= 8 * 1024 * 1024);
}

/** Small silent MP4 for the scene card. WebCodecs owns encoding; no files or FFmpeg. */
export async function encodeGenerationPreview(preview: GenerationPreview, signal: AbortSignal): Promise<Blob> {
  if (!validGenerationPreview(preview)) throw new Error("Invalid generation preview.");
  signal.throwIfAborted();
  const { width, height, fps } = preview;
  const config: VideoEncoderConfig = { codec: "avc1.42001f", width, height, framerate: fps, bitrate: 600_000, avc: { format: "avc" } };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error("Preview encoding is unavailable.");
  const { ArrayBufferTarget, Muxer } = await import("mp4-muxer");
  signal.throwIfAborted();
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: "avc", width, height }, fastStart: "in-memory" });
  const failure: { error?: DOMException } = {};
  const encoder = new VideoEncoder({ output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata), error: (error) => { failure.error = error; } });
  try {
    encoder.configure(config);
    for (let i = 0; i < preview.frames.length; ++i) {
      signal.throwIfAborted();
      if (failure.error) throw failure.error;
      const jpeg = Uint8Array.from(atob(preview.frames[i]), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      try {
        signal.throwIfAborted();
        const frame = new VideoFrame(bitmap, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round((i + 1) * 1e6 / fps) - Math.round(i * 1e6 / fps) });
        try { encoder.encode(frame, { keyFrame: i === 0 }); }
        finally { frame.close(); }
      } finally { bitmap.close(); }
      if (encoder.encodeQueueSize >= 8) await encoder.flush();
    }
    await encoder.flush();
    signal.throwIfAborted();
    if (failure.error) throw failure.error;
    muxer.finalize();
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally { if (encoder.state !== "closed") encoder.close(); }
}
