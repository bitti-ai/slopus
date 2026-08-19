import { Image as ImageIcon, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { readMediaFileUrl } from "../../lib/persistence";

/* An image reference is copied into the project folder; a video or sound
 * reference is left where the user keeps it and only its absolute path is
 * recorded. Either way the webview cannot reach the file directly — so the
 * bytes come back through a Tauri command and become a blob URL here. The URL is revoked on unmount and on every path change; without
 * that, browsing a library of references pins each one in memory for the life
 * of the window.
 *
 * The extension is the only thing available to type the blob: nothing has
 * decoded the file. Getting it wrong costs a broken <img>, which is exactly
 * what `failed` renders. */
const mimeFor = (path: string) => {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return "image/jpeg";
  }
};

export function ReferenceImage({ folderPath, relativePath, sourcePath = null, alt, className = "" }: {
  folderPath: string;
  /** Set for a file copied into the project. */
  relativePath?: string | null;
  /** Set instead for a file the project only points at. */
  sourcePath?: string | null;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current: string | null = null;
    let live = true;
    setFailed(false);
    setUrl(null);
    void readMediaFileUrl(folderPath, { relativePath, sourcePath }, mimeFor(sourcePath ?? relativePath ?? ""))
      .then((value) => {
        // Unmounted (or moved to another reference) while the read was in
        // flight: revoke immediately, because nothing else ever will.
        if (!live) {
          if (value) URL.revokeObjectURL(value);
          return;
        }
        current = value;
        setUrl(value);
        if (!value) setFailed(true);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => {
      live = false;
      if (current) URL.revokeObjectURL(current);
    };
  }, [folderPath, relativePath, sourcePath]);

  if (url) {
    return <img className={className} src={url} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
  }
  /* Two different states, said plainly rather than with one ambiguous
     placeholder: still loading, or the file is not where the project says. */
  return <span className={`reference-image-fallback ${className}`.trim()} role="img" aria-label={failed ? `${alt} — file missing` : `${alt} — loading`}>
    {failed ? <TriangleAlert size={22} aria-hidden="true" /> : <ImageIcon size={22} aria-hidden="true" />}
    <em>{failed ? "File not found" : "Loading…"}</em>
  </span>;
}
