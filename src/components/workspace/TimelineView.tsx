import {
  Copy, Film, Layers3, LayoutGrid, List, Lock, LockOpen, Music2,
  Pause, Play, Plus, Scissors, SkipBack, SkipForward, Trash2, Upload, Video,
  Volume2, VolumeX,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { importMediaFiles, isTauri } from "../../lib/persistence";
import { loadMediaLayout, saveMediaLayout, type MediaLayout } from "../../lib/settings";
import type { ProjectAsset, ProjectConfig, TimelineClip } from "../../lib/project";
import { MediaThumbnail } from "./MediaThumbnail";

const MIN_DURATION = 10_000;
const NOT_YET = "Not available yet. This control doesn’t change your project.";
/* What a dropped media file is worth on the timeline until PolStudio can read
   its real length. Imported assets carry no duration — nothing has decoded
   them — so the clip starts at a stated default and the inspector's Lasts
   field is editable so the user can set the truth. */
const DROPPED_CLIP_MS = 5_000;
/* The drag payload is the asset id. A custom type keeps files dragged in from
   the desktop, and text dragged from anywhere else, out of the drop handler. */
const ASSET_DRAG_TYPE = "application/x-polstudio-asset";

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

export function TimelineView({ config, folderPath, onChange, onOpenGenerator }: { config: ProjectConfig; folderPath: string; onChange: (next: ProjectConfig) => void; onOpenGenerator: (jobId?: string) => void }) {
  const firstClip = config.timeline.tracks.flatMap((track) => track.clips)[0];
  const [selectedId, setSelectedId] = useState(firstClip?.id ?? "");
  const [playhead, setPlayhead] = useState(firstClip?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [panelTab, setPanelTab] = useState<"scenes" | "media">("scenes");
  /* Grid reads a folder of footage by its pictures, list reads it by its
     names. Which one a cutter wants is a habit, not a per-project choice, so
     it is remembered on this machine rather than written into the project. */
  const [mediaLayout, setMediaLayout] = useState<MediaLayout>(loadMediaLayout);
  const timelineGrid = useRef<HTMLDivElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  /* Which track the pointer is currently over with a compatible asset, so the
     lane can light up. A drop target the user cannot see is a drop target the
     user will not find. */
  const [dropTrackId, setDropTrackId] = useState<string | null>(null);
  /* The asset currently under the pointer. Browsers withhold dataTransfer's
     payload until the drop event, so a dragover handler cannot read the id it
     is being offered — it can only see the TYPE. Remembering what dragstart
     put there is the only way to know whether this lane can take it. */
  const [draggedAsset, setDraggedAsset] = useState<ProjectAsset | undefined>(undefined);
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

  /* Wheel over the timeline scrubs it. Registered by hand rather than with
     React's onWheel because React attaches wheel listeners passively, and a
     passive listener cannot preventDefault — without that the project content
     scrolls away under the pointer while the playhead moves.

     A notch is one second; hold Shift for one frame. deltaMode says what the
     browser's numbers mean (pixels, lines, or pages), so normalise to notches
     instead of treating a trackpad's pixel deltas as a thousand of them. */
  useEffect(() => {
    const grid = timelineGrid.current;
    if (!grid) return;
    const onWheel = (event: WheelEvent) => {
      const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (raw === 0) return;
      event.preventDefault();
      const notches = event.deltaMode === 0 ? raw / 100 : event.deltaMode === 1 ? raw / 3 : raw;
      const stepMs = event.shiftKey ? 1000 / config.settings.frameRate : 1000;
      setPlaying(false);
      setPlayhead((current) => Math.round(Math.max(0, Math.min(duration, current + notches * stepMs))));
    };
    grid.addEventListener("wheel", onWheel, { passive: false });
    return () => grid.removeEventListener("wheel", onWheel);
  }, [duration, config.settings.frameRate]);

  const chooseMediaLayout = (layout: MediaLayout) => { setMediaLayout(layout); saveMediaLayout(layout); };
  const updateTracks = (nextTracks: ProjectConfig["timeline"]["tracks"]) => onChange({ ...config, timeline: { tracks: nextTracks } });
  const renameTrack = (trackId: string, name: string) => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, name } : track));
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
  /* Same rule again for the transport: every one of its controls is off for the
     same reason, and saying that reason is the difference between a disabled
     button and a broken one. */
  const transportBlockedBy = clipCount === 0 ? "Nothing to play yet — add or generate a scene first." : null;
  const importMedia = async () => {
    setImportError(null);
    setImporting(true);
    try {
      const imported = await importMediaFiles(folderPath);
      if (imported.length === 0) return;
      const now = new Date().toISOString();
      const assets: ProjectAsset[] = imported.map((file) => ({
        id: `asset-${crypto.randomUUID()}`,
        kind: file.kind,
        name: file.name,
        relativePath: file.relativePath,
        mimeType: file.mimeType,
        // Genuinely unknown until something decodes the file. Left null rather
        // than filled with a plausible number.
        durationMs: null,
        width: null,
        height: null,
        createdAt: now,
      }));
      onChange({ ...config, assets: [...config.assets, ...assets] });
      setPanelTab("media");
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };

  /* A video or image belongs on a video track and a sound on an audio track;
     dropping either on the other would make a clip nothing can ever play. */
  const acceptsAsset = (track: ProjectConfig["timeline"]["tracks"][number], asset: ProjectAsset | undefined) => {
    if (!asset || track.locked) return false;
    return track.kind === "audio" ? asset.kind === "audio" : asset.kind !== "audio";
  };

  const assetById = (id: string) => config.assets.find((asset) => asset.id === id);

  const dropAsset = (trackId: string, assetId: string, ratio: number) => {
    const track = tracks.find((item) => item.id === trackId);
    const asset = assetById(assetId);
    if (!track || !acceptsAsset(track, asset) || !asset) return;
    const durationMs = asset.durationMs && asset.durationMs > 0 ? asset.durationMs : DROPPED_CLIP_MS;
    /* Clamp so a drop near the right edge still lands a whole clip on the
       ruler, against THIS clip's length rather than the 5s default — a long
       import dropped at the end used to run off the end of the canvas.
       Math.max last, because a clip longer than the whole canvas makes
       `duration - durationMs` negative and 0 is the only honest start.
       A non-finite ratio (a zero-width lane, a lane that has not been laid out
       yet) would carry NaN into startMs, which zod then refuses to save. */
    const position = Number.isFinite(ratio) ? ratio * duration : 0;
    const startMs = Math.round(Math.max(0, Math.min(duration - durationMs, position)));
    const clip: TimelineClip = {
      id: `clip-${crypto.randomUUID()}`,
      assetId: asset.id,
      trackId: track.id,
      startMs,
      durationMs,
      sourceStartMs: 0,
      label: asset.name,
      color: null,
      status: "approved",
    };
    updateTracks(tracks.map((item) => item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item));
    setSelectedId(clip.id);
  };

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
          <div className="scene-panel__head">
            <h2>{panelTab === "scenes" ? "Story sequence" : "Project media"}</h2>
            {panelTab === "media" && (
              <div className="layout-toggle" role="group" aria-label="Media layout">
                <button
                  className={mediaLayout === "grid" ? "active" : ""}
                  aria-pressed={mediaLayout === "grid"}
                  onClick={() => chooseMediaLayout("grid")}
                  title="Show media as a grid of pictures"
                ><LayoutGrid size={16} /><span className="sr-only">Grid</span></button>
                <button
                  className={mediaLayout === "list" ? "active" : ""}
                  aria-pressed={mediaLayout === "list"}
                  onClick={() => chooseMediaLayout("list")}
                  title="Show media as a list"
                ><List size={16} /><span className="sr-only">List</span></button>
              </div>
            )}
          </div>
          {panelTab === "scenes" ? (
            <div className="scene-list">
              {sceneClips.map((clip, index) => (
                <button key={clip.id} className={`scene-card ${selectedId === clip.id ? "selected" : ""}`} onClick={() => { setSelectedId(clip.id); setPlayhead(clip.startMs + 600); }}>
                  <span className="scene-card__thumb"><i>{String(index + 1).padStart(2, "0")}</i><em>{(clip.durationMs / 1000).toFixed(1)}s</em></span>
                  <span><b>{clip.label.replace(/^\d+ · /, "")}</b><small>{clip.status === "generated" ? "Needs review" : "In timeline"}</small></span>
                </button>
              ))}
              <button className="scene-add" onClick={addScene}><Plus size={18} /> Add or generate a scene</button>
            </div>
          ) : (
            <div className={`media-grid media-grid--${mediaLayout}`}>
              {/* Draggable onto the timeline. `draggable` on a <button> is the
                  whole mechanism — the button still clicks and still takes
                  focus, so keyboard users are not shut out of selecting it. */}
              {config.assets.map((asset) => <button
                key={asset.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                  event.dataTransfer.effectAllowed = "copy";
                  setDraggedAsset(asset);
                }}
                onDragEnd={() => { setDraggedAsset(undefined); setDropTrackId(null); }}
                title={`${asset.name} — drag onto a ${asset.kind === "audio" ? "sound" : "video"} track below`}
              >
                <MediaThumbnail folderPath={folderPath} asset={asset} />
                <b>{asset.name}</b>
                {/* Duration is only claimed when something actually measured it. */}
                <small>{asset.kind}{asset.durationMs ? ` · ${(asset.durationMs / 1000).toFixed(1)}s` : ""}</small>
              </button>)}
              <button
                className="media-import"
                onClick={() => void importMedia()}
                disabled={importing || !isTauri()}
                title={isTauri() ? "Copy video, sound, or image files into this project" : "Importing files is available in the desktop app"}
              >
                <Upload size={20} /><b>{importing ? "Importing…" : "Import media"}</b>
              </button>
              {importError && <p className="panel-hint panel-hint--error" role="alert">{importError}</p>}
            </div>
          )}
        </aside>

        <main className="program-panel">
          <h2 className="sr-only">Program monitor</h2>
          <div className="program-canvas">
            {/* An empty monitor is an empty monitor: the panel that used to sit
                here restated the project's name and prompt — both already in the
                topbar — to say nothing was playing, which the black picture says
                by itself. The note about footage that exists but cannot be played
                back yet is worth making, but only once something is actually cut
                into the timeline; over an empty edit it was a panel about
                nothing, covering the picture. */}
            {hasVisualOutput && clipCount > 0 && (
              <div className="program-empty program-empty--footage">
                <Film size={30} />
                <strong>{config.name}</strong>
                <span>{config.brief.prompt}</span>
                <small>PolStudio can’t play this footage back yet. {clipCount === 1 ? "1 clip is" : `${clipCount} clips are`} arranged on the timeline below and nothing has been lost.</small>
              </div>
            )}
          </div>
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
          <h2>Timeline</h2>
          {/* The transport belongs to the timeline, not to the picture: it drives
              the playhead, and the playhead is drawn a few pixels below this row.
              Under the monitor it also printed the same timecode this toolbar was
              already printing, so one clock was shown twice and could be read as
              two. One transport, one timecode, beside the ruler they refer to. */}
          <div className="timeline-transport">
            <button onClick={() => setPlayhead(0)} aria-label="Go to beginning" title={transportBlockedBy ?? "Go to beginning"} disabled={transportBlockedBy !== null}><SkipBack size={18} /></button>
            {/* Nothing to play means nothing to play: running the clock over an
                empty timeline reads as playback of footage that isn't there. */}
            <button className="play-button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause" : "Play"} disabled={transportBlockedBy !== null} title={transportBlockedBy ?? (playing ? "Pause" : "Play")}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
            <button onClick={() => setPlayhead(Math.min(duration, playhead + 1000))} aria-label="Step forward one second" title={transportBlockedBy ?? "Step forward one second"} disabled={transportBlockedBy !== null}><SkipForward size={18} /></button>
            <strong className="transport-time" title="Playhead position">{timecode(playhead)}</strong>
            <span className="transport-format">{config.settings.resolution.toUpperCase()} · {config.settings.frameRate} fps</span>
          </div>
          <div className="timeline-tools">
            <button onClick={addScene} title="Draft a new scene"><Plus size={16} /> Add</button>
            <button onClick={splitSelected} disabled={splitBlockedBy !== null} title={splitBlockedBy ?? "Split at playhead"}><Scissors size={16} /> Split</button>
            <button onClick={duplicateSelected} disabled={duplicateBlockedBy !== null} title={duplicateBlockedBy ?? "Duplicate clip"}><Copy size={16} /> Duplicate</button>
            <button onClick={removeSelected} disabled={deleteBlockedBy !== null} title={deleteBlockedBy ?? "Delete selected clip"}><Trash2 size={16} /> Delete</button>
          </div>
        </header>
        <div className="timeline-grid" ref={timelineGrid} title="Scroll to scrub. Hold Shift for one frame at a time.">
          <div className="track-corner"><span>Tracks</span></div>
          <div className="time-ruler" onPointerDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setPlayhead(Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration)); }}>
            {ticks.map((second) => <span key={second} style={{ left: `${second * 1000 / duration * 100}%` }}><i />{rulerLabel(second)}</span>)}
          </div>
          {tracks.map((track) => <TrackRow
            key={track.id}
            track={track}
            duration={duration}
            selectedId={selectedId}
            dropActive={dropTrackId === track.id}
            /* A lane that stays dark is indistinguishable from a lane the
               pointer simply is not over, so a sound held above a video track
               looked like it had not been picked up rather than like it was
               being refused. Marked for the whole drag, not just on hover. */
            dropBlocked={draggedAsset !== undefined && !acceptsAsset(track, draggedAsset)}
            onSelect={setSelectedId}
            onToggle={toggleTrack}
            onRename={renameTrack}
            onDragOverLane={(event) => {
              if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
              if (!acceptsAsset(track, draggedAsset)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropTrackId(track.id);
            }}
            onDragLeaveLane={() => setDropTrackId((current) => current === track.id ? null : current)}
            onDropLane={(event) => {
              event.preventDefault();
              setDropTrackId(null);
              const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
              if (!assetId) return;
              const rect = event.currentTarget.getBoundingClientRect();
              // A zero-width lane would make the ratio NaN and the clip's start
              // time with it, which zod then refuses to save.
              dropAsset(track.id, assetId, rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0);
            }}
          />)}
          <div className="timeline-playhead" style={{ left: `calc(var(--track-column) + (100% - var(--track-column)) * ${playhead / duration})` }}><span /><i /></div>
        </div>
      </section>
    </div>
  );
}

function TrackRow({ track, duration, selectedId, dropActive, dropBlocked, onSelect, onToggle, onRename, onDragOverLane, onDragLeaveLane, onDropLane }: {
  track: ProjectConfig["timeline"]["tracks"][number];
  duration: number;
  selectedId: string;
  dropActive: boolean;
  dropBlocked: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string, key: "muted" | "locked") => void;
  onRename: (id: string, name: string) => void;
  onDragOverLane: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeaveLane: () => void;
  onDropLane: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  return <>
    <div className="track-head">
      <span className={`track-kind track-kind--${track.kind}`}>{track.kind === "audio" ? <Music2 size={16} /> : <Video size={16} />}</span>
      {/* The name is an editable field, not a label: a project with three video
          layers needs the user's own words on them, and an always-live input
          needs no discovery. Blanking it falls back the way a clip name does,
          because the schema has no room for a nameless track. */}
      <div><input
        className="track-name"
        value={track.name}
        aria-label={`Rename ${track.name}`}
        title="Rename this track"
        onChange={(event) => onRename(track.id, event.target.value || "Untitled track")}
      /><small>{track.kind === "audio" ? "Audio" : "Video"}</small></div>
      <button className={track.muted ? "active" : ""} onClick={() => onToggle(track.id, "muted")} aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`} title={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}>{track.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <button className={track.locked ? "active" : ""} onClick={() => onToggle(track.id, "locked")} aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`} title={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}>{track.locked ? <Lock size={16} /> : <LockOpen size={16} />}</button>
    </div>
    <div
      className={`track-lane ${track.muted ? "muted" : ""} ${dropActive ? "track-lane--drop" : ""} ${dropBlocked ? "track-lane--reject" : ""}`}
      title={dropBlocked ? (track.locked ? `${track.name} is locked` : `${track.name} only takes ${track.kind === "audio" ? "sound" : "video and pictures"}`) : undefined}
      onDragOver={onDragOverLane}
      onDragLeave={onDragLeaveLane}
      onDrop={onDropLane}
    >
      {track.clips.map((clip) => <button key={clip.id} className={`timeline-clip timeline-clip--${track.kind} ${selectedId === clip.id ? "selected" : ""}`} style={{ left: `${clip.startMs / duration * 100}%`, width: `${clip.durationMs / duration * 100}%`, "--clip-color": clip.color } as React.CSSProperties} onClick={() => onSelect(clip.id)} title={`${clip.label} · ${(clip.durationMs / 1000).toFixed(1)} seconds`}><span className="clip-text"><b>{clip.label}</b><small>{track.kind === "audio" ? "▂▅▃▆▂▃▇▅▂▆▃▅▂" : `${(clip.durationMs / 1000).toFixed(1)}s · ${clip.status}`}</small></span></button>)}
    </div>
  </>;
}

function MouseSelection() { return <div className="selection-glyph"><span /><i /></div>; }
