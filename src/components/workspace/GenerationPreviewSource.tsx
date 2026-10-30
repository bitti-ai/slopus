import { createContext, useEffect, useState, type ReactNode } from "react";
import { encodeGenerationPreview, type GenerationPreview } from "../../lib/generationPreview";

export const GenerationPreviewContext = createContext<{ preview: GenerationPreview; url?: string } | undefined>(undefined);

/** Encode once per scene and share the transient clip across its shot cards. */
export function GenerationPreviewSource({ preview, children }: { preview?: GenerationPreview; children: ReactNode }) {
  const [source, setSource] = useState<{ preview: GenerationPreview; url: string }>();
  useEffect(() => {
    if (!preview) { setSource(undefined); return; }
    const controller = new AbortController();
    void encodeGenerationPreview(preview, controller.signal).then((blob) => {
      if (!controller.signal.aborted) setSource({ preview, url: URL.createObjectURL(blob) });
    }).catch(() => { /* Keep the previous clip, or show this step's JPEG. */ });
    return () => controller.abort();
  }, [preview]);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);
  const current = source?.preview.jobId === preview?.jobId ? source : undefined;
  return <GenerationPreviewContext.Provider value={preview ? current ?? { preview } : undefined}>{children}</GenerationPreviewContext.Provider>;
}
