import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ProjectConfig, ProjectVideo } from "../../lib/project";
import { outputDimensions } from "../../lib/export";
import { videoPlaybackConfig, videoPlaylist } from "../../lib/videoPlayback";
import { ProgramMonitor } from "./ProgramMonitor";
import { Dismiss16, Pause20, Play20Filled } from "../ui/icons";
export { videoPlaylist } from "../../lib/videoPlayback";

/** Timeline's continuous clock, prepared players and persistent compositor. */
export function VideoPlayback({ video: item, config, folderPath, popout, onClose }: {
  video: ProjectVideo; config: ProjectConfig; folderPath: string; popout: boolean; onClose: () => void;
}) {
  const preview = useMemo(() => videoPlaybackConfig(item, config), [item, config]);
  const playlist = useMemo(() => videoPlaylist(item, config), [item, config]);
  const [playhead, setPlayhead] = useState(0), [playing, setPlaying] = useState(true);
  const frame = useRef<HTMLDivElement>(null), close = useRef(onClose); close.current = onClose;
  const duration = preview.timeline.tracks[0].clips.reduce((end, clip) => Math.max(end, clip.startMs + clip.durationMs), 0);
  const index = Math.max(0, playlist.findIndex((clip) => playhead < clip.startMs + clip.durationMs));
  const current = playlist[playhead >= duration ? playlist.length - 1 : index];
  const dimensions = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    const library = popout ? frame.current?.closest(".video-library-stage")?.querySelector<HTMLElement>(".music-library") : null;
    const wasInert = library?.hasAttribute("inert");
    library?.setAttribute("inert", "");
    if (popout) frame.current?.focus();
    const outside = (event: PointerEvent) => { if (popout && !frame.current?.contains(event.target as Node)) close.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close.current(); } };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape);
      if (library && !wasInert) library.removeAttribute("inert");
      if (popout && focused?.isConnected) focused.focus();
    };
  }, [popout]);
  const player = <div className={popout ? "shot-popout__frame" : "video-card__player"} ref={frame} tabIndex={-1}
    role={popout ? "dialog" : "group"} aria-label={item.title + " preview"} style={{ "--shot-aspect": dimensions.width / dimensions.height } as CSSProperties}>
    <ProgramMonitor config={preview} folderPath={folderPath} playheadMs={Math.min(playhead, Math.max(0, duration - 1))} playing={playing} waitForInitialFrame onSeek={setPlayhead} onPlayingChange={setPlaying} />
    <button type="button" className="shot-popout__close" aria-label="Close video preview" onClick={onClose}><Dismiss16 /></button>
    <button type="button" className="shot-popout__play" aria-label={(playing ? "Pause " : "Replay ") + item.title} disabled={!duration} onClick={() => {
      if (playing) setPlaying(false);
      else { if (playhead >= duration) setPlayhead(0); setPlaying(true); }
    }}>{playing ? <Pause20 /> : <Play20Filled />}</button>
    <span className="video-card__position">{playhead >= duration ? playlist.length : index + 1} / {playlist.length} · {current?.title}</span>
  </div>;
  return popout ? <div className="shot-popout">{player}</div> : player;
}
