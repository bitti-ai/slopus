import { useEffect, useState } from "react";
import { readMediaFileUrl } from "../../lib/persistence";
import type { ProjectReference } from "../../lib/project";

export function ReferenceVideo({ folderPath, reference }: { folderPath: string; reference: ProjectReference }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let owned: string | null = null;
    setUrl(null); setError(null);
    void readMediaFileUrl(folderPath, reference, "video/mp4").then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, reference.sourcePath, reference.relativePath]);
  if (error) return <p role="alert">{error}</p>;
  if (!url) return <p>Loading video preview…</p>;
  return <video className="reference-video-preview" key={`${url}:${reference.video?.startSeconds ?? 0}`}
    src={url} controls preload="metadata" aria-label={`${reference.name} video preview`}
    muted={reference.video?.includeAudio === false}
    onLoadedMetadata={(event) => { event.currentTarget.currentTime = reference.video?.startSeconds ?? 0; }}
    onError={() => setError("This computer cannot preview this video codec.")} />;
}
