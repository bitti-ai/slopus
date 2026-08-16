import {
  Copy, Film, Image as ImageIcon, Layers3, Lock, LockOpen, Music2,
  Pause, Play, Plus, Scissors, SkipBack, SkipForward, Trash2, Upload, Video,
  Volume2, VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProjectConfig, TimelineClip } from "../../lib/project";

const MIN_DURATION = 10_000;
const NOT_YET = "Not available yet. This control doesn’t change your project.";

/* The canvas used to be a hard-coded 34s — the seeded fixture's exact length —
   so a 60-second project still got a 34-second ruler. Derive it from the real
   content, falling back to the duration the user actually asked for. */
const canvasDuration = (config: ProjectConfig) => {
  const lastClipEnd = config.timeline.tracks.reduce(
    (end, track) => track.clips.reduce((furthest, clip) => Math.max(furthest, clip.startMs + clip.durationMs), end),
    0,
  );
  return Math.max(lastClipEnd, config.brief.targetDurationSeconds * 1000, MIN_DURATION);
};

/* Roughly seven labels regardless of length, snapped to a readable interval. */
const rulerTicks = (durationMs: number) => {
  const totalSeconds = Math.ceil(durationMs / 1000);
  const step = [1, 2, 5, 10, 15, 30, 60, 120].find((candidate) => totalSeconds / candidate <= 7) ?? 300;
  return Array.from({ length: Math.floor(totalSeconds / step) + 1 }, (_, index) => index * step);
};

const rulerLabel = (seconds: number) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
const timecode = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const frames = Math.floor((ms % 1000) / (1000 / 30));
  return `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
};

export function TimelineView({ config, onChange, onOpenGenerator }: { config: ProjectConfig; onChange: (next: ProjectConfig) => void; onOpenGenerator: (jobId?: string) => void }) {
  const firstClip = config.timeline.tracks.flatMap((track) => track.clips)[0];
  const [selectedId, setSelectedId] = useState(firstClip?.id ?? "");
  const [playhead, setPlayhead] = useState(firstClip?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [panelTab, setPanelTab] = useState<"scenes" | "media">("scenes");
  const tracks = config.timeline.tracks;
  const selected = useMemo(() => tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedId), [tracks, selectedId]);
  const selectedTrack = tracks.find((track) => track.id === selected?.trackId);
  const clipCount = tracks.reduce((total, track) => total + track.clips.length, 0);
  const sceneClips = tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips);
  const hasVisualOutput = config.assets.some((asset) => asset.kind === "video" || asset.kind === "image" || asset.kind === "generated")
    || config.generationJobs.some((job) => Boolean(job.outputRelativePath));
  const duration = useMemo(() => canvasDuration(config), [config]);
  const ticks = useMemo(() => rulerTicks(duration), [duration]);

  useEffect(() => {
    // Playing an empty timeline would run the clock over nothing, which reads
    // as playback of footage that does not exist.
    if (!playing || clipCount === 0) return;
    const timer = window.setInterval(() => setPlayhead((current) => current >= duration ? 0 : current + 100), 100);
    return () => window.clearInterval(timer);
  }, [playing, clipCount, duration]);

  useEffect(() => { if (clipCount === 0 && playing) setPlaying(false); }, [clipCount, playing]);

  const updateTracks = (nextTracks: ProjectConfig["timeline"]["tracks"]) => onChange({ ...config, timeline: { tracks: nextTracks } });
  const updateClip = (clipId: string, updates: Partial<TimelineClip>) => updateTracks(tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...updates } : clip) })));
  const toggleTrack = (trackId: string, key: "muted" | "locked") => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, [key]: !track[key] } : track));
  const removeSelected = () => {
    if (!selected || selectedTrack?.locked) return;
    updateTracks(tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== selected.id) })));
    setSelectedId("");
  };
  const duplicateSelected = () => {
    if (!selected || !selectedTrack || selectedTrack.locked) return;
    const copy = { ...selected, id: `${selected.id}-copy-${Date.now()}`, startMs: Math.min(duration - selected.durationMs, selected.startMs + selected.durationMs), label: `${selected.label} copy` };
    updateTracks(tracks.map((track) => track.id === selected.trackId ? { ...track, clips: [...track.clips, copy] } : track));
    setSelectedId(copy.id);
  };
  const splitSelected = () => {
    if (!selected || !selectedTrack || selectedTrack.locked || playhead <= selected.startMs || playhead >= selected.startMs + selected.durationMs) return;
    const leftDuration = playhead - selected.startMs;
    const right: TimelineClip = { ...selected, id: `${selected.id}-split-${Date.now()}`, startMs: playhead, durationMs: selected.durationMs - leftDuration, sourceStartMs: selected.sourceStartMs + leftDuration, label: `${selected.label} · B` };
    updateTracks(tracks.map((track) => track.id === selected.trackId ? { ...track, clips: track.clips.flatMap((clip) => clip.id === selected.id ? [{ ...clip, durationMs: leftDuration, label: `${clip.label} · A` }, right] : [clip]) } : track));
    setSelectedId(right.id);
  };
  /* Mirrors splitSelected's own guard, one condition for one condition. The
     button used to stay live with the playhead outside the clip, so pressing it
     silently did nothing. Null means Split will actually cut. */
  const splitBlockedBy = !selected
    ? "Select a clip to split it"
    : !selectedTrack || selectedTrack.locked
      ? "This clip’s track is locked"
      : playhead <= selected.startMs || playhead >= selected.startMs + selected.durationMs
        ? "Move the playhead inside the selected clip to split it"
        : null;
  /* Same rule as Split: a disabled control says why it is disabled, and the
     predicate is the handler's own guard rather than a looser approximation. */
  const duplicateBlockedBy = !selected
    ? "Select a clip to duplicate it"
    : !selectedTrack || selectedTrack.locked ? "This clip’s track is locked" : null;
  const deleteBlockedBy = !selected
    ? "Select a clip to delete it"
    : !selectedTrack || selectedTrack.locked ? "This clip’s track is locked" : null;
  const addScene = () => {
    // A new project already carries an unstarted draft made from the user's own
    // words, so open that rather than stacking a near-identical second shot.
    // With none left, go to an empty composer: synthesising a shot from
    // config.brief.prompt would describe the whole VIDEO as if it were a single
    // shot and hand it back as words the user never wrote.
    onOpenGenerator(config.generationJobs.find((job) => job.status === "draft")?.id);
  };

  return (
    <div className="timeline-view" tabIndex={0} onKeyDown={(event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && event.target === event.currentTarget) removeSelected();
      if (event.code === "Space" && event.target === event.currentTarget && clipCount > 0) { event.preventDefault(); setPlaying((value) => !value); }
    }}>
      {/* The view had no top-level heading at all, so screen-reader users had
          no landmark for it. Sighted users already see the project topbar. */}
      <h1 className="sr-only">Timeline editor</h1>
      <div className="edit-panels">
        <aside className="scene-panel">
          <div className="panel-tabs">
            <button className={panelTab === "scenes" ? "active" : ""} onClick={() => setPanelTab("scenes")}><Layers3 size={16} /> Scenes</button>
            <button className={panelTab === "media" ? "active" : ""} onClick={() => setPanelTab("media")}><Film size={16} /> Media</button>
          </div>
          <div className="scene-panel__head"><h2>{panelTab === "scenes" ? "Story sequence" : "Project media"}</h2></div>
          {panelTab === "scenes" ? (
            <div className="scene-list">
              {sceneClips.map((clip, index) => (
                <button key={clip.id} className={`scene-card ${selectedId === clip.id ? "selected" : ""}`} onClick={() => { setSelectedId(clip.id); setPlayhead(clip.startMs + 600); }}>
                  <span className="scene-card__thumb"><i>{String(index + 1).padStart(2, "0")}</i><em>{(clip.durationMs / 1000).toFixed(1)}s</em></span>
                  <span><b>{clip.label.replace(/^\d+ · /, "")}</b><small>{clip.status === "generated" ? "Needs review" : "In timeline"}</small></span>
                </button>
              ))}
              {sceneClips.length === 0 && <p className="panel-hint">No scenes yet. Use the button below to open your shot in the Generator — scenes appear here once they land on the timeline.</p>}
              <button className="scene-add" onClick={addScene}><Plus size={18} /> Add or generate a scene</button>
            </div>
          ) : (
            <div className="media-grid">
              {config.assets.map((asset) => <button key={asset.id}><span className="media-thumb">{asset.kind === "audio" ? <Music2 size={22} /> : asset.kind === "image" ? <ImageIcon size={22} /> : <Video size={22} />}</span><b>{asset.name}</b><small>{asset.kind} · {asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)}s` : "still"}</small></button>)}
              {config.assets.length === 0 && <p className="panel-hint">No media in this project yet. Pol Studio can’t save generated shots as files yet, so nothing lands here.</p>}
              <button className="media-import" disabled title="Importing your own files isn’t available yet. Generate a scene instead.">
                <Upload size={20} /><b>Import media</b><small>Not available yet</small>
              </button>
            </div>
          )}
        </aside>

        <main className="program-panel">
          <div className="panel-chrome"><h2><i className="live-dot" /> Program monitor</h2></div>
          <div className="program-canvas">
            {hasVisualOutput ? (
              <div className="program-empty program-empty--footage">
                <Film size={30} />
                <strong>{config.name}</strong>
                <span>{config.brief.prompt}</span>
                <small>Pol Studio can’t play this footage back yet. {clipCount === 1 ? "1 clip is" : `${clipCount} clips are`} arranged on the timeline below and nothing has been lost.</small>
              </div>
            ) : (
              <div className="program-empty" data-testid="project-empty-monitor">
                <Film size={30} />
                <strong>{config.name}</strong>
                <span>{config.brief.prompt}</span>
                <small>Nothing to play yet. Add or generate a scene and it will land on the timeline below.</small>
              </div>
            )}
          </div>
          <div className="monitor-transport">
            <strong>{timecode(playhead)}</strong>
            <div>
              <button onClick={() => setPlayhead(0)} aria-label="Go to beginning" title={clipCount === 0 ? "Nothing to play yet — add or generate a scene first." : "Go to beginning"} disabled={clipCount === 0}><SkipBack size={18} /></button>
              {/* Nothing to play means nothing to play: running the clock over
                  an empty timeline reads as playback of footage that isn't there. */}
              <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause" : "Play"} disabled={clipCount === 0} title={clipCount === 0 ? "Nothing to play yet — add or generate a scene first." : playing ? "Pause" : "Play"}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
              <button onClick={() => setPlayhead(Math.min(duration, playhead + 1000))} aria-label="Step forward one second" title={clipCount === 0 ? "Nothing to play yet — add or generate a scene first." : "Step forward one second"} disabled={clipCount === 0}><SkipForward size={18} /></button>
            </div>
            <span>{config.settings.resolution.toUpperCase()} · {config.settings.frameRate} fps</span>
          </div>
          {/* Measured in Chromium (the engine behind the WebView2 runtime this
              ships in): a disabled button DOES receive hover and DOES paint its
              title tooltip, so the titles above are not dead. But a tooltip is
              mouse-only — a disabled button cannot take focus, so keyboard and
              touch users have no way to reach it. The reason the transport is
              dead is stated here so it needs no pointer at all. */}
          {clipCount === 0 && <p className="transport-note">These controls stay off until there is a scene to play.</p>}
        </main>

        <aside className="clip-inspector">
          <div className="panel-chrome"><h2>Clip details</h2></div>
          {selected ? <>
            <div className="inspector-summary"><span className="clip-chip" style={{ background: selected.color ?? undefined }}><Film size={18} /></span><div><b>{selected.label}</b><small>{selectedTrack?.name} · {selected.status}</small></div></div>
            <section className="inspector-section">
              <h3>Clip</h3>
              <label><span>Name</span><input value={selected.label} onChange={(event) => updateClip(selected.id, { label: event.target.value || "Untitled clip" })} /></label>
              <div className="field-pair">
                <label><span>Starts at</span><input value={timecode(selected.startMs).slice(3)} readOnly /></label>
                <label><span>Lasts</span><input value={timecode(selected.durationMs).slice(3)} readOnly /></label>
              </div>
            </section>
            <section className="inspector-section inspector-section--pending">
              <h3>Transform <em>Not available yet</em></h3>
              <div className="field-pair">
                <label><span>Scale</span><input defaultValue="100%" disabled title={NOT_YET} /></label>
                <label><span>Rotation</span><input defaultValue="0°" disabled title={NOT_YET} /></label>
              </div>
              <div className="field-pair">
                <label><span>Position X</span><input defaultValue="0" disabled title={NOT_YET} /></label>
                <label><span>Position Y</span><input defaultValue="0" disabled title={NOT_YET} /></label>
              </div>
            </section>
            <section className="inspector-section inspector-section--pending">
              <h3>Look <em>Not available yet</em></h3>
              <label className="range-field"><span>Opacity <b>100%</b></span><input type="range" defaultValue="100" disabled title={NOT_YET} /></label>
              <label className="range-field"><span>Temperature <b>+4</b></span><input type="range" defaultValue="54" disabled title={NOT_YET} /></label>
            </section>
          </> : clipCount === 0
            ? <div className="inspector-empty"><MouseSelection /><b>Nothing to edit yet</b><span>Once a scene lands on the timeline, select it here to rename it and check its timing.</span></div>
            : <div className="inspector-empty"><MouseSelection /><b>Select a clip to edit it</b><span>Pick any clip on the timeline below to rename it, check its timing, and see how it was made.</span></div>}
        </aside>
      </div>

      <section className="pro-timeline">
        <header className="timeline-toolbar">
          <div><h2>Timeline</h2><span>{timecode(playhead)}</span></div>
          <div className="timeline-tools">
            <button onClick={addScene} title="Draft a new scene"><Plus size={16} /> Add</button>
            <button onClick={splitSelected} disabled={splitBlockedBy !== null} title={splitBlockedBy ?? "Split at playhead"}><Scissors size={16} /> Split</button>
            <button onClick={duplicateSelected} disabled={duplicateBlockedBy !== null} title={duplicateBlockedBy ?? "Duplicate clip"}><Copy size={16} /> Duplicate</button>
            <button onClick={removeSelected} disabled={deleteBlockedBy !== null} title={deleteBlockedBy ?? "Delete selected clip"}><Trash2 size={16} /> Delete</button>
          </div>
        </header>
        <div className="timeline-grid">
          <div className="track-corner"><span>Tracks</span></div>
          <div className="time-ruler" onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPlayhead(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration)); }}>
            {ticks.map((second) => <span key={second} style={{ left: `${second * 1000 / duration * 100}%` }}><i />{rulerLabel(second)}</span>)}
          </div>
          {tracks.map((track) => <TrackRow key={track.id} track={track} duration={duration} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggleTrack} />)}
          <div className="timeline-playhead" style={{ left: `calc(var(--track-column) + (100% - var(--track-column)) * ${playhead / duration})` }}><span /><i /></div>
        </div>
      </section>
    </div>
  );
}

function TrackRow({ track, duration, selectedId, onSelect, onToggle }: { track: ProjectConfig["timeline"]["tracks"][number]; duration: number; selectedId: string; onSelect: (id: string) => void; onToggle: (id: string, key: "muted" | "locked") => void }) {
  return <>
    <div className="track-head">
      <span className={`track-kind track-kind--${track.kind}`}>{track.kind === "audio" ? <Music2 size={16} /> : <Video size={16} />}</span>
      <div><b>{track.name}</b><small>{track.kind === "audio" ? "Audio" : "Video"}</small></div>
      <button className={track.muted ? "active" : ""} onClick={() => onToggle(track.id, "muted")} aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`} title={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}>{track.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <button className={track.locked ? "active" : ""} onClick={() => onToggle(track.id, "locked")} aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`} title={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}>{track.locked ? <Lock size={16} /> : <LockOpen size={16} />}</button>
    </div>
    <div className={`track-lane ${track.muted ? "muted" : ""}`}>
      {track.clips.map((clip) => <button key={clip.id} className={`timeline-clip timeline-clip--${track.kind} ${selectedId === clip.id ? "selected" : ""}`} style={{ left: `${clip.startMs / duration * 100}%`, width: `${clip.durationMs / duration * 100}%`, "--clip-color": clip.color } as React.CSSProperties} onClick={() => onSelect(clip.id)} title={`${clip.label} · ${(clip.durationMs / 1000).toFixed(1)} seconds`}><span className="clip-text"><b>{clip.label}</b><small>{track.kind === "audio" ? "▂▅▃▆▂▃▇▅▂▆▃▅▂" : `${(clip.durationMs / 1000).toFixed(1)}s · ${clip.status}`}</small></span></button>)}
    </div>
  </>;
}

function MouseSelection() { return <div className="selection-glyph"><span /><i /></div>; }
