import { useEffect, useRef, useState } from "react";
import { encodeGenerationPreview, type GenerationPreview } from "../../lib/generationPreview";

export function GenerationPreviewPlayer({ preview }: { preview: GenerationPreview }) {
  const [source, setSource] = useState<{ url: string; step: number }>();
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const url = useRef<string>();
  const position = useRef({ time: 0, paused: true });
  useEffect(() => {
    const controller = new AbortController();
    void encodeGenerationPreview(preview, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      position.current = { time: video.current?.currentTime ?? 0, paused: video.current?.paused ?? true };
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = next;
      setSource({ url: next, step: preview.step });
      setFailed(false);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [preview]);
  useEffect(() => () => { if (url.current) URL.revokeObjectURL(url.current); }, []);
  return <div className="generation-preview" aria-label="Generation preview">
    {source ? <video ref={video} src={source.url} controls muted loop playsInline preload="auto" aria-label="Play generation preview"
      onLoadedMetadata={() => {
        const element = video.current;
        if (!element) return;
        element.currentTime = Math.min(position.current.time, Math.max(0, element.duration - .01));
        if (!position.current.paused) void element.play().catch(() => {});
      }} /> : <img src={`data:image/jpeg;base64,${preview.frames[0]}`} alt="Generation preview" />}
    <span>{failed && !source ? "Preview playback unavailable" : `Generation preview · Step ${(source?.step ?? preview.step) + 1}`}</span>
  </div>;
}
