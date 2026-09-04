import { useEffect, useMemo, useState } from "react";
import { audioWaveformSegment, loadAudioWaveform } from "../../lib/audioWaveform";
import { type ProjectAsset, type TimelineClip } from "../../lib/project";

const DISPLAY_POINTS = 1_024;

const sampleLines = (levels: number[]) => levels.map((level, index) => {
  const x = index / Math.max(1, levels.length - 1) * 1000;
  const amplitude = level * 43;
  return `M${x.toFixed(2)},${(50 - amplitude).toFixed(2)}V${(50 + amplitude).toFixed(2)}`;
}).join(" ");

/** A source-time-accurate series of amplitude samples. Each sample is its own
 * vertical stroke around the centre, avoiding a continuous envelope outline. */
export function TimelineClipWaveform({ folderPath, asset, clip, cacheVersion = "" }: {
  folderPath: string;
  asset: ProjectAsset;
  clip: TimelineClip;
  cacheVersion?: string;
}) {
  const [levels, setLevels] = useState<number[] | null>(null);
  useEffect(() => {
    let live = true;
    setLevels(null);
    void loadAudioWaveform(folderPath, asset, cacheVersion).then((overview) => {
      if (live) setLevels(audioWaveformSegment(overview, clip.sourceStartMs / 1_000, clip.durationMs / 1_000, DISPLAY_POINTS));
    }).catch(() => {
      if (live) setLevels([]);
    });
    return () => { live = false; };
  }, [asset, cacheVersion, clip.durationMs, clip.sourceStartMs, folderPath]);

  const lines = useMemo(() => levels && levels.length > 0 ? sampleLines(levels) : null, [levels]);

  return <span className={`clip-audio-visualization ${levels === null ? "loading" : ""}`} aria-hidden="true">
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" focusable="false">
      {lines && <path className="clip-audio-visualization__samples" d={lines} />}
    </svg>
  </span>;
}
