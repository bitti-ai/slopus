import {
  Copy, Film, Layers3, LayoutGrid, List, Lock, LockOpen, Music2,
  Pause, Play, Plus, Scissors, SkipBack, SkipForward, Trash2, Upload, Video,
  Volume2, VolumeX, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolutionLabel } from "../../lib/export";
import { importMediaFiles, isTauri } from "../../lib/persistence";
import { loadMediaLayout, saveMediaLayout, type MediaLayout } from "../../lib/settings";
import {
  clipLook,
  clipTransform,
  clipTransition,
  generationAssetId,
  sceneDurationSeconds,
  type GenerationJob,
  type ProjectAsset,
  type ProjectConfig,
  type TimelineClip,
  type TimelineTrack,
} from "../../lib/project";
import {
  clipEndMs, findClip, insertClip, moveClip, removeClip, snapTargets, sourceRoom, trimClip,
  type SnapOptions, type SourceRoom,
} from "../../lib/timeline";
import { MediaThumbnail, type MeasuredMedia } from "./MediaThumbnail";
import { ProgramMonitor } from "./ProgramMonitor";
import { sceneShape, STATUS_WORD } from "./sceneStatus";
import { ShotThumbnail } from "./ShotThumbnail";
import { CommittedNumberInput } from "./CommittedNumberInput";

const MIN_DURATION = 10_000;
/* How long a dropped clip is when the file itself cannot say.
   A drop normally lasts as long as the footage: the media panel decodes each
   file to draw its thumbnail and records the duration it read there (see
   MediaThumbnail), so a 40-second rush drops as 40 seconds. This default
   covers the two cases where there is no such number — a still image, which
   has no length of its own, and a file the browser opened but could not
   measure. */
const DROPPED_CLIP_MS = 5_000;
/* The drag payload is the asset id. A custom type keeps files dragged in from
   the desktop, and text dragged from anywhere else, out of the drop handler. */
const ASSET_DRAG_TYPE = "application/x-polstudio-asset";
const SCENE_DRAG_TYPE = "application/x-polstudio-generator-scene";

/* How close two edges have to be ON SCREEN before they snap together. In
   pixels, not milliseconds, because that is how close they LOOK — the same
   8px feels the same on a 20-second timeline and a 10-minute one, where a fixed
   number of milliseconds would be unusable at one end and invisible at the
   other. Converted against the lane's real width at the moment a drag starts. */
const SNAP_PX = 8;
/* Below this, a press is a click. Without it the smallest tremor between
   pointerdown and pointerup would be read as a drag and a clip that was only
   being selected would be nudged off its cut. */
const DRAG_THRESHOLD_PX = 3;

type DragMode = "move" | "trim-start" | "trim-end";

/** One drag, from the press that began it. Everything the pointer needs is
 *  measured ONCE, here: the lane's geometry, what may be snapped to, and how
 *  much footage the file has left at each end. Re-measuring per pointermove
 *  would let a re-render mid-drag change the arithmetic under the pointer.
 *
 *  `baseTracks` is the timeline as it stood when the drag began, and every
 *  preview is computed from it rather than from the last preview — so dragging
 *  back to where you started really does put the clip back. */
interface DragSession {
  clipId: string;
  mode: DragMode;
  baseTracks: TimelineTrack[];
  laneLeftPx: number;
  msPerPx: number;
  /** Where inside the clip the pointer took hold, so the clip does not jump so
   *  its head is under the cursor. Move only. */
  grabOffsetMs: number;
  startXPx: number;
  snap: SnapOptions;
  room: SourceRoom;
  moved: boolean;
}

/** Which lane the pointer is over, for a drag that has left the lane it started
 *  in. Read from the document rather than from React state because the pointer
 *  is captured elsewhere: what is under it is a question only the DOM can
 *  answer. jsdom has no hit-testing, so a missing method means "the lane it
 *  started on", not a crash. */
function trackIdAtPoint(x: number, y: number): string | undefined {
  if (typeof document.elementsFromPoint !== "function") return undefined;
  for (const element of document.elementsFromPoint(x, y)) {
    const lane = (element as HTMLElement).closest?.("[data-track-id]") as HTMLElement | null;
    if (lane?.dataset.trackId) return lane.dataset.trackId;
  }
  return undefined;
}

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

const parseDuration = (value: string, frameRate: number): number | null => {
  const parts = value.trim().split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part.trim()))) return null;
  const numbers = parts.map((part) => Number(part));
  const frames = parts.length === 3 ? numbers[2] * (1000 / frameRate) : 0;
  const seconds = parts.length === 1 ? numbers[0] : numbers[0] * 60 + numbers[1];
  return Math.round(seconds * 1000 + frames);
};

/** How a view hands a project back. An updater rather than a plain value is
 *  the only safe form for a write built from something asynchronous: the
 *  holder applies it to its LATEST config, so a write does not depend on the
 *  previous one having already come back down as a prop. */
export type ConfigUpdate = ProjectConfig | ((current: ProjectConfig) => ProjectConfig);

export function TimelineView({ config, folderPath, generationCompletionTimes = {}, onChange, onMeasured, onOpenGenerator }: {
  config: ProjectConfig;
  folderPath: string;
  generationCompletionTimes?: Readonly<Record<string, number>>;
  onChange: (next: ConfigUpdate) => void;
  /** What a decode learned about a file the project already had — a length, a
   *  size. Worth keeping, but the user did not edit anything by looking at the
   *  Media panel, so the holder records it WITHOUT marking the project unsaved.
   *  Omitted, measurements go back through onChange like any other change. */
  onMeasured?: (update: (current: ProjectConfig) => ProjectConfig) => void;
  onOpenGenerator: (jobId?: string) => void;
}) {
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
  const [draggedScene, setDraggedScene] = useState<GenerationJob | undefined>(undefined);
  const [durationDraft, setDurationDraft] = useState<string | null>(null);
  /* What the user is typing into Lasts, while they are typing it. The field
     otherwise shows the clip's own length, and "00:0" on the way to "00:08"
     must not be snapped back to a formatted timecode mid-keystroke. Null means
     nothing is being typed and the clip speaks for itself. */
  /* A drag in flight, and the timeline as it would be if the pointer were
     released right now. The lanes draw the preview, and the release commits
     exactly it — the drag and the edit are the same calculation, run twice
     (see src/lib/timeline.ts). Null means the move is refused from here: the
     clip is drawn where it really is, which is the honest answer to "no". */
  const dragRef = useRef<DragSession | null>(null);
  const previewRef = useRef<TimelineTrack[] | null>(null);
  const [preview, setPreview] = useState<TimelineTrack[] | null>(null);
  const [dragging, setDragging] = useState(false);
  /* Whether the pointer is currently dragging the playhead along the ruler.
     A press alone moves it once; this is what makes the moves keep coming. */
  const [scrubbing, setScrubbing] = useState(false);
  const tracks = config.timeline.tracks;
  const selected = useMemo(() => tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedId), [tracks, selectedId]);
  const selectedTrack = tracks.find((track) => track.id === selected?.trackId);
  const selectedTransform = selected ? clipTransform(selected) : null;
  const selectedLook = selected ? clipLook(selected) : null;
  const selectedTransition = selected ? clipTransition(selected) : null;
  const visualControlsDisabled = selectedTrack?.kind !== "video" || selectedTrack.locked;
  const clipCount = tracks.reduce((total, track) => total + track.clips.length, 0);
  /** Where the last clip ends — where playback stops, which is not the same as
   *  where the ruler stops (the canvas is at least as long as the film the user
   *  asked for, however little of it is cut yet). */
  const contentEndMs = tracks.reduce((end, track) => track.clips.reduce((furthest, clip) => Math.max(furthest, clipEndMs(clip)), end), 0);
  const duration = useMemo(() => canvasDuration(config), [config]);
  const mediaAssets = useMemo(() => config.assets.filter((asset) => asset.kind !== "generated"), [config.assets]);
  const ticks = useMemo(() => rulerTicks(duration), [duration]);
  /* The lanes are ruled at the SAME interval as the ruler above them, so a line
     under a clip is a line under a number. They used to be a fixed 14.7% of the
     width — a spacing that meant nothing at any duration, and drifted further
     from the labels the longer the project got. */
  const tickStepMs = (ticks.length > 1 ? ticks[1] - ticks[0] : Math.max(1, Math.ceil(duration / 1000))) * 1000;

  useEffect(() => { if (clipCount === 0 && playing) setPlaying(false); }, [clipCount, playing]);

  /* The playhead is driven by the program monitor while playing — it reads
     where the decoder actually is, so the picture and the playhead cannot
     drift apart. These two are handed down rather than declared inline
     because the monitor's animation loop depends on their identity: a new
     closure per render would tear its clock down sixty times a second. */
  const seek = useCallback((ms: number) => setPlayhead(ms), []);
  const setPlayingFromMonitor = useCallback((value: boolean) => setPlaying(value), []);

  useEffect(() => { setDurationDraft(null); }, [selectedId]);

  // Another clip, another length: what was being typed belonged to the old one.

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

  /** Any highlight the press just painted, undone. The chrome down here is not
   *  selectable at all (see .pro-timeline), but a gesture can begin on a clip
   *  and travel over the panels above, and a selection that was already in
   *  progress goes on extending under the pointer. Clearing it at the start of
   *  a gesture is the difference between dragging a clip and dragging a clip
   *  through a blue smear. */
  const dropSelection = () => window.getSelection?.()?.removeAllRanges();

  /** Turn a pointer position on the ruler into a playhead position. A ruler
   *  nothing has laid out has no scale, so it is left alone rather than
   *  sending the playhead to NaN. */
  const scrubTo = (ruler: HTMLElement, clientX: number) => {
    const rect = ruler.getBoundingClientRect();
    if (rect.width <= 0) return;
    setPlayhead(Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration));
  };

  const chooseMediaLayout = (layout: MediaLayout) => { setMediaLayout(layout); saveMediaLayout(layout); };
  /* Every timeline write hands up an UPDATER rather than a finished config,
     for the same reason measurements do (see recordMeasured, and ConfigUpdate).
     A finished config is built from the props THIS render closed over, and the
     timeline is not always the most recent thing written: the media panel is
     recording what its decodes measured the whole time a folder is being
     imported, and a drag holds the timeline as it stood when the press began.
     Handing up `{ ...config, timeline }` from either would take those
     measurements back out again — a rush that had just learned it was 40
     seconds long would go back to being an unmeasured file, and the next drop
     of it would be a 5-second stand-in. */
  const updateTracks = (nextTracks: ProjectConfig["timeline"]["tracks"]) =>
    onChange((current) => ({ ...current, timeline: { tracks: nextTracks } }));
  const renameTrack = (trackId: string, name: string) => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, name } : track));
  const updateClip = (clipId: string, updates: Partial<TimelineClip>) => updateTracks(tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...updates } : clip) })));
  const updateTransform = (key: keyof NonNullable<TimelineClip["transform"]>, value: number) => {
    if (!selected || !selectedTransform || !Number.isFinite(value)) return;
    const limits = { scale: [10, 400], rotation: [-180, 180], positionX: [-100, 100], positionY: [-100, 100] } as const;
    const [minimum, maximum] = limits[key];
    updateClip(selected.id, { transform: { ...selectedTransform, [key]: Math.max(minimum, Math.min(maximum, value)) } });
  };
  const updateLook = (key: keyof NonNullable<TimelineClip["look"]>, value: number) => {
    if (!selected || !selectedLook || !Number.isFinite(value)) return;
    const limits = { opacity: [0, 100], temperature: [-100, 100] } as const;
    const [minimum, maximum] = limits[key];
    updateClip(selected.id, { look: { ...selectedLook, [key]: Math.max(minimum, Math.min(maximum, value)) } });
  };
  const toggleTrack = (trackId: string, key: "muted" | "locked") => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, [key]: !track[key] } : track));
  /* Every removal — the toolbar, the key, the × on the clip itself — goes
     through one function, so a locked track refuses all three. */
  const deleteClip = (clipId: string) => {
    const next = removeClip(tracks, clipId);
    if (!next) return;
    updateTracks(next);
    setSelectedId((current) => (current === clipId ? "" : current));
  };
  const removeSelected = () => { if (selected) deleteClip(selected.id); };
  const duplicateSelected = () => {
    if (!selected || !selectedTrack || selectedTrack.locked) return;
    /* The spread carries sourceStartMs with everything else, so duplicating a
       clip that was split off the middle of a rush copies THAT range of the
       footage, not the head of the file. Only the id, the position on the
       ruler, and the name are new. */
    const copy = { ...selected, id: `${selected.id}-copy-${Date.now()}`, label: `${selected.label} copy` };
    // Straight after the original if that is free, and otherwise wherever the
    // lane has room: a copy laid on top of another clip is not a copy of the
    // cut, it is two clips claiming one moment.
    const next = insertClip(tracks, selected.trackId, copy, selected.startMs + selected.durationMs);
    if (!next) return;
    updateTracks(next);
    setSelectedId(copy.id);
  };
  const splitSelected = () => {
    if (!selected || !selectedTrack || selectedTrack.locked || playhead <= selected.startMs || playhead >= selected.startMs + selected.durationMs) return;
    const leftDuration = playhead - selected.startMs;
    const right: TimelineClip = { ...selected, id: `${selected.id}-split-${Date.now()}`, startMs: playhead, durationMs: selected.durationMs - leftDuration, sourceStartMs: selected.sourceStartMs + leftDuration, label: `${selected.label} · B`, transition: undefined };
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
        // Images are copied in; video and sound are left where they are and
        // carry an absolute path instead. Exactly one of the two is set.
        relativePath: file.relativePath,
        sourcePath: file.sourcePath,
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

  const acceptsScene = (track: ProjectConfig["timeline"]["tracks"][number] | undefined, scene: GenerationJob | undefined) =>
    Boolean(scene && track && !track.locked && track.kind === "video");

  const assetById = (id: string) => config.assets.find((asset) => asset.id === id);

  /* The media panel decodes each file to draw its thumbnail, and hands back
     what that decode measured. Written onto the asset, that is what makes the
     NEXT drop as long as the footage — and it means the file is read once for
     it, not once per drop.
     Only fields nothing knew yet are filled: a measurement never overwrites a
     number already on the asset, and it never retimes a clip already cut into
     the timeline, which is the cut's decision and not the file's. */
  const applyMeasured = (asset: ProjectAsset, value: MeasuredMedia): ProjectAsset => ({
    ...asset,
    durationMs: asset.durationMs ?? value.durationMs,
    width: asset.width ?? value.width,
    height: asset.height ?? value.height,
  });
  /* Measurements arrive from asynchronous decodes, and two of them can land
     between one render and the next. They queue here so that two arriving in
     the same render are not written one over the other — but the queue alone
     never fixed the real race, which is between two FLUSHES rather than two
     measurements. `{ ...config, assets }` is built from the config THIS render
     closed over, and the second flush can run before the first write has come
     back down as a new prop: it then rebuilds the whole config from the stale
     one and the first measurement is gone. With five files decoding at their
     own speeds that lost most of them, non-deterministically, and the only cure
     was leaving the panel and re-reading every file from disk.

     So nothing here writes a config. It hands up an UPDATER, which the holder
     applies to whatever its latest config is — a flush can no longer be stale,
     because it no longer carries a config of its own. The queue is drained into
     a local BEFORE the updater is built, so the updater stays pure and can be
     called twice (StrictMode, a replayed render) without eating the queue. */
  const measurements = useRef(new Map<string, MeasuredMedia>());
  const [measureTick, setMeasureTick] = useState(0);
  const recordMeasured = (assetId: string, value: MeasuredMedia) => {
    measurements.current.set(assetId, value);
    setMeasureTick((tick) => tick + 1);
  };
  const learn = onMeasured ?? onChange;
  useEffect(() => {
    if (measurements.current.size === 0) return;
    const pending = measurements.current;
    measurements.current = new Map();
    learn((current) => {
      let learned = false;
      const assets = current.assets.map((asset) => {
        const value = pending.get(asset.id);
        if (!value) return asset;
        const next = applyMeasured(asset, value);
        if (next.durationMs === asset.durationMs && next.width === asset.width && next.height === asset.height) return asset;
        learned = true;
        return next;
      });
      // Nothing new is not a change: handing back the same config leaves React
      // with nothing to render and the holder with nothing to record, rather
      // than marking the project edited for having been looked at.
      return learned ? { ...current, assets } : current;
    });
  }, [measureTick, learn]);

  /* A trim, typed. The source is the ceiling when its length is known — a clip
     cannot play footage the file does not have — and one frame is the floor,
     because zod wants a positive whole number of milliseconds and a clip
     shorter than a frame cannot be shown. A still has no source length, so it
     is only bounded from below. */
  const selectedAsset = selected ? assetById(selected.assetId) : undefined;
  const sourceLimitMs = selected && selectedAsset?.kind !== "image" && selectedAsset?.durationMs
    ? Math.max(1, selectedAsset.durationMs - selected.sourceStartMs)
    : null;
  const minClipMs = Math.max(1, Math.round(1000 / config.settings.frameRate));
  /** What the FILE has left at each end of a clip. A still image and a file
   *  nothing has measured have no source timeline to run out of, and get no
   *  limit rather than a guessed one. */
  const roomFor = (clip: TimelineClip) => {
    const asset = assetById(clip.assetId);
    return sourceRoom(clip, asset && asset.kind !== "image" ? asset.durationMs ?? null : null);
  };
  const typeDuration = (value: string) => {
    setDurationDraft(value);
    const parsed = selected ? parseDuration(value, config.settings.frameRate) : null;
    if (parsed === null || !selected) return;
    const next = trimClip(tracks, selected.id, "end", selected.startMs + parsed, { minClipMs, room: roomFor(selected) });
    if (next) updateTracks(next);
  };
  /* Typing a length is trimming the tail, so it is the same operation the
     right-hand handle performs — same floor of one frame, same ceiling in the
     footage, and the same refusal to grow over the next clip on the track. */
  /* Snapping, measured against a lane that is `widthPx` wide. A lane nothing
     has laid out yet — jsdom, a panel that has never been painted — gives a
     tolerance of 0, which turns the magnet off instead of inventing a scale. */
  const snapFor = (widthPx: number, excludeClipId?: string): SnapOptions => ({
    targets: snapTargets(tracks, { excludeClipId, playheadMs: playhead }),
    toleranceMs: widthPx > 0 ? (SNAP_PX * duration) / widthPx : 0,
  });

  const dropAsset = (trackId: string, assetId: string, ratio: number, laneWidthPx: number) => {
    const track = tracks.find((item) => item.id === trackId);
    const asset = assetById(assetId);
    if (!track || !acceptsAsset(track, asset) || !asset) return;
    /* As long as the footage, when the footage has said how long it is. A still
       image and a file nothing could measure have no length to honour, so they
       get the stated default — see DROPPED_CLIP_MS. */
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
    /* The same placement a dragged clip gets: snapped to the cuts already on
       the timeline, and butted up against whatever is in the way rather than
       laid on top of it. A lane with no room at all refuses the drop. */
    const next = insertClip(tracks, track.id, clip, startMs, snapFor(laneWidthPx));
    if (!next) return;
    updateTracks(next);
    setSelectedId(clip.id);
  };

  /** Put a Generator scene in the cut whether or not it has a file yet. The
   * generated asset is intentionally locationless while the scene is a draft;
   * the generation event fills in its canonical MP4 path when it finishes. */
  const dropScene = (trackId: string, jobId: string, ratio: number, laneWidthPx: number) => {
    const job = config.generationJobs.find((candidate) => candidate.id === jobId);
    const track = tracks.find((candidate) => candidate.id === trackId);
    if (!job || !acceptsScene(track, job)) return;

    const clipId = `clip-${crypto.randomUUID()}`;
    onChange((current) => {
      const currentJob = current.generationJobs.find((candidate) => candidate.id === jobId);
      const currentTrack = current.timeline.tracks.find((candidate) => candidate.id === trackId);
      if (!currentJob || !currentTrack || !acceptsScene(currentTrack, currentJob)) return current;

      const plannedAssetId = generationAssetId(currentJob.id);
      const existing = current.assets.find((asset) => asset.id === plannedAssetId)
        ?? (currentJob.outputRelativePath
          ? current.assets.find((asset) => asset.kind === "generated" && asset.relativePath === currentJob.outputRelativePath)
          : undefined);
      const sceneLengthMs = Math.max(minClipMs, Math.round(sceneDurationSeconds(currentJob) * 1000));
      const asset: ProjectAsset = existing ?? {
        id: plannedAssetId,
        kind: "generated",
        name: currentJob.title,
        relativePath: currentJob.outputRelativePath ?? null,
        sourcePath: null,
        mimeType: "video/mp4",
        durationMs: sceneLengthMs,
        width: null,
        height: null,
        createdAt: currentJob.createdAt,
      };
      const currentDuration = canvasDuration(current);
      const position = Number.isFinite(ratio) ? ratio * currentDuration : 0;
      const startMs = Math.round(Math.max(0, Math.min(currentDuration - sceneLengthMs, position)));
      const clip: TimelineClip = {
        id: clipId,
        assetId: asset.id,
        trackId,
        startMs,
        durationMs: sceneLengthMs,
        sourceStartMs: 0,
        label: currentJob.title,
        color: null,
        status: currentJob.status === "completed" && currentJob.outputRelativePath ? "generated" : "draft",
      };
      const snap = {
        targets: snapTargets(current.timeline.tracks, { playheadMs: playhead }),
        toleranceMs: laneWidthPx > 0 ? (SNAP_PX * currentDuration) / laneWidthPx : 0,
      };
      const nextTracks = insertClip(current.timeline.tracks, trackId, clip, startMs, snap);
      if (!nextTracks) return current;
      const assets = existing ? current.assets : [...current.assets, asset];
      return { ...current, assets, timeline: { tracks: nextTracks } };
    });
    setSelectedId(clipId);
  };

  /* --- Dragging a clip -----------------------------------------------------

     Three gestures, one mechanism: take hold of a clip's body to move it along
     its lane or into another lane of the same kind, or take hold of either end
     to trim it. What the pointer produces is a PREVIEW — the lanes draw it and
     nothing is written — and the release commits that preview unchanged. Escape
     abandons it, and a gesture the rules refuse simply never produces a preview
     to commit, so the clip stays where it was.
     ======================================================================= */

  const beginDrag = (event: React.PointerEvent<HTMLElement>, clip: TimelineClip, mode: DragMode) => {
    // Left button only: a right-click is a context menu, and a middle-click is
    // a scroll gesture in most shells.
    if (event.button !== 0) return;
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track || track.locked) return;
    const lane = (event.currentTarget as HTMLElement).closest(".track-lane") as HTMLElement | null;
    const rect = lane?.getBoundingClientRect();
    // Nothing has been laid out: there is no scale to turn pixels into time
    // with, and a drag measured against a zero-width lane would put the clip at
    // an arbitrary place on the ruler. The clip still selects.
    if (!rect || rect.width <= 0) { setSelectedId(clip.id); return; }
    dropSelection();
    const msPerPx = duration / rect.width;
    dragRef.current = {
      clipId: clip.id,
      mode,
      baseTracks: tracks,
      laneLeftPx: rect.left,
      msPerPx,
      grabOffsetMs: (event.clientX - rect.left) * msPerPx - clip.startMs,
      startXPx: event.clientX,
      /* Every lane in the grid shares one column, so a lane's left edge and
         width are the whole timeline's — which is why a drag that crosses into
         another lane can keep using the geometry it measured on this one. */
      snap: snapFor(rect.width, clip.id),
      room: roomFor(clip),
      moved: false,
    };
    setSelectedId(clip.id);
    setDragging(true);
  };

  const endDrag = (commit: boolean) => {
    if (commit && previewRef.current) updateTracks(previewRef.current);
    dragRef.current = null;
    previewRef.current = null;
    setPreview(null);
    setDragging(false);
  };

  useEffect(() => {
    if (!dragging) return;
    const show = (next: TimelineTrack[] | null) => { previewRef.current = next; setPreview(next); };
    const onMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session) return;
      // Until the pointer has travelled far enough to mean it, this is a click.
      if (!session.moved && Math.abs(event.clientX - session.startXPx) < DRAG_THRESHOLD_PX) return;
      session.moved = true;
      const pointerMs = (event.clientX - session.laneLeftPx) * session.msPerPx;
      if (session.mode === "move") {
        const overTrack = trackIdAtPoint(event.clientX, event.clientY)
          ?? findClip(session.baseTracks, session.clipId)?.track.id;
        show(overTrack ? moveClip(session.baseTracks, session.clipId, overTrack, pointerMs - session.grabOffsetMs, session.snap) : null);
        return;
      }
      show(trimClip(session.baseTracks, session.clipId, session.mode === "trim-start" ? "start" : "end", pointerMs, {
        minClipMs, room: session.room, snap: session.snap,
      }));
    };
    const onUp = () => endDrag(true);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") endDrag(false); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A drag whose pointer is snatched away — a tablet lifted, a shell that
    // takes the capture — must not leave the timeline in a half-dragged state.
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
    /* Registered once per drag rather than per render: the handlers read the
       session out of a ref, so a preview landing mid-drag must not tear the
       listeners down and put them back. */
  }, [dragging, minClipMs]);

  /* What the lanes draw: the drag if there is one, and the project otherwise.
     The inspector deliberately keeps reading the real project — a length that
     flickered while a clip was being dragged would be a number nobody can
     read. */
  const drawnTracks = preview ?? tracks;

  const removeMediaAsset = (assetId: string) => {
    const removedClipIds = new Set(tracks.flatMap((track) => track.clips)
      .filter((clip) => clip.assetId === assetId)
      .map((clip) => clip.id));
    onChange((current) => ({
      ...current,
      assets: current.assets.filter((asset) => asset.id !== assetId),
      timeline: {
        tracks: current.timeline.tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => clip.assetId !== assetId),
        })),
      },
    }));
    setSelectedId((current) => removedClipIds.has(current) ? "" : current);
  };

  const addScene = () => {
    // A new project already carries an unstarted draft made from the user's own
    // words, so open that rather than stacking a near-identical second shot.
    // With none left, go to an empty composer.
    //
    // createProjectConfig does seed that FIRST draft from config.brief.prompt,
    // and this is not a disagreement with it. The brief describes the whole
    // video, which is a fair opening for the one shot a project starts with —
    // there is nothing else to go on, and it is there to be rewritten. Every
    // later shot has that same paragraph already spent on the shot before it,
    // so repeating it would describe the whole video a second time and call it
    // shot two.
    onOpenGenerator(config.generationJobs.find((job) => job.status === "draft")?.id);
  };

  return (
    <div className={`timeline-view ${dragging ? "timeline-view--dragging" : ""}`} tabIndex={0} onKeyDown={(event) => {
      /* Delete works from the view itself and from a focused clip — the clip IS
         the thing being deleted, and having to leave it first to press the key
         is the kind of rule only the code knows. It deliberately does NOT fire
         from a text field: a Backspace in the clip's name is an edit. */
      const target = event.target as HTMLElement;
      const fromClip = target.classList?.contains("timeline-clip");
      if ((event.key === "Delete" || event.key === "Backspace") && (event.target === event.currentTarget || fromClip)) removeSelected();
      if (event.code === "Space" && (event.target === event.currentTarget || fromClip) && clipCount > 0) { event.preventDefault(); setPlaying((value) => !value); }
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
            <h2>{panelTab === "scenes" ? "Generator scenes" : "Project media"}</h2>
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
              {config.generationJobs.map((job, index) => {
                const assetIds = new Set([
                  generationAssetId(job.id),
                  ...config.assets.filter((asset) => job.outputRelativePath && asset.relativePath === job.outputRelativePath).map((asset) => asset.id),
                ]);
                const placements = tracks.flatMap((track) => track.clips).filter((clip) => clip.id === job.clipId || assetIds.has(clip.assetId)).length;
                return <button
                  key={job.id}
                  className="scene-card"
                  draggable
                  onClick={() => onOpenGenerator(job.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SCENE_DRAG_TYPE, job.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDraggedScene(job);
                    setDraggedAsset(undefined);
                  }}
                  onDragEnd={() => { setDraggedScene(undefined); setDropTrackId(null); }}
                  title={`${job.title} — drag onto a video track below`}
                >
                  <span className="scene-card__thumb">
                    <ShotThumbnail folderPath={folderPath} job={job} seconds={0} shotNumber={1} estimatedCompletionAt={generationCompletionTimes[job.id] ?? null} />
                    <i>{String(index + 1).padStart(2, "0")}</i><em>{sceneDurationSeconds(job).toFixed(1)}s</em>
                  </span>
                  <span><b>{job.title}</b><small>{STATUS_WORD[job.status]}{placements > 0 ? ` · ${placements} on timeline` : ""}</small><small>{sceneShape(job)}</small></span>
                </button>;
              })}
              <button className="scene-add" onClick={addScene}><Plus size={18} /> Add or generate a scene</button>
            </div>
          ) : (
            <div className={`media-grid media-grid--${mediaLayout}`}>
              {/* Draggable onto the timeline. `draggable` on a <button> is the
                  whole mechanism — the button still clicks and still takes
                  focus, so keyboard users are not shut out of selecting it. */}
              {mediaAssets.map((asset) => <div className="media-card" key={asset.id}>
                <button
                  className="media-card__source"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDraggedAsset(asset);
                    setDraggedScene(undefined);
                  }}
                  onDragEnd={() => { setDraggedAsset(undefined); setDropTrackId(null); }}
                  title={`${asset.name} — drag onto a ${asset.kind === "audio" ? "sound" : "video"} track below`}
                >
                  <MediaThumbnail folderPath={folderPath} asset={asset} onMeasured={(measured) => recordMeasured(asset.id, measured)} />
                  <b>{asset.name}</b>
                  {/* Duration is only claimed when something actually measured it. */}
                  <small>{asset.kind}{asset.durationMs ? ` · ${(asset.durationMs / 1000).toFixed(1)}s` : ""}</small>
                </button>
                <button
                  className="media-card__remove"
                  aria-label={`Remove ${asset.name} from project`}
                  title={`Remove ${asset.name} from the project and timeline`}
                  onClick={() => removeMediaAsset(asset.id)}
                ><X size={14} /></button>
              </div>)}
              <button
                className="media-import"
                onClick={() => void importMedia()}
                disabled={importing || !isTauri()}
                title={isTauri() ? "Add video, sound, or image files — video and sound stay where they are, images are copied in" : "Importing files is available in the desktop app"}
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
            {/* The real picture now: the clip under the playhead, decoded from
                its own file. What used to stand here was a panel explaining
                that PolStudio could not play footage back — true when it was
                written, and no longer. An empty timeline still shows an empty
                monitor, which says by itself that nothing is cut yet. */}
            {clipCount > 0
              ? <ProgramMonitor
                config={config}
                folderPath={folderPath}
                playheadMs={playhead}
                playing={playing}
                onSeek={seek}
                onPlayingChange={setPlayingFromMonitor}
                selectedClipId={selectedId}
                transformEditingDisabled={selectedTrack?.locked ?? false}
                onSelectClip={setSelectedId}
                onTransformChange={(clipId, transform) => updateClip(clipId, { transform })}
              />
              : <div className="program-empty">
                <span>Drop a file from Media onto a track below, or generate a scene, and it plays here.</span>
              </div>}
          </div>
        </main>

        <aside className="clip-inspector" aria-label="Clip inspector">
          {selected ? <>
            <section className="inspector-section">
              <h3>Clip</h3>
              <label><span>Name</span><input value={selected.label} onChange={(event) => updateClip(selected.id, { label: event.target.value || "Untitled clip" })} /></label>
              <div className="field-pair">
                <label><span>Starts at</span><input value={timecode(selected.startMs).slice(3)} readOnly /></label>
                <label><span>Lasts</span><input
                  value={durationDraft ?? timecode(selected.durationMs).slice(3)}
                  onChange={(event) => typeDuration(event.target.value)}
                  onBlur={() => setDurationDraft(null)}
                  title={`How long this clip lasts — minutes:seconds:frames, or just seconds.${sourceLimitMs === null ? "" : ` This footage has ${(sourceLimitMs / 1000).toFixed(1)}s left from where the clip starts in it.`}`}
                  inputMode="decimal"
                /></label>
              </div>
            </section>
            <section className="inspector-section">
              <h3>Transform</h3>
              <div className="field-pair">
                <label><span>Scale (%)</span><CommittedNumberInput minimum={10} maximum={400} step="1" value={selectedTransform?.scale ?? 100} disabled={visualControlsDisabled} onCommit={(value) => updateTransform("scale", value)} /></label>
                <label><span>Rotation (°)</span><CommittedNumberInput minimum={-180} maximum={180} step="1" value={selectedTransform?.rotation ?? 0} disabled={visualControlsDisabled} onCommit={(value) => updateTransform("rotation", value)} /></label>
              </div>
              <div className="field-pair">
                <label><span>Position X (%)</span><CommittedNumberInput minimum={-100} maximum={100} step="1" value={selectedTransform?.positionX ?? 0} disabled={visualControlsDisabled} onCommit={(value) => updateTransform("positionX", value)} /></label>
                <label><span>Position Y (%)</span><CommittedNumberInput minimum={-100} maximum={100} step="1" value={selectedTransform?.positionY ?? 0} disabled={visualControlsDisabled} onCommit={(value) => updateTransform("positionY", value)} /></label>
              </div>
            </section>
            <section className="inspector-section">
              <h3>Look</h3>
              <label className="range-field"><span>Opacity <b>{selectedLook?.opacity ?? 100}%</b></span><input aria-label="Clip opacity" type="range" min="0" max="100" step="1" value={selectedLook?.opacity ?? 100} disabled={visualControlsDisabled} onChange={(event) => updateLook("opacity", Number(event.target.value))} /></label>
              <label className="range-field"><span>Temperature <b>{(selectedLook?.temperature ?? 0) > 0 ? "+" : ""}{selectedLook?.temperature ?? 0}</b></span><input aria-label="Clip temperature" type="range" min="-100" max="100" step="1" value={selectedLook?.temperature ?? 0} disabled={visualControlsDisabled} onChange={(event) => updateLook("temperature", Number(event.target.value))} /></label>
            </section>
            <section className="inspector-section">
              <h3>Transition</h3>
              <label><span>When this clip begins</span><select aria-label="Clip transition" value={selectedTransition?.type ?? "cut"} disabled={visualControlsDisabled} onChange={(event) => selected && selectedTransition && updateClip(selected.id, { transition: { ...selectedTransition, type: event.target.value as NonNullable<TimelineClip["transition"]>["type"] } })}>
                <option value="cut">Cut</option>
                <option value="fade">Fade in</option>
                <option value="wipe-left">Wipe from left</option>
                <option value="wipe-right">Wipe from right</option>
              </select></label>
              <label className="range-field"><span>Duration <b>{selectedTransition?.durationMs ?? 500} ms</b></span><input aria-label="Transition duration" type="range" min="100" max="3000" step="100" value={selectedTransition?.durationMs ?? 500} disabled={visualControlsDisabled || selectedTransition?.type === "cut"} onChange={(event) => selected && selectedTransition && updateClip(selected.id, { transition: { ...selectedTransition, durationMs: Number(event.target.value) } })} /></label>
            </section>
          </> : clipCount === 0
            ? <div className="inspector-empty"><MouseSelection /><b>Nothing to edit yet</b><span>Once a scene lands on the timeline, select it here to rename it and check its timing.</span></div>
            : <div className="inspector-empty"><MouseSelection /><b>Select a clip to edit it</b><span>Pick any clip on the timeline below to rename it, check its timing, and see how it was made.</span></div>}
        </aside>
      </div>

      <section className="pro-timeline">
        <header className="timeline-toolbar">
          {/* What the timeline IS and where it currently stands, reading left to
              right from the panel's own heading: name, clock, format. The clock
              used to sit inside the transport cluster, which pushed the buttons
              off-centre and put a number nobody is aiming at in the middle of
              the row. It is still the only timecode on the screen. */}
          <div className="timeline-toolbar__lead">
            <h2>Timeline</h2>
            <strong className="transport-time" title="Playhead position">{timecode(playhead)}</strong>
            <span className="transport-format">{resolutionLabel(config.settings.resolution, config.settings.aspectRatio)} · {config.settings.frameRate} fps</span>
          </div>
          {/* The transport belongs to the timeline, not to the picture: it drives
              the playhead, and the playhead is drawn a few pixels below this row.
              Under the monitor it also printed the same timecode this toolbar was
              already printing, so one clock was shown twice and could be read as
              two. One transport, one timecode, beside the ruler they refer to.

              It is centred on the PICTURE rather than on this row, which are not
              the same point: the toolbar runs the full width while the monitor
              sits between two side panels of unequal width. See
              --video-centre-shift in timeline.css. */}
          <div className="timeline-transport">
            <button onClick={() => setPlayhead(0)} aria-label="Go to beginning" title={transportBlockedBy ?? "Go to beginning"} disabled={transportBlockedBy !== null}><SkipBack size={18} /></button>
            {/* Nothing to play means nothing to play: running the clock over an
                empty timeline reads as playback of footage that isn't there. */}
            {/* Pressing Play with the playhead already past the last frame used
                to start playback that immediately stopped, which reads as a
                broken button. From the end, Play means play it again. */}
            <button className="play-button" onClick={() => { if (!playing && playhead >= contentEndMs) setPlayhead(0); setPlaying((value) => !value); }} aria-label={playing ? "Pause" : "Play"} disabled={transportBlockedBy !== null} title={transportBlockedBy ?? (playing ? "Pause" : "Play")}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
            <button onClick={() => setPlayhead(Math.min(duration, playhead + 1000))} aria-label="Step forward one second" title={transportBlockedBy ?? "Step forward one second"} disabled={transportBlockedBy !== null}><SkipForward size={18} /></button>
          </div>
          <div className="timeline-tools">
            <button onClick={splitSelected} disabled={splitBlockedBy !== null} title={splitBlockedBy ?? "Split at playhead"}><Scissors size={16} /> Split</button>
            <button onClick={duplicateSelected} disabled={duplicateBlockedBy !== null} title={duplicateBlockedBy ?? "Duplicate clip"}><Copy size={16} /> Duplicate</button>
            <button onClick={removeSelected} disabled={deleteBlockedBy !== null} title={deleteBlockedBy ?? "Delete selected clip"}><Trash2 size={16} /> Delete</button>
          </div>
        </header>
        <div
          className="timeline-grid"
          ref={timelineGrid}
          style={{ "--lane-grid": `${(tickStepMs / duration) * 100}%` } as React.CSSProperties}
          title="Scroll to scrub, or drag along the ruler. Hold Shift to scrub one frame at a time. Clips snap to the cuts around them; Escape abandons a drag.">
          <div className="track-corner"><span>Tracks</span></div>
          {/* Press to jump, hold and drag to scrub. The monitor seeks to wherever
              this lands, so dragging along the ruler runs the picture past under
              the pointer — which is what scrubbing IS. Playback stops first:
              scrubbing while playing would be two things driving one playhead. */}
          <div
            className="time-ruler"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture?.(event.pointerId);
              dropSelection();
              setPlaying(false);
              setScrubbing(true);
              scrubTo(event.currentTarget, event.clientX);
            }}
            onPointerMove={(event) => { if (scrubbing) scrubTo(event.currentTarget, event.clientX); }}
            onPointerUp={(event) => { event.currentTarget.releasePointerCapture?.(event.pointerId); setScrubbing(false); }}
            onPointerCancel={() => setScrubbing(false)}
          >
            {ticks.map((second) => <span key={second} style={{ left: `${second * 1000 / duration * 100}%` }}><i />{rulerLabel(second)}</span>)}
          </div>
          {drawnTracks.map((track) => <TrackRow
            key={track.id}
            track={track}
            duration={duration}
            selectedId={selectedId}
            draggingId={dragging ? dragRef.current?.clipId : undefined}
            onClipPointerDown={beginDrag}
            onDeleteClip={deleteClip}
            dropActive={dropTrackId === track.id}
            /* A lane that stays dark is indistinguishable from a lane the
               pointer simply is not over, so a sound held above a video track
               looked like it had not been picked up rather than like it was
               being refused. Marked for the whole drag, not just on hover. */
            dropBlocked={(draggedAsset !== undefined && !acceptsAsset(track, draggedAsset))
              || (draggedScene !== undefined && !acceptsScene(track, draggedScene))}
            onSelect={setSelectedId}
            onToggle={toggleTrack}
            onRename={renameTrack}
            onDragOverLane={(event) => {
              const hasAsset = event.dataTransfer.types.includes(ASSET_DRAG_TYPE);
              const hasScene = event.dataTransfer.types.includes(SCENE_DRAG_TYPE);
              if ((!hasAsset || !acceptsAsset(track, draggedAsset)) && (!hasScene || !acceptsScene(track, draggedScene))) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              setDropTrackId(track.id);
            }}
            onDragLeaveLane={() => setDropTrackId((current) => current === track.id ? null : current)}
            onDropLane={(event) => {
              event.preventDefault();
              setDropTrackId(null);
              const jobId = event.dataTransfer.getData(SCENE_DRAG_TYPE);
              const rect = event.currentTarget.getBoundingClientRect();
              const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
              if (jobId) {
                dropScene(track.id, jobId, ratio, rect.width);
                return;
              }
              const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
              if (!assetId) return;
              // A zero-width lane would make the ratio NaN and the clip's start
              // time with it, which zod then refuses to save.
              dropAsset(track.id, assetId, ratio, rect.width);
            }}
          />)}
          <div className="timeline-playhead" style={{ left: `calc(var(--track-column) + (100% - var(--track-column)) * ${playhead / duration})` }}><span /><i /></div>
        </div>
      </section>
    </div>
  );
}

function TrackRow({ track, duration, selectedId, draggingId, dropActive, dropBlocked, onSelect, onToggle, onRename, onClipPointerDown, onDeleteClip, onDragOverLane, onDragLeaveLane, onDropLane }: {
  track: ProjectConfig["timeline"]["tracks"][number];
  duration: number;
  selectedId: string;
  /** The clip currently being dragged, so it can be drawn as the thing under
   *  the pointer rather than as one more clip sitting on the lane. */
  draggingId?: string;
  dropActive: boolean;
  dropBlocked: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string, key: "muted" | "locked") => void;
  onRename: (id: string, name: string) => void;
  onClipPointerDown: (event: React.PointerEvent<HTMLElement>, clip: TimelineClip, mode: DragMode) => void;
  onDeleteClip: (id: string) => void;
  onDragOverLane: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeaveLane: () => void;
  onDropLane: (event: React.DragEvent<HTMLDivElement>) => void;
}) {
  /* The name no longer carries its kind ("Track 1, Video" is now "Track 1"),
     which the icon and the line under the field already say — but that leaves a
     video and an audio track both called "Track 1", and a button announced as
     "Mute Track 1" twice names neither. The controls say which one in full. */
  const named = `${track.kind === "audio" ? "audio" : "video"} ${track.name}`;
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
        aria-label={`Rename ${named}`}
        title="Rename this track"
        onChange={(event) => onRename(track.id, event.target.value || "Untitled track")}
      /><small>{track.kind === "audio" ? "Audio" : "Video"}</small></div>
      <button className={track.muted ? "active" : ""} onClick={() => onToggle(track.id, "muted")} aria-label={`${track.muted ? "Unmute" : "Mute"} ${named}`} title={`${track.muted ? "Unmute" : "Mute"} ${named}`}>{track.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <button className={track.locked ? "active" : ""} onClick={() => onToggle(track.id, "locked")} aria-label={`${track.locked ? "Unlock" : "Lock"} ${named}`} title={`${track.locked ? "Unlock" : "Lock"} ${named}`}>{track.locked ? <Lock size={16} /> : <LockOpen size={16} />}</button>
    </div>
    <div
      className={`track-lane ${track.muted ? "muted" : ""} ${dropActive ? "track-lane--drop" : ""} ${dropBlocked ? "track-lane--reject" : ""}`}
      /* Which track this lane IS, readable from the DOM: a clip dragged across
         lanes is hit-tested against the document, and the id is how the answer
         gets back to the model. */
      data-track-id={track.id}
      title={dropBlocked ? (track.locked ? `${track.name} is locked` : `${track.name} only takes ${track.kind === "audio" ? "sound" : "video and pictures"}`) : undefined}
      onDragOver={onDragOverLane}
      onDragLeave={onDragLeaveLane}
      onDrop={onDropLane}
    >
      {track.clips.map((clip) => <div
        key={clip.id}
        className={`clip-slot ${selectedId === clip.id ? "selected" : ""} ${draggingId === clip.id ? "clip-slot--dragging" : ""}`}
        style={{ left: `${clip.startMs / duration * 100}%`, width: `${clip.durationMs / duration * 100}%`, "--clip-color": clip.color } as React.CSSProperties}
      >
        {/* The clip is a div with a button's role rather than a <button>: it
            carries two trim handles and a delete control of its own, and a
            button inside a button is not a thing a browser or a screen reader
            can make sense of. Everything a button gave it is still here —
            focus, Enter, the pressed state, a name. */}
        <div
          className={`timeline-clip timeline-clip--${track.kind} ${selectedId === clip.id ? "selected" : ""} ${track.locked ? "timeline-clip--locked" : ""}`}
          role="button"
          tabIndex={0}
          aria-pressed={selectedId === clip.id}
          aria-label={`${clip.label}, ${(clip.durationMs / 1000).toFixed(1)} seconds, on ${track.name}`}
          title={track.locked
            ? `${clip.label} · ${(clip.durationMs / 1000).toFixed(1)} seconds — ${track.name} is locked`
            : `${clip.label} · ${(clip.durationMs / 1000).toFixed(1)} seconds — drag to move it, drag either end to trim it`}
          onClick={() => onSelect(clip.id)}
          onKeyDown={(event) => { if (event.key === "Enter") onSelect(clip.id); }}
          onPointerDown={(event) => onClipPointerDown(event, clip, "move")}
        ><span className="clip-text"><b>{clip.label}</b><small>{track.kind === "audio" ? "▂▅▃▆▂▃▇▅▂▆▃▅▂" : `${(clip.durationMs / 1000).toFixed(1)}s · ${clip.status}`}</small></span></div>
        {/* The two ends, which cut rather than move. They stop the press from
            reaching the clip body, or every trim would also be a move. A locked
            track gets none of them: nothing on it can be changed. */}
        {!track.locked && <>
          <span
            className="clip-handle clip-handle--start"
            title={`Trim the start of ${clip.label}`}
            onPointerDown={(event) => { event.stopPropagation(); onClipPointerDown(event, clip, "trim-start"); }}
          />
          <span
            className="clip-handle clip-handle--end"
            title={`Trim the end of ${clip.label}`}
            onPointerDown={(event) => { event.stopPropagation(); onClipPointerDown(event, clip, "trim-end"); }}
          />
          <button
            className="clip-delete"
            aria-label={`Delete ${clip.label}`}
            title={`Delete ${clip.label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); onDeleteClip(clip.id); }}
          ><X size={12} /></button>
        </>}
      </div>)}
    </div>
  </>;
}

function MouseSelection() { return <div className="selection-glyph"><span /><i /></div>; }
