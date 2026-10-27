import { useEffect, useRef, useState } from "react";
import { forgetShotPosters, shotPoster } from "./ShotThumbnail";
import { Film32 } from "../ui/icons";

export function VideoPoster({ folderPath, relativePath, seconds, revision, title }: {
  folderPath: string; relativePath?: string | null; seconds: number; revision?: string | number; title: string;
}) {
  const key = `${folderPath}:${relativePath}:${seconds}:${revision}`;
  const [result, setResult] = useState<{ key: string; poster: string | null }>();
  const previous = useRef<{ path: string; revision?: string | number }>();
  useEffect(() => {
    if (!relativePath) return;
    if (previous.current?.path === relativePath && previous.current.revision !== revision) forgetShotPosters(folderPath, relativePath);
    previous.current = { path: relativePath, revision };
    let live = true;
    void shotPoster(folderPath, relativePath, seconds).then(({ poster }) => { if (live) setResult({ key, poster }); });
    return () => { live = false; };
  }, [key]);
  return result?.key === key && result.poster
    ? <img src={result.poster} alt={`First frame of ${title}`} draggable={false} /> : <Film32 aria-hidden="true" />;
}
