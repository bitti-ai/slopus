import { Image as ImageIcon, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { readProjectFileUrl } from "../../lib/persistence";

/* Reference images live in the project folder, which the webview cannot reach
 * directly — so the bytes come back through a Tauri command and become a blob
 * URL here. The URL is revoked on unmount and on every path change; without
 * that, browsing a library of references pins each one in memory for the life
 * of the window.
 *
 * The extension is the only thing available to type the blob: nothing has
 * decoded the file. Getting it wrong costs a broken <img>, which is exactly
 * what `failed` renders. */
const mimeFor = (relativePath: string) => {
  const extension = relativePath.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: return "image/jpeg";
  }
};

export function ReferenceImage({ folderPath, relativePath, alt, className = "" }: {
  folderPath: string;
  relativePath: string;
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
    void readProjectFileUrl(folderPath, relativePath, mimeFor(relativePath))
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
  }, [folderPath, relativePath]);

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
