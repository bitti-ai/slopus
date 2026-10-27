import { Slider } from "../ui";
import { Audio16, GoToEnd16, GoToStart16, Pause16, Play16, Speaker14 } from "../ui/icons";

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;

export function MusicPlaybackControls({ title, playing, position, duration, volume, canPlay, canNavigate, canSeek,
  onToggle, onPrevious, onNext, onSeek, onVolume }: {
  title?: string; playing: boolean; position: number; duration: number; volume: number;
  canPlay: boolean; canNavigate: boolean; canSeek: boolean;
  onToggle: () => void; onPrevious: () => void; onNext: () => void;
  onSeek: (position: number) => void; onVolume: (volume: number) => void;
}) {
  return <>
    <div className="music-player__now"><Audio16 /><div><strong>{title ?? "No song playing"}</strong><span>{playing ? "Playing" : title ? "Paused" : "Choose a generated song"}</span></div></div>
    <div className="music-player__transport">
      <div className="music-player__buttons">
        <button type="button" className="icon-button" aria-label="Previous song" disabled={!canNavigate} onClick={onPrevious}><GoToStart16 /></button>
        <button type="button" className="music-player__toggle primary-button" aria-label={playing ? "Pause music" : "Play music"} disabled={!canPlay} onClick={onToggle}>{playing ? <Pause16 /> : <Play16 />}</button>
        <button type="button" className="icon-button" aria-label="Next song" disabled={!canNavigate} onClick={onNext}><GoToEnd16 /></button>
      </div>
      <div className="music-player__seek"><span>{time(position)}</span><Slider aria-label="Song playback position" min={0} max={duration || 1} step={0.1} value={position} disabled={!canSeek} onChange={onSeek} /><span>{time(duration)}</span></div>
    </div>
    <div className="music-player__volume"><Speaker14 /><Slider aria-label="Music volume" min={0} max={1} step={0.01} value={volume} onChange={onVolume} /></div>
  </>;
}
