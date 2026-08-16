import {
  Copy, Film, Image as ImageIcon, Layers3, Lock, LockOpen, Maximize2, Music2,
  Pause, Play, Plus, Scissors, SkipBack, SkipForward, Trash2, Upload, Video,
  Volume2, VolumeX, WandSparkles, ZoomIn, ZoomOut,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createDraftGenerationJob, type ProjectConfig, type TimelineClip } from "../../lib/project";

const DURATION = 34_000;
const timecode = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const frames = Math.floor((ms % 1000) / (1000 / 30));
  return `00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
};

export function TimelineView({ config, onChange, onOpenGenerator }: { config: ProjectConfig; onChange: (next: ProjectConfig) => void; onOpenGenerator: (jobId: string) => void }) {
  const firstClip = config.timeline.tracks.flatMap((track) => track.clips)[0];
  const [selectedId, setSelectedId] = useState(firstClip?.id ?? "");
  const [playhead, setPlayhead] = useState(firstClip?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [panelTab, setPanelTab] = useState<"scenes" | "media">("scenes");
  const tracks = config.timeline.tracks;
  const selected = useMemo(() => tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedId), [tracks, selectedId]);
  const selectedTrack = tracks.find((track) => track.id === selected?.trackId);
  const hasVisualOutput = config.assets.some((asset) => asset.kind === "video" || asset.kind === "image" || asset.kind === "generated")
    || config.generationJobs.some((job) => Boolean(job.outputRelativePath));

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setPlayhead((current) => current >= DURATION ? 0 : current + 100), 100);
    return () => window.clearInterval(timer);
  }, [playing]);

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
    const copy = { ...selected, id: `${selected.id}-copy-${Date.now()}`, startMs: Math.min(DURATION - selected.durationMs, selected.startMs + selected.durationMs), label: `${selected.label} copy` };
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
  const addScene = () => {
    const job = createDraftGenerationJob(`A new scene for ${config.name}. ${config.brief.prompt}`, {
      title: "New scene draft",
      referenceIds: config.references.slice(0, 2).map((reference) => reference.id),
    });
    onChange({ ...config, generationJobs: [job, ...config.generationJobs] });
    onOpenGenerator(job.id);
  };

  return (
    <div className="timeline-view" tabIndex={0} onKeyDown={(event) => {
      if ((event.key === "Delete" || event.key === "Backspace") && event.target === event.currentTarget) removeSelected();
      if (event.code === "Space" && event.target === event.currentTarget) { event.preventDefault(); setPlaying((value) => !value); }
    }}>
      <div className="edit-panels">
        <aside className="scene-panel">
          <div className="panel-tabs">
            <button className={panelTab === "scenes" ? "active" : ""} onClick={() => setPanelTab("scenes")}><Layers3 size={14} /> Scenes</button>
            <button className={panelTab === "media" ? "active" : ""} onClick={() => setPanelTab("media")}><Film size={14} /> Media</button>
          </div>
          <div className="scene-panel__head"><span>{panelTab === "scenes" ? "Story sequence" : "Project media"}</span><button aria-label="Add media"><Plus size={15} /></button></div>
          {panelTab === "scenes" ? (
            <div className="scene-list">
              {tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips).map((clip, index) => (
                <button key={clip.id} className={`scene-card scene-card--${(index % 4) + 1} ${selectedId === clip.id ? "selected" : ""}`} onClick={() => { setSelectedId(clip.id); setPlayhead(clip.startMs + 600); }}>
                  <span className="scene-card__thumb"><i>{String(index + 1).padStart(2, "0")}</i><em>{(clip.durationMs / 1000).toFixed(1)}s</em></span>
                  <span><b>{clip.label.replace(/^\d+ · /, "")}</b><small>{clip.status === "generated" ? "Needs review" : "In timeline"}</small></span>
                </button>
              ))}
              <button className="scene-add" onClick={addScene}><Plus size={15} /> Add or generate a scene</button>
            </div>
          ) : (
            <div className="media-grid">
              {config.assets.map((asset, index) => <button key={asset.id}><span className={`media-thumb media-thumb--${index % 4}`}>{asset.kind === "audio" ? <Music2 size={18} /> : asset.kind === "image" ? <ImageIcon size={18} /> : <Video size={18} />}</span><b>{asset.name}</b><small>{asset.kind} · {asset.durationMs ? `${(asset.durationMs / 1000).toFixed(1)}s` : "still"}</small></button>)}
              <button className="media-import"><Upload size={19} /><b>Import media</b><small>Files stay in this project</small></button>
            </div>
          )}
        </aside>

        <main className="program-panel">
          <div className="panel-chrome"><span><i className="live-dot" /> Program monitor</span><div><button>Fit</button><button aria-label="Fullscreen"><Maximize2 size={14} /></button></div></div>
          <div className="program-canvas">
            {hasVisualOutput ? <div className={`program-image program-image--${Math.min(4, Math.floor(playhead / 8000) + 1)}`}>
              <div className="program-image__architecture"><i /><i /><i /><i /><i /></div>
              <div className="program-image__caption"><span>NORTHERN LIGHT</span><small>Architecture for a more human city</small></div>
              <span className="safe-frame" />
            </div> : <div className="program-empty" data-testid="project-empty-monitor"><Film size={28} /><strong>{config.name}</strong><span>{config.brief.prompt}</span><small>Generated or imported footage will appear here.</small></div>}
          </div>
          <div className="monitor-transport">
            <strong>{timecode(playhead)}</strong>
            <div><button onClick={() => setPlayhead(0)} aria-label="Go to beginning"><SkipBack size={15} /></button><button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button><button onClick={() => setPlayhead(Math.min(DURATION, playhead + 1000))} aria-label="Step forward"><SkipForward size={15} /></button></div>
            <span>{config.settings.resolution.toUpperCase()} · {config.settings.frameRate} FPS</span>
          </div>
        </main>

        <aside className="clip-inspector">
          <div className="panel-chrome"><span>Inspector</span><button><WandSparkles size={13} /> Ask Pol</button></div>
          {selected ? <>
            <div className="inspector-summary"><span className="clip-chip" style={{ background: selected.color }}><Film size={15} /></span><div><b>{selected.label}</b><small>{selectedTrack?.name} · {selected.status}</small></div></div>
            <section className="inspector-section"><h3>Clip</h3><label><span>Name</span><input value={selected.label} onChange={(event) => updateClip(selected.id, { label: event.target.value || "Untitled clip" })} /></label><div className="field-pair"><label><span>Start</span><input value={timecode(selected.startMs).slice(3)} readOnly /></label><label><span>Duration</span><input value={timecode(selected.durationMs).slice(3)} readOnly /></label></div></section>
            <section className="inspector-section"><h3>Transform</h3><div className="field-pair"><label><span>Scale</span><input defaultValue="100%" /></label><label><span>Rotation</span><input defaultValue="0°" /></label></div><div className="field-pair"><label><span>Position X</span><input defaultValue="0" /></label><label><span>Position Y</span><input defaultValue="0" /></label></div></section>
            <section className="inspector-section"><h3>Look</h3><label className="range-field"><span>Opacity <b>100%</b></span><input type="range" defaultValue="100" /></label><label className="range-field"><span>Temperature <b>+4</b></span><input type="range" defaultValue="54" /></label></section>
          </> : <div className="inspector-empty"><MouseSelection /><b>Select a clip</b><span>Properties and generation details will appear here.</span></div>}
        </aside>
      </div>

      <section className="pro-timeline">
        <header className="timeline-toolbar">
          <div><strong>Timeline</strong><span>{timecode(playhead)}</span></div>
          <div className="timeline-tools"><button onClick={addScene} title="Add scene"><Plus size={14} /> Add</button><button onClick={splitSelected} disabled={!selected || selectedTrack?.locked} title="Split at playhead (S)"><Scissors size={14} /> Split</button><button onClick={duplicateSelected} disabled={!selected || selectedTrack?.locked} title="Duplicate clip"><Copy size={14} /></button><button onClick={removeSelected} disabled={!selected || selectedTrack?.locked} title="Delete selected clip"><Trash2 size={14} /></button><i /><button title="Zoom out"><ZoomOut size={14} /></button><input type="range" min="50" max="150" defaultValue="90" aria-label="Timeline zoom" /><button title="Zoom in"><ZoomIn size={14} /></button></div>
        </header>
        <div className="timeline-grid">
          <div className="track-corner"><span>TRACKS</span></div>
          <div className="time-ruler" onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPlayhead(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * DURATION)); }}>
            {[0, 5, 10, 15, 20, 25, 30].map((second) => <span key={second} style={{ left: `${second / 34 * 100}%` }}><i />00:{String(second).padStart(2, "0")}</span>)}
          </div>
          {tracks.map((track) => <TrackRow key={track.id} track={track} selectedId={selectedId} onSelect={setSelectedId} onToggle={toggleTrack} />)}
          <div className="timeline-playhead" style={{ left: `calc(156px + (100% - 156px) * ${playhead / DURATION})` }}><span /><i /></div>
        </div>
      </section>
    </div>
  );
}

function TrackRow({ track, selectedId, onSelect, onToggle }: { track: ProjectConfig["timeline"]["tracks"][number]; selectedId: string; onSelect: (id: string) => void; onToggle: (id: string, key: "muted" | "locked") => void }) {
  return <>
    <div className="track-head"><span className={`track-kind track-kind--${track.kind}`}>{track.kind === "audio" ? <Music2 size={12} /> : <Video size={12} />}</span><div><b>{track.name}</b><small>{track.kind === "audio" ? "AUDIO" : "VIDEO"}</small></div><button className={track.muted ? "active" : ""} onClick={() => onToggle(track.id, "muted")} aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}>{track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button><button className={track.locked ? "active" : ""} onClick={() => onToggle(track.id, "locked")} aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}>{track.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button></div>
    <div className={`track-lane ${track.muted ? "muted" : ""}`}>
      {track.clips.map((clip) => <button key={clip.id} className={`timeline-clip timeline-clip--${track.kind} ${selectedId === clip.id ? "selected" : ""}`} style={{ left: `${clip.startMs / DURATION * 100}%`, width: `${clip.durationMs / DURATION * 100}%`, "--clip-color": clip.color } as React.CSSProperties} onClick={() => onSelect(clip.id)} title={`${clip.label} · ${(clip.durationMs / 1000).toFixed(1)} seconds`}><span className="clip-text"><b>{clip.label}</b><small>{track.kind === "audio" ? "▂▅▃▆▂▃▇▅▂▆▃▅▂" : `${(clip.durationMs / 1000).toFixed(1)}s · ${clip.status}`}</small></span></button>)}
    </div>
  </>;
}

function MouseSelection() { return <div className="selection-glyph"><span /><i /></div>; }
