import { clipEffectCount, ClipEffects } from "./ClipEffects";
import { clipPlaybackRate, clipSourceTimeMs, MIN_CLIP_SPEED, MAX_CLIP_SPEED } from "../../lib/clipTiming";
import { continuationPlaybackTracks, sceneMediaDurationMs, sceneMediaStartSeconds } from "../../lib/continuationMedia";
import { longShotPlaybackSource } from "../../lib/longShot";
import { ProjectStatus } from "./ProjectStatus";
import { PreviewEngineStatus } from "./PreviewEngineStatus";
import {
  Add16, Audio12, Audio16, Copy16, CursorClick32, Cut16, Delete16, Film12, Film16, Film20, Film32, GoToEnd16, GoToStart16,
  GridView16, GridView16Filled, Image12, Image16, Import16, ListView16, ListView16Filled, Lock14Filled, More16, Mute14Filled,
  NextFrame16, PanelLeft16, PanelLeft16Filled, PanelRight16, PanelRight16Filled, Pause16, Play16, PreviousFrame16, SafeArea16,
  SafeArea16Filled, Scene32, Sparkle12, Sparkle16, Speaker14, Text12, Text16, Unlock14, ZoomIn16, ZoomOut16,
} from "../ui/icons";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { outputDimensions, resolutionLabel } from "../../lib/export";
import { importMediaFiles, isTauri } from "../../lib/persistence";
import { loadMediaLayout, saveMediaLayout, type MediaLayout } from "../../lib/settings";
import {
  clipTransform,
  generationAssetId,
  roundClipTransform,
  sceneDurationSeconds,
  type GenerationJob,
  type ProjectAsset,
  type ProjectConfig,
  type TimelineClip,
  type TimelineTrack,
} from "../../lib/project";
import {
  adjacentCut, clipEndMs, findClip, formatTimecode, frameAt, frameStartMs, insertClip, moveClip, parseTimecode, pasteClip,
  removeClip, retimeClip, rulerLabel, rulerScale, scrollAfterZoom, snapTargets, sourceRoom, trimClip, withTimelineTracks,
  type SnapOptions, type SourceRoom,
} from "../../lib/timeline";
import { useShortcut } from "../../lib/commands";
import {
  ComboBox, EmptyState, ItemHeader, PaneHeader, PropRow, PropSection, SelectorBar, Slider, Splitter, tooltipProps, useContextMenu, usePaneSize,
  type MenuEntry,
} from "../ui";
import { MediaThumbnail, type MeasuredMedia } from "./MediaThumbnail";
import { ProgramMonitor } from "./ProgramMonitor";
import { sceneShape, STATUS_BADGE } from "./sceneStatus";
import { ShotThumbnail } from "./ShotThumbnail";
import { CommittedNumberInput } from "./CommittedNumberInput";
import { TimelineClipThumbnails } from "./TimelineClipThumbnails";
import { TimelineClipWaveform } from "./TimelineClipWaveform";

const MIN_DURATION = 10_000;
/* The scale a timeline opens at: one minute fills the visible lanes, and a
   shorter film fills them exactly. Ctrl+wheel, the −/= keys and the zoom
   slider change it from there; zooming out stops where the whole canvas fits. */
const DEFAULT_VISIBLE_MS = 60_000;
/* The closest zoom: this many pixels per frame, where the ruler labels every
   frame and a trim can be placed on one. */
const MAX_PX_PER_FRAME = 60;
/* Each −/= press or wheel notch zooms by this factor. */
const ZOOM_STEP = 1.25;
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
const ASSET_DRAG_TYPE = "application/x-slopus-asset";
const SCENE_DRAG_TYPE = "application/x-slopus-generator-scene";

/* How close two edges have to be ON SCREEN before they snap together. In
   pixels, not milliseconds, because that is how close they LOOK — the same
   8px feels the same at every zoom, where a fixed number of milliseconds would
   be unusable at one end and invisible at the other. Converted against the
   lane's real width at the moment a drag starts. */
const SNAP_PX = 8;
/* Below this, a press is a click. Without it the smallest tremor between
   pointerdown and pointerup would be read as a drag and a clip that was only
   being selected would be nudged off its cut. */
const DRAG_THRESHOLD_PX = 3;
/* J/L shuttle speeds: each further press doubles, up to 4×. */
const SHUTTLE_SPEEDS = [1, 2, 4];

/* --- Clip kinds ---------------------------------------------------------------
   Five kinds, each with one colour and one glyph wherever it appears: the
   clip's title strip, the track chip, the inspector's kind chip. The kind is
   the MEDIA's; a clip whose file is missing takes its track's. */
type ClipKind = "video" | "generated" | "image" | "audio" | "caption";
const CLIP_KINDS: Record<ClipKind, { label: string; color: string; icon: React.ReactNode; glyph: React.ReactNode }> = {
  video: { label: "Video", color: "var(--clip-video)", icon: <Film16 />, glyph: <Film12 aria-hidden="true" /> },
  generated: { label: "Generated video", color: "var(--clip-generated)", icon: <Sparkle16 />, glyph: <Sparkle12 aria-hidden="true" /> },
  image: { label: "Still image", color: "var(--clip-image)", icon: <Image16 />, glyph: <Image12 aria-hidden="true" /> },
  audio: { label: "Audio", color: "var(--clip-audio)", icon: <Audio16 />, glyph: <Audio12 aria-hidden="true" /> },
  caption: { label: "Caption", color: "var(--clip-caption)", icon: <Text16 />, glyph: <Text12 aria-hidden="true" /> },
};
const trackKindOf = (track: TimelineTrack): ClipKind => track.kind === "audio" ? "audio" : track.kind === "caption" ? "caption" : "video";
const clipKindOf = (asset: ProjectAsset | undefined, track: TimelineTrack): ClipKind => asset?.kind ?? trackKindOf(track);

/** A timecode without its empty leading groups — "12:08" for 00:00:12:08 —
 *  for a summary that has to fit beside a section title. */
const shortTimecode = (ms: number, fps: number) => formatTimecode(ms, fps).replace(/^(00:){1,2}/, "");

const TRANSFORM_DEFAULTS = { scale: 100, rotation: 0, positionX: 0, positionY: 0 } as const;

type DragMode = "move" | "trim-start" | "trim-end";
const MONITOR_ZOOM_STEPS = [25, 50, 75, 100, 150, 200, 300, 400];
type MonitorZoom = "fit" | number;

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
  /** The same targets as a set, to tell whether an edge landed on one. */
  snapSet: ReadonlySet<number>;
  /** Where the playhead was, so a snap to it can be named. */
  playheadMs: number;
  room: SourceRoom;
  moved: boolean;
}

/** An edge of the dragged clip sitting on a snap target, drawn as a dashed
 *  line through the lanes with what it snapped to. */
interface SnapMark {
  ms: number;
  label: string;
}

/** Which lane the pointer is over, for a drag that has left the lane it started
 *  in. Read from the document rather than from React state because the pointer
 *  is captured elsewhere: what is under it is a question only the DOM can
 *  answer. jsdom has no hit-testing, so a missing method means "the lane it
 *  started on", not a crash. */
function trackIdAtPoint(x: number, y: number): string | undefined {
  if (typeof document.elementsFromPoint !== "function") return undefined;
  for (const element of document.elementsFromPoint(x, y)) {
    if (!element) continue;
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

const readFlag = (key: string, fallback: boolean) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
};
const writeFlag = (key: string, value: boolean) => {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* storage unavailable */ }
};

/** Arrow keys, Home and End belong to the control that has focus when it is a
 *  slider, a splitter, a tab strip or a list — the timeline only takes them
 *  from everywhere else. */
const ownsArrowKeys = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('input, select, textarea, [role="slider"], [role="separator"], [role="tablist"], [role="listbox"], [role="menu"], [role="combobox"]'));

/** How a view hands a project back. An updater rather than a plain value is
 *  the only safe form for a write built from something asynchronous: the
 *  holder applies it to its LATEST config, so a write does not depend on the
 *  previous one having already come back down as a prop. */
export type ConfigUpdate = ProjectConfig | ((current: ProjectConfig) => ProjectConfig);

/** What a track row needs to call back into the view. Held in a ref so the
 *  rows can be memoised: the playhead re-renders the view every frame of
 *  playback, and the lanes have no reason to re-render with it. */
interface TrackActions {
  select: (id: string) => void;
  toggle: (id: string, key: "muted" | "locked") => void;
  rename: (id: string, name: string) => void;
  clipPointerDown: (event: React.PointerEvent<HTMLElement>, clip: TimelineClip, mode: DragMode) => void;
  clipMenu: (event: React.MouseEvent<HTMLElement>, clip: TimelineClip) => void;
  laneMenu: (event: React.MouseEvent<HTMLElement>, track: TimelineTrack) => void;
  dragOverLane: (event: React.DragEvent<HTMLDivElement>, track: TimelineTrack) => void;
  dragLeaveLane: (track: TimelineTrack) => void;
  dropLane: (event: React.DragEvent<HTMLDivElement>, track: TimelineTrack) => void;
}

export function TimelineView({ config, folderPath, generationCompletionTimes = {}, onChange, onMeasured, onOpenGenerator, openSceneId }: {
  config: ProjectConfig;
  folderPath: string;
  generationCompletionTimes?: Readonly<Record<string, number>>;
  /** `key` names a run of edits (a scrub, a typed value, a gesture) so the
   *  project's undo stack folds it into one step. */
  onChange: (next: ConfigUpdate, key?: string) => void;
  /** What a decode learned about a file the project already had — a length, a
   *  size. Worth keeping, but the user did not edit anything by looking at the
   *  Media panel, so the holder records it WITHOUT marking the project unsaved.
   *  Omitted, measurements go back through onChange like any other change. */
  onMeasured?: (update: (current: ProjectConfig) => ProjectConfig) => void;
  onOpenGenerator: (jobId?: string) => void;
  /** The scene the Generator has open, marked selected in the Scenes list. */
  openSceneId?: string;
}) {
  const firstClip = config.timeline.tracks.flatMap((track) => track.clips)[0];
  const fps = config.settings.frameRate;
  const [selectedId, setSelectedId] = useState(firstClip?.id ?? "");
  const [playhead, setPlayhead] = useState(firstClip?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  /* Shuttle speed: 1, 2, 4 forward or −1, −2, −4 in reverse (J/K/L). */
  const [rate, setRate] = useState(1);
  const [panelTab, setPanelTab] = useState<"scenes" | "media">("scenes");
  /* Grid reads a folder of footage by its pictures, list reads it by its
     names. Which one a cutter wants is a habit, not a per-project choice, so
     it is remembered on this machine rather than written into the project. */
  const [mediaLayout, setMediaLayout] = useState<MediaLayout>(loadMediaLayout);
  /* The media card Delete would act on: the focused one, or the last one
     clicked or right-clicked. */
  const [mediaSelectedId, setMediaSelectedId] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const playheadMarkerRef = useRef<HTMLDivElement>(null);
  const clipNameRef = useRef<HTMLInputElement>(null);
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
  /* What the user is typing into Duration, while they are typing it. The field
     otherwise shows the clip's own length, and "00:0" on the way to "00:08"
     must not be snapped back to a formatted timecode mid-keystroke. Null means
     nothing is being typed and the clip speaks for itself. */
  const [durationDraft, setDurationDraft] = useState<string | null>(null);
  /* The toolbar clock, while it is being typed into. */
  const [timecodeDraft, setTimecodeDraft] = useState<string | null>(null);
  /* In and out points (I / O), drawn as a shaded range on the ruler. */
  const [inMs, setInMs] = useState<number | null>(null);
  const [outMs, setOutMs] = useState<number | null>(null);
  /* Clips copied with Ctrl+C / Ctrl+X, pasted with Ctrl+V. Local to the
     editor: a clip only means something inside this project. */
  const clipboard = useRef<TimelineClip | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  /* Monitor magnification is view state, independent of clip transforms. */
  const [monitorZoom, setMonitorZoom] = useState<MonitorZoom>("fit");
  const monitorCanvasRef = useRef<HTMLDivElement>(null);
  const monitorAnchor = useRef<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const [safeArea, setSafeArea] = useState(false);
  /* The side panes collapse from the toolbar instead of disappearing at a
     window width — a narrow window keeps whatever the user chose to see. */
  const [sourcesOpen, setSourcesOpen] = useState(() => readFlag("slopus.timeline.sources", true));
  const [inspectorOpen, setInspectorOpen] = useState(() => readFlag("slopus.timeline.inspector", true));
  const sourcesPane = usePaneSize("timeline.sources", 296, { min: 200, max: 480 });
  const inspectorPane = usePaneSize("timeline.inspector", 340, { min: 260, max: 560 });
  const timelinePane = usePaneSize("timeline.height", 340, { min: 150, max: 800 });
  const trackPane = usePaneSize("timeline.tracks", 180, { min: 120, max: 320 });
  /* A drag in flight, and the timeline as it would be if the pointer were
     released right now. The lanes draw the preview, and the release commits
     exactly it — the drag and the edit are the same calculation, run twice
     (see src/lib/timeline.ts). Null means the move is refused from here: the
     clip is drawn where it really is, which is the honest answer to "no". */
  const dragRef = useRef<DragSession | null>(null);
  const previewRef = useRef<TimelineTrack[] | null>(null);
  const [preview, setPreview] = useState<TimelineTrack[] | null>(null);
  const [snapMark, setSnapMark] = useState<SnapMark | null>(null);
  const [dragging, setDragging] = useState(false);
  /* Whether the pointer is dragging the playhead (on the ruler or by its
     head). A press alone moves it once; this is what makes the moves keep
     coming. */
  const [scrubbing, setScrubbing] = useState(false);
  const menu = useContextMenu();
  const tracks = config.timeline.tracks;
  const selected = useMemo(() => tracks.flatMap((track) => track.clips).find((clip) => clip.id === selectedId), [tracks, selectedId]);
  const selectedTrack = tracks.find((track) => track.id === selected?.trackId);
  const selectedMediaAsset = config.assets.find((asset) => asset.id === selected?.assetId);
  const selectedTransform = selected ? clipTransform(selected) : null;
  const selectedKind = selected && selectedTrack ? clipKindOf(selectedMediaAsset, selectedTrack) : null;
  /* Section summaries: how many transform values are off their defaults, and
     how many effects the clip carries. */
  const transformChanges = selectedTransform
    ? (Object.keys(TRANSFORM_DEFAULTS) as (keyof typeof TRANSFORM_DEFAULTS)[]).filter((key) => selectedTransform[key] !== TRANSFORM_DEFAULTS[key]).length
    : 0;
  const selectedEffects = selected ? clipEffectCount(selected) : { total: 0, on: 0 };
  const visualControlsDisabled = selectedMediaAsset?.kind === "audio" || selectedTrack?.kind !== "video" || selectedTrack.locked;
  const clipCount = tracks.reduce((total, track) => total + track.clips.length, 0);
  /** Where the last clip ends — where playback stops, which is not the same as
   *  where the ruler stops (the canvas is at least as long as the film the user
   *  asked for, however little of it is cut yet). */
  const contentEndMs = tracks.reduce((end, track) => track.clips.reduce((furthest, clip) => Math.max(furthest, clipEndMs(clip)), end), 0);
  const duration = useMemo(() => canvasDuration(config), [config]);
  const mediaAssets = useMemo(() => config.assets.filter((asset) => asset.kind !== "generated"), [config.assets]);
  const assetsById = useMemo(() => new Map(config.assets.map((asset) => [asset.id, asset])), [config.assets]);
  const generatedJobsByAssetId = useMemo(() => new Map(
    config.generationJobs.map((job) => [generationAssetId(job.id), job]),
  ), [config.generationJobs]);
  const playbackClips = useMemo(() => new Map(continuationPlaybackTracks(config).flatMap((track) => track.clips).map((clip) => [clip.id, clip])), [config.timeline.tracks, config.assets, config.generationJobs]);
  /* V1, V2… and A1, A2… — the track's kind and its place among its kind, the
     label every NLE puts on a track header. */
  const trackLabels = useMemo(() => {
    const counts: Record<string, number> = {};
    return new Map(tracks.map((track) => {
      counts[track.kind] = (counts[track.kind] ?? 0) + 1;
      return [track.id, `${track.kind === "audio" ? "A" : track.kind === "caption" ? "C" : "V"}${counts[track.kind]}`];
    }));
  }, [tracks]);

  /* --- Zoom -----------------------------------------------------------------
     pxPerSecond is the zoom. The lanes are `duration × pxPerSecond` wide and
     every clip is still positioned in percent of that, so a zoom is one width
     change rather than a re-layout of every clip. Until the scroll area has
     been measured (and in jsdom, which lays nothing out) the lanes are simply
     100% wide. */
  const [viewportPx, setViewportPx] = useState(0);
  const [zoom, setZoom] = useState<number | null>(null);
  const laneViewportPx = Math.max(0, viewportPx - trackPane.size);
  const fitPps = laneViewportPx > 0 ? laneViewportPx / (duration / 1000) : 0;
  const maxPps = fps * MAX_PX_PER_FRAME;
  const minPps = Math.min(fitPps, maxPps);
  const defaultPps = laneViewportPx > 0 ? laneViewportPx / (Math.min(duration, DEFAULT_VISIBLE_MS) / 1000) : 0;
  const pxPerSecond = laneViewportPx > 0 ? Math.min(maxPps, Math.max(minPps, zoom ?? defaultPps)) : 0;
  const lanePx = pxPerSecond > 0 ? Math.round((duration / 1000) * pxPerSecond) : null;
  /* The ruler's density at this zoom, from frames up to minutes. Unmeasured,
     it assumes a 1000px lane so the labels are still readable. */
  const scale = useMemo(() => rulerScale(lanePx ? pxPerSecond : 1000 / (duration / 1000), fps), [lanePx, pxPerSecond, duration, fps]);
  const pendingScroll = useRef<number | null>(null);
  const zoomState = useRef({ pxPerSecond, minPps, maxPps, trackPx: trackPane.size });
  zoomState.current = { pxPerSecond, minPps, maxPps, trackPx: trackPane.size };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewportPx(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportPx(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Zoom to `nextPps`, keeping the moment `anchorPx` pixels into the visible
   *  lanes where it is. Without an anchor, the playhead if it is on screen,
   *  and otherwise the middle of the view. */
  const zoomTo = useCallback((nextPps: number, anchorPx?: number) => {
    const { pxPerSecond: current, minPps: low, maxPps: high } = zoomState.current;
    const element = scrollRef.current;
    if (!element || current <= 0) return;
    const clamped = Math.min(high, Math.max(low, nextPps));
    if (Math.abs(clamped - current) < 1e-6) return;
    const visible = element.clientWidth - zoomState.current.trackPx;
    const playheadPx = (playheadRef.current / 1000) * current - element.scrollLeft;
    const anchor = anchorPx ?? (playheadPx >= 0 && playheadPx <= visible ? playheadPx : visible / 2);
    pendingScroll.current = scrollAfterZoom(element.scrollLeft, anchor, current, clamped);
    setZoom(clamped);
  }, []);
  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScroll.current;
    pendingScroll.current = null;
  }, [pxPerSecond]);
  /* The slider is logarithmic: every notch is the same RATIO of zoom. */
  const zoomSliderValue = lanePx && maxPps > minPps ? Math.round(Math.log(pxPerSecond / minPps) / Math.log(maxPps / minPps) * 100) : 0;
  const zoomFromSlider = (value: number) => {
    if (maxPps <= minPps) return;
    zoomTo(minPps * (maxPps / minPps) ** (value / 100));
  };

  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => { if (clipCount === 0 && playing) setPlaying(false); }, [clipCount, playing]);

  /* Paint on the monitor's animation tick, before React schedules the larger
     editor update. Native video keeps playing while that update is pending. */
  const paintPlayhead = useCallback((ms: number) => {
    const marker = playheadMarkerRef.current;
    if (!marker) return;
    const ratio = Math.max(0, Math.min(1, ms / duration));
    marker.style.transform = `translateX(${ratio * (lanePx ?? rulerRef.current?.clientWidth ?? 0)}px)`;
  }, [duration, lanePx]);
  const seek = useCallback((ms: number) => {
    paintPlayhead(ms);
    setPlayhead(ms);
  }, [paintPlayhead]);
  // Paused seeks, zoom and resizing use the same positioning as playback.
  useLayoutEffect(() => paintPlayhead(playhead), [paintPlayhead, playhead]);
  const setPlayingFromMonitor = useCallback((value: boolean) => { setPlaying(value); if (!value) setRate(1); }, []);

  // Another clip, another length: what was being typed belonged to the old one.
  useEffect(() => { setDurationDraft(null); }, [selectedId]);

  /* The wheel does what it does everywhere else in Windows: scrolls the tracks.
     Shift+wheel scrolls sideways and Ctrl+wheel zooms around the pointer.
     Registered by hand rather than with React's onWheel because React attaches
     wheel listeners passively, and a passive listener cannot preventDefault —
     without that, Ctrl+wheel would zoom the whole page. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? element.clientHeight : 1;
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = element.getBoundingClientRect();
        const anchor = Math.max(0, event.clientX - rect.left - zoomState.current.trackPx);
        const delta = (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX) * unit;
        zoomTo(zoomState.current.pxPerSecond * Math.exp(-delta * 0.0025), anchor);
        return;
      }
      if (event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        event.preventDefault();
        element.scrollLeft += event.deltaY * unit;
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  /* During playback the view follows the playhead a page at a time, the way
     Premiere's "page scroll" does, so the playhead never runs off the edge. */
  useEffect(() => {
    const element = scrollRef.current;
    if (!playing || !element || !lanePx) return;
    const x = (playhead / duration) * lanePx;
    const visible = element.clientWidth - trackPane.size;
    if (x < element.scrollLeft || x > element.scrollLeft + visible - 16) element.scrollLeft = Math.max(0, x - 32);
  }, [playing, playhead, duration, lanePx, trackPane.size]);

  /** Any highlight the press just painted, undone. The chrome down here is not
   *  selectable at all (see .pro-timeline), but a gesture can begin on a clip
   *  and travel over the panels above, and a selection that was already in
   *  progress goes on extending under the pointer. */
  const dropSelection = () => window.getSelection?.()?.removeAllRanges();

  /** Turn a pointer position on the ruler into a playhead position. A ruler
   *  nothing has laid out has no scale, so it is left alone rather than
   *  sending the playhead to NaN. */
  const timeAtRuler = (clientX: number): number | null => {
    const rect = rulerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * duration);
  };
  const scrubTo = (clientX: number) => {
    const time = timeAtRuler(clientX);
    if (time !== null) setPlayhead(time);
  };
  /* Press to jump, hold and drag to scrub — on the ruler or by the playhead's
     own head. The monitor seeks to wherever this lands, so dragging runs the
     picture past under the pointer. Playback stops first: scrubbing while
     playing would be two things driving one playhead. */
  const beginScrub = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dropSelection();
    setPlaying(false);
    setRate(1);
    setScrubbing(true);
    scrubTo(event.clientX);
  };
  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (event: PointerEvent) => scrubTo(event.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, duration]);

  const chooseMediaLayout = (layout: MediaLayout) => { setMediaLayout(layout); saveMediaLayout(layout); };
  const toggleSources = () => setSourcesOpen((open) => { writeFlag("slopus.timeline.sources", !open); return !open; });
  const toggleInspector = () => setInspectorOpen((open) => { writeFlag("slopus.timeline.inspector", !open); return !open; });
  /* Every timeline write hands up an UPDATER rather than a finished config,
     for the same reason measurements do (see recordMeasured, and ConfigUpdate).
     A finished config is built from the props THIS render closed over, and the
     timeline is not always the most recent thing written: the media panel is
     recording what its decodes measured the whole time a folder is being
     imported, and a drag holds the timeline as it stood when the press began.

     Every edit — drag, trim, split, paste, a typed length — comes through here
     and so through the project's own onChange, which is what the project-level
     undo stack (Ctrl+Z / Ctrl+Y, in ProjectWorkspace) records. The timeline
     keeps no undo of its own. */
  const updateTracks = (nextTracks: ProjectConfig["timeline"]["tracks"], key?: string) =>
    onChange((current) => withTimelineTracks(current, nextTracks), key);
  const renameTrack = (trackId: string, name: string) => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, name } : track), `track-name:${trackId}`);
  const updateClip = (clipId: string, updates: Partial<TimelineClip>, key?: string) => updateTracks(tracks.map((track) => ({ ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...updates } : clip) })), key);
  const TRANSFORM_LIMITS = { scale: [10, 400], rotation: [-180, 180], positionX: [-100, 100], positionY: [-100, 100] } as const;
  const updateTransform = (key: keyof NonNullable<TimelineClip["transform"]>, value: number) => {
    if (!selected || !selectedTransform || !Number.isFinite(value)) return;
    const [minimum, maximum] = TRANSFORM_LIMITS[key];
    updateClip(selected.id, { transform: roundClipTransform({ ...selectedTransform, [key]: Math.max(minimum, Math.min(maximum, value)) }) }, `transform:${selected.id}:${key}`);
  };
  const toggleTrack = (trackId: string, key: "muted" | "locked") => updateTracks(tracks.map((track) => track.id === trackId ? { ...track, [key]: !track[key] } : track));
  /* Every removal — the toolbar, the key, the context menu — goes through one
     function, so a locked track refuses all three. */
  const deleteClip = (clipId: string) => {
    const next = removeClip(tracks, clipId);
    if (!next) return;
    updateTracks(next);
    setSelectedId((current) => (current === clipId ? "" : current));
  };
  const removeSelected = () => { if (selected) deleteClip(selected.id); };
  const duplicateClip = (clip: TimelineClip | undefined) => {
    const track = tracks.find((item) => item.id === clip?.trackId);
    if (!clip || !track || track.locked) return;
    /* The spread carries sourceStartMs with everything else, so duplicating a
       clip that was split off the middle of a rush copies THAT range of the
       footage, not the head of the file. Only the id, the position on the
       ruler, and the name are new. */
    const copy = { ...clip, id: `${clip.id}-copy-${Date.now()}`, label: `${clip.label} copy` };
    // Straight after the original if that is free, and otherwise wherever the
    // lane has room: a copy laid on top of another clip is not a copy of the
    // cut, it is two clips claiming one moment.
    const next = insertClip(tracks, clip.trackId, copy, clip.startMs + clip.durationMs);
    if (!next) return;
    updateTracks(next);
    setSelectedId(copy.id);
  };
  const duplicateSelected = () => duplicateClip(selected);
  const canSplit = (clip: TimelineClip | undefined) => {
    const track = tracks.find((item) => item.id === clip?.trackId);
    return Boolean(clip && track && !track.locked && playhead > clip.startMs && playhead < clipEndMs(clip));
  };
  const splitClip = (clip: TimelineClip | undefined) => {
    if (!clip || !canSplit(clip)) return;
    const leftDuration = playhead - clip.startMs;
    const right: TimelineClip = { ...clip, id: `${clip.id}-split-${Date.now()}`, startMs: playhead, durationMs: clip.durationMs - leftDuration, sourceStartMs: Math.round(clipSourceTimeMs(clip, playhead)), label: `${clip.label} · B`, transition: undefined };
    updateTracks(tracks.map((track) => track.id === clip.trackId ? { ...track, clips: track.clips.flatMap((item) => item.id === clip.id ? [{ ...item, durationMs: leftDuration, label: `${item.label} · A` }, right] : [item]) } : track));
    setSelectedId(right.id);
  };
  const splitSelected = () => splitClip(selected);
  /* Clipboard. Copy holds the clip as it is; Cut is Copy then Delete; Paste
     lays a copy at the playhead (or where the lane was right-clicked) on the
     selected clip's track, falling back to the track it was copied from. */
  const copyClip = (clip: TimelineClip | undefined) => {
    if (!clip) return;
    clipboard.current = clip;
    setHasClipboard(true);
  };
  const cutClip = (clip: TimelineClip | undefined) => {
    if (!clip) return;
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track || track.locked) return;
    copyClip(clip);
    deleteClip(clip.id);
  };
  const paste = (trackId?: string, atMs = playhead) => {
    const source = clipboard.current;
    if (!source) return;
    const candidates = [trackId, selectedTrack?.id, source.trackId, ...tracks.filter((track) => track.kind === "video").map((track) => track.id)];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const id = `${source.id.replace(/-paste-\d+$/, "")}-paste-${Date.now()}`;
      const next = pasteClip(tracks, source, candidate, atMs, id);
      if (!next) continue;
      updateTracks(next);
      setSelectedId(id);
      return;
    }
  };
  /* Same rule as Split: a disabled control says why it is disabled, and the
     predicate is the handler's own guard rather than a looser approximation. */
  const splitBlockedBy = !selected
    ? "Select a clip to split it"
    : !selectedTrack || selectedTrack.locked
      ? "This clip’s track is locked"
      : !canSplit(selected)
        ? "Move the playhead inside the selected clip to split it"
        : null;
  const duplicateBlockedBy = !selected
    ? "Select a clip to duplicate it"
    : !selectedTrack || selectedTrack.locked ? "This clip’s track is locked" : null;
  const deleteBlockedBy = !selected
    ? "Select a clip to delete it"
    : !selectedTrack || selectedTrack.locked ? "This clip’s track is locked" : null;
  /* Same rule again for the transport: every one of its controls is off for the
     same reason, and saying that reason is the difference between a disabled
     button and a broken one. */
  const transportBlockedBy = clipCount === 0 ? "Nothing to play yet" : null;

  /* --- Transport ------------------------------------------------------------ */

  const frameOf = (ms: number) => frameAt(ms, fps);
  const goTo = (ms: number) => {
    setPlaying(false);
    setRate(1);
    setPlayhead(Math.round(Math.max(0, Math.min(duration, ms))));
  };
  const stepFrames = (frames: number) => goTo(frameStartMs(Math.max(0, frameOf(playhead) + frames), fps));
  const togglePlay = () => {
    if (clipCount === 0) return;
    if (playing) { setPlaying(false); setRate(1); return; }
    // Pressing Play with the playhead already past the last frame used to
    // start playback that immediately stopped, which reads as a broken
    // button. From the end, Play means play it again.
    if (playhead >= contentEndMs) setPlayhead(0);
    setRate(1);
    setPlaying(true);
  };
  /* J / K / L: reverse, stop, forward. Pressing J or L again while it is
     already shuttling that way doubles the speed, up to 4×. */
  const shuttle = (direction: -1 | 1) => {
    if (clipCount === 0) return;
    const current = playing ? rate : 0;
    const speed = Math.sign(current) === direction
      ? SHUTTLE_SPEEDS[Math.min(SHUTTLE_SPEEDS.length - 1, SHUTTLE_SPEEDS.indexOf(Math.abs(current)) + 1)]
      : 1;
    if (direction > 0 && !playing && playhead >= contentEndMs) setPlayhead(0);
    setRate(direction * speed);
    setPlaying(true);
  };
  const markIn = (ms = playhead) => { setInMs(ms); if (outMs !== null && outMs <= ms) setOutMs(null); };
  const markOut = (ms = playhead) => { setOutMs(ms); if (inMs !== null && inMs >= ms) setInMs(null); };
  const clearInOut = () => { setInMs(null); setOutMs(null); };
  const commitTimecode = () => {
    if (timecodeDraft === null) return;
    const parsed = parseTimecode(timecodeDraft, fps);
    setTimecodeDraft(null);
    if (parsed !== null) goTo(parsed);
  };
  const renameSelected = () => {
    if (!selected) return;
    if (!inspectorOpen) toggleInspector();
    requestAnimationFrame(() => { clipNameRef.current?.focus(); clipNameRef.current?.select(); });
  };

  /* --- Keyboard ----------------------------------------------------------------
     Scoped to this view: they fire while focus is anywhere inside it (the
     view itself is focusable, so a click on any empty part of it counts) and
     never from a text field. Ctrl+Z / Ctrl+Y are NOT here: undo is the
     project's, bound once in ProjectWorkspace, and every edit below goes
     through onChange so it lands on that stack. */
  const scope = { scope: viewRef };
  const arrows = (run: () => void) => (event: KeyboardEvent) => { if (ownsArrowKeys(event.target)) return false; run(); };
  useShortcut("Space", (event) => {
    const target = event.target as Element | null;
    if (target instanceof HTMLButtonElement || target?.closest?.('[role="tab"], [role="slider"]')) return false;
    if (clipCount === 0) return false;
    togglePlay();
  }, scope);
  useShortcut("J", () => shuttle(-1), scope);
  useShortcut("K", () => { setPlaying(false); setRate(1); }, scope);
  useShortcut("L", () => shuttle(1), scope);
  useShortcut("ArrowLeft", arrows(() => stepFrames(-1)), scope);
  useShortcut("ArrowRight", arrows(() => stepFrames(1)), scope);
  useShortcut("Shift+ArrowLeft", arrows(() => goTo(playhead - 1000)), scope);
  useShortcut("Shift+ArrowRight", arrows(() => goTo(playhead + 1000)), scope);
  useShortcut("Home", arrows(() => goTo(0)), scope);
  useShortcut("End", arrows(() => goTo(contentEndMs)), scope);
  useShortcut("ArrowUp", arrows(() => { const cut = adjacentCut(tracks, playhead, -1); if (cut !== null) goTo(cut); }), scope);
  useShortcut("ArrowDown", arrows(() => { const cut = adjacentCut(tracks, playhead, 1); if (cut !== null) goTo(cut); }), scope);
  useShortcut("I", () => markIn(), scope);
  useShortcut("O", () => markOut(), scope);
  useShortcut("Ctrl+Shift+X", clearInOut, scope);
  useShortcut("Ctrl+K", splitSelected, scope);
  useShortcut("Ctrl+D", duplicateSelected, scope);
  useShortcut("Ctrl+C", () => { if (!selected) return false; copyClip(selected); }, scope);
  useShortcut("Ctrl+X", () => { if (!selected) return false; cutClip(selected); }, scope);
  useShortcut("Ctrl+V", () => { if (!clipboard.current) return false; paste(); }, scope);
  useShortcut("F2", () => { if (!selected) return false; renameSelected(); }, scope);
  useShortcut(["-", "_"], () => zoomTo(pxPerSecond / ZOOM_STEP), scope);
  useShortcut(["=", "+"], () => zoomTo(pxPerSecond * ZOOM_STEP), scope);
  useShortcut(["Delete", "Backspace"], (event) => {
    /* A focused media card is what Delete means: take the file out of the
       project (and its clips off the timeline). Anywhere else, the clip. */
    const card = (event.target as Element | null)?.closest?.("[data-asset-id]") as HTMLElement | null;
    if (card?.dataset.assetId) { removeMediaAsset(card.dataset.assetId); return; }
    if (!selected) return false;
    removeSelected();
  }, scope);

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
        hasAudio: file.kind === "audio" ? true : null,
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

  /* Every lane is audiovisual, so video, stills, and sound can be arranged on
     any unlocked track. */
  const acceptsAsset = (track: ProjectConfig["timeline"]["tracks"][number], asset: ProjectAsset | undefined) => {
    if (!asset || track.locked) return false;
    return asset.kind !== "caption";
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
    hasAudio: asset.hasAudio ?? value.hasAudio,
  });
  /* Measurements arrive from asynchronous decodes, and two of them can land
     between one render and the next. They queue here, and nothing here writes a
     config: it hands up an UPDATER, which the holder applies to whatever its
     latest config is — a flush can no longer be stale, because it no longer
     carries a config of its own. The queue is drained into a local BEFORE the
     updater is built, so the updater stays pure and can be called twice
     (StrictMode, a replayed render) without eating the queue. */
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
        if (next.durationMs === asset.durationMs && next.width === asset.width && next.height === asset.height && next.hasAudio === asset.hasAudio) return asset;
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
    ? Math.max(1, ((sceneMediaDurationMs(selectedAsset) ?? selectedAsset.durationMs) - selected.sourceStartMs) / clipPlaybackRate(selected))
    : null;
  const minClipMs = Math.max(1, Math.round(1000 / fps));
  const speedDisabled = !selected || tracks.find((track) => track.id === selected.trackId)?.locked || !selectedAsset || !["video", "generated", "audio"].includes(selectedAsset.kind);
  const changeSpeed = (percent: number) => {
    if (!selected || speedDisabled) return;
    const next = retimeClip(tracks, selected.id, percent / 100);
    if (next) { setDurationDraft(null); updateTracks(next, `speed:${selected.id}`); }
  };
  /** What the FILE has left at each end of a clip. A still image and a file
   *  nothing has measured have no source timeline to run out of, and get no
   *  limit rather than a guessed one. */
  const roomFor = (clip: TimelineClip) => {
    const asset = assetById(clip.assetId);
    return sourceRoom(clip, asset && asset.kind !== "image" ? sceneMediaDurationMs(asset) ?? null : null);
  };
  /* Typing a length is trimming the tail, so it is the same operation the
     right-hand handle performs — same floor of one frame, same ceiling in the
     footage, and the same refusal to grow over the next clip on the track. */
  const typeDuration = (value: string) => {
    setDurationDraft(value);
    const parsed = selected ? parseTimecode(value, fps) : null;
    if (parsed === null || !selected) return;
    const next = trimClip(tracks, selected.id, "end", selected.startMs + parsed, { minClipMs, room: roomFor(selected) });
    if (next) updateTracks(next, `duration:${selected.id}`);
  };
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
    /* Honor the drop position and grow the project to fit the entire clip.
       A lane not yet laid out has no finite ratio; its drop starts at zero. */
    const position = Number.isFinite(ratio) ? ratio * duration : 0;
    const startMs = Math.round(Math.max(0, position));
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
      const startMs = Math.round(Math.max(0, position));
      const clip: TimelineClip = {
        id: clipId,
        assetId: asset.id,
        trackId,
        startMs,
        durationMs: existing?.sceneSegments?.length ? sceneMediaDurationMs(existing)! : sceneLengthMs,
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
      return withTimelineTracks({ ...current, assets }, nextTracks);
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
    // Left button only: a right-click opens the clip's context menu, and a
    // middle-click is a scroll gesture in most shells.
    if (event.button !== 0) return;
    const track = tracks.find((item) => item.id === clip.trackId);
    if (!track || track.locked) { setSelectedId(clip.id); return; }
    const lane = (event.currentTarget as HTMLElement).closest(".track-lane") as HTMLElement | null;
    const rect = lane?.getBoundingClientRect();
    // Nothing has been laid out: there is no scale to turn pixels into time
    // with, and a drag measured against a zero-width lane would put the clip at
    // an arbitrary place on the ruler. The clip still selects.
    if (!rect || rect.width <= 0) { setSelectedId(clip.id); return; }
    dropSelection();
    const msPerPx = duration / rect.width;
    const snap = snapFor(rect.width, clip.id);
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
      snap,
      snapSet: new Set(snap.toleranceMs > 0 ? snap.targets : []),
      playheadMs: Math.round(playhead),
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
    setSnapMark(null);
    setDragging(false);
  };

  useEffect(() => {
    if (!dragging) return;
    /* The preview, and whether the edge being placed landed on a snap target.
       Both are set in the same handler, so it is still one render per move. */
    const show = (next: TimelineTrack[] | null) => {
      previewRef.current = next;
      setPreview(next);
      const session = dragRef.current;
      const placed = next && session ? findClip(next, session.clipId)?.clip : undefined;
      if (!session || !placed || session.snapSet.size === 0) { setSnapMark(null); return; }
      const edges = session.mode === "trim-start" ? [placed.startMs]
        : session.mode === "trim-end" ? [clipEndMs(placed)]
          : [placed.startMs, clipEndMs(placed)];
      const ms = edges.find((edge) => session.snapSet.has(edge));
      setSnapMark(ms === undefined ? null : {
        ms,
        label: ms === 0 ? "timeline start" : ms === session.playheadMs ? "playhead" : "clip edge",
      });
    };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // With none left, go to an empty composer. Every later shot has the brief
    // already spent on the shot before it, so repeating it would describe the
    // whole video a second time and call it shot two.
    onOpenGenerator(config.generationJobs.find((job) => job.status === "draft")?.id);
  };

  /* --- Context menus ----------------------------------------------------------- */

  const clipMenuItems = (clip: TimelineClip): MenuEntry[] => {
    const track = tracks.find((item) => item.id === clip.trackId);
    const locked = !track || track.locked;
    return [
      { label: "Cut", shortcut: "Ctrl+X", disabled: locked, onSelect: () => cutClip(clip) },
      { label: "Copy", icon: <Copy16 />, shortcut: "Ctrl+C", onSelect: () => copyClip(clip) },
      { label: "Paste", shortcut: "Ctrl+V", disabled: !hasClipboard, onSelect: () => paste(clip.trackId) },
      { separator: true },
      { label: "Split at playhead", icon: <Cut16 />, shortcut: "Ctrl+K", disabled: !canSplit(clip), onSelect: () => splitClip(clip) },
      { label: "Duplicate", shortcut: "Ctrl+D", disabled: locked, onSelect: () => duplicateClip(clip) },
      { label: "Rename", shortcut: "F2", onSelect: () => { setSelectedId(clip.id); renameSelected(); } },
      { separator: true },
      { label: "Delete", icon: <Delete16 />, shortcut: "Delete", danger: true, disabled: locked, onSelect: () => deleteClip(clip.id) },
    ];
  };
  const laneTimeAt = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return rect.width > 0 ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration : playhead;
  };

  /* The rows call back through a ref so they can be memoised (see
     TrackActions): nothing in a lane changes when only the playhead moves. */
  const actions = useRef<TrackActions>(null as unknown as TrackActions);
  actions.current = {
    select: setSelectedId,
    toggle: toggleTrack,
    rename: renameTrack,
    clipPointerDown: beginDrag,
    clipMenu: (event, clip) => {
      setSelectedId(clip.id);
      menu.open(event, clipMenuItems(clip), { "aria-label": `${clip.label} actions` });
    },
    laneMenu: (event, track) => {
      const at = laneTimeAt(event);
      menu.open(event, [
        { label: "Paste here", shortcut: "Ctrl+V", disabled: !hasClipboard || track.locked, onSelect: () => paste(track.id, at) },
        { separator: true },
        { label: track.muted ? "Unmute track" : "Mute track", onSelect: () => toggleTrack(track.id, "muted") },
        { label: track.locked ? "Unlock track" : "Lock track", onSelect: () => toggleTrack(track.id, "locked") },
      ], { "aria-label": `${track.name} actions` });
    },
    dragOverLane: (event, track) => {
      const hasAsset = event.dataTransfer.types.includes(ASSET_DRAG_TYPE);
      const hasScene = event.dataTransfer.types.includes(SCENE_DRAG_TYPE);
      if ((!hasAsset || !acceptsAsset(track, draggedAsset)) && (!hasScene || !acceptsScene(track, draggedScene))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropTrackId(track.id);
    },
    dragLeaveLane: (track) => setDropTrackId((current) => current === track.id ? null : current),
    dropLane: (event, track) => {
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
    },
  };

  const rulerMenu = (event: React.MouseEvent<HTMLElement>) => {
    const at = timeAtRuler(event.clientX) ?? playhead;
    menu.open(event, [
      { label: "Set in point", shortcut: "I", onSelect: () => markIn(at) },
      { label: "Set out point", shortcut: "O", onSelect: () => markOut(at) },
      { separator: true },
      { label: "Clear in and out", shortcut: "Ctrl+Shift+X", disabled: inMs === null && outMs === null, onSelect: clearInOut },
    ], { "aria-label": "Ruler actions" });
  };

  /* --- Program monitor ------------------------------------------------------ */

  const frameSize = outputDimensions(config.settings.resolution, config.settings.aspectRatio);
  const monitorScale = monitorZoom === "fit" ? null : Number(monitorZoom) / 100;
  const changeMonitorZoom = useCallback((next: MonitorZoom, pointer?: { x: number; y: number }) => {
    const canvas = monitorCanvasRef.current;
    if (canvas && next !== monitorZoom) {
      const scale = monitorZoom === "fit"
        ? Math.min(canvas.clientWidth / frameSize.width, canvas.clientHeight / frameSize.height)
        : monitorZoom / 100;
      const screenX = pointer?.x ?? canvas.clientWidth / 2;
      const screenY = pointer?.y ?? canvas.clientHeight / 2;
      if (scale > 0) monitorAnchor.current = {
        x: (canvas.scrollLeft + screenX - Math.max(0, (canvas.clientWidth - frameSize.width * scale) / 2)) / scale,
        y: (canvas.scrollTop + screenY - Math.max(0, (canvas.clientHeight - frameSize.height * scale) / 2)) / scale,
        screenX,
        screenY,
      };
    }
    setMonitorZoom(next);
  }, [monitorZoom, frameSize.width, frameSize.height]);
  const stepMonitorZoom = useCallback((direction: 1 | -1, pointer?: { x: number; y: number }) => {
    const canvas = monitorCanvasRef.current;
    const current = monitorZoom === "fit"
      ? (canvas ? Math.min(canvas.clientWidth / frameSize.width, canvas.clientHeight / frameSize.height) * 100 : 100)
      : monitorZoom;
    const next = direction > 0
      ? MONITOR_ZOOM_STEPS.find((step) => step > current + 1e-6)
      : [...MONITOR_ZOOM_STEPS].reverse().find((step) => step < current - 1e-6);
    if (next !== undefined) changeMonitorZoom(next, pointer);
  }, [monitorZoom, frameSize.width, frameSize.height, changeMonitorZoom]);
  useLayoutEffect(() => {
    const canvas = monitorCanvasRef.current;
    const anchor = monitorAnchor.current;
    if (canvas) {
      if (monitorZoom === "fit") {
        canvas.scrollLeft = 0;
        canvas.scrollTop = 0;
      } else if (anchor) {
        canvas.scrollLeft = Math.max(0, anchor.x * monitorZoom / 100 - anchor.screenX);
        canvas.scrollTop = Math.max(0, anchor.y * monitorZoom / 100 - anchor.screenY);
      }
    }
    monitorAnchor.current = null;
  }, [monitorZoom]);
  useEffect(() => {
    const canvas = monitorCanvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      if (!event.deltaY) return;
      const bounds = canvas.getBoundingClientRect();
      stepMonitorZoom(event.deltaY < 0 ? 1 : -1, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [stepMonitorZoom]);
  const stageStyle = {
    "--frame-aspect": frameSize.width / frameSize.height,
    ...(monitorScale ? { width: frameSize.width * monitorScale, height: frameSize.height * monitorScale, flex: "none" } : {}),
  } as React.CSSProperties;

  /* The ruler is memoised (it must not re-render with every playhead frame),
     so it gets handlers whose identity never changes. */
  const rulerHandlers = useRef({ beginScrub, rulerMenu });
  rulerHandlers.current = { beginScrub, rulerMenu };
  const onRulerPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => rulerHandlers.current.beginScrub(event), []);
  const onRulerMenu = useCallback((event: React.MouseEvent<HTMLElement>) => rulerHandlers.current.rulerMenu(event), []);

  const playheadTimecode = formatTimecode(playhead, fps);
  const framesAt = playheadTimecode.lastIndexOf(":");
  const panelsClass = `edit-panels${sourcesOpen ? "" : " edit-panels--no-sources"}${inspectorOpen ? "" : " edit-panels--no-inspector"}`;

  return (
    <div
      ref={viewRef}
      className={`timeline-view ${dragging ? "timeline-view--dragging" : ""}`}
      tabIndex={0}
      style={{ ...sourcesPane.style, ...inspectorPane.style, ...timelinePane.style, ...trackPane.style }}
    >
      {/* The view had no top-level heading at all, so screen-reader users had
          no landmark for it. Sighted users already see the title bar. */}
      <h1 className="sr-only">Timeline editor</h1>
      <div className={panelsClass}>
        {sourcesOpen && <aside className="scene-panel" aria-label="Scenes and media">
          {/* One toolbar for both views: the views lead, the actions trail, and
              the content below starts at the same height on either tab. */}
          <PaneHeader
            className="scene-panel__toolbar"
            views={<SelectorBar
              compact
              aria-label="Scenes and media"
              value={panelTab}
              onChange={setPanelTab}
              items={[{ value: "scenes", label: "Scenes" }, { value: "media", label: "Media" }]}
            />}
            actions={<>
              <button
                type="button"
                className="scene-panel__import"
                onClick={() => void importMedia()}
                disabled={importing || !isTauri()}
                {...tooltipProps(isTauri() ? "Add video, sound or image files. Video and sound stay where they are; images are copied in." : "Importing files is available in the desktop app")}
              ><Import16 aria-hidden="true" /><span className="sr-only">Import</span></button>
              {panelTab === "media" && <div className="scene-panel__layout" role="group" aria-label="Media layout">
                <button
                  type="button"
                  className="ui-toggle-button scene-panel__toggle"
                  aria-pressed={mediaLayout === "grid"}
                  onClick={() => chooseMediaLayout("grid")}
                  {...tooltipProps("Grid")}
                >{mediaLayout === "grid" ? <GridView16Filled aria-hidden="true" /> : <GridView16 aria-hidden="true" />}<span className="sr-only">Grid</span></button>
                <button
                  type="button"
                  className="ui-toggle-button scene-panel__toggle"
                  aria-pressed={mediaLayout === "list"}
                  onClick={() => chooseMediaLayout("list")}
                  {...tooltipProps("List")}
                >{mediaLayout === "list" ? <ListView16Filled aria-hidden="true" /> : <ListView16 aria-hidden="true" />}<span className="sr-only">List</span></button>
              </div>}
            </>}
          />
          {panelTab === "scenes" ? (
            <div className="scene-list" role="tabpanel" aria-label="Scenes">
              {config.generationJobs.map((job, index) => {
                const joined = longShotPlaybackSource(job, config);
                const assetIds = new Set([
                  generationAssetId(job.id),
                  ...config.assets.filter((asset) => job.outputRelativePath && asset.relativePath === job.outputRelativePath).map((asset) => asset.id),
                ]);
                const placements = tracks.flatMap((track) => track.clips).filter((clip) => clip.id === job.clipId || assetIds.has(clip.assetId)).length;
                const open = job.id === openSceneId;
                return <button
                  key={job.id}
                  className={`scene-card ui-selectable ui-selectable--separated${open ? " is-selected" : ""}`}
                  draggable
                  data-scene-id={job.id}
                  aria-current={open ? "true" : undefined}
                  onClick={() => onOpenGenerator(job.id)}
                  onContextMenu={(event) => menu.open(event, [
                    { label: "Open in Generator", onSelect: () => onOpenGenerator(job.id) },
                  ], { "aria-label": `${job.title} actions` })}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(SCENE_DRAG_TYPE, job.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDraggedScene(job);
                    setDraggedAsset(undefined);
                  }}
                  onDragEnd={() => { setDraggedScene(undefined); setDropTrackId(null); }}
                  {...tooltipProps(`${job.title} · ${sceneShape(job)}. Drag onto a track to use it.`)}
                >
                  <span className="scene-card__thumb">
                    {job.status !== "draft" ? <ShotThumbnail folderPath={folderPath} job={joined ? { ...job, outputRelativePath: joined.source.relativePath } : job} seconds={0} sourceOffsetSeconds={joined ? joined.segment.startFrame / 24 : sceneMediaStartSeconds(assetsById.get(generationAssetId(job.id)))} shotNumber={1} estimatedCompletionAt={generationCompletionTimes[job.id] ?? null} />
                      : <Film20 aria-hidden="true" />}
                    <i>{String(index + 1).padStart(2, "0")}</i><em>{sceneDurationSeconds(job).toFixed(1)}s</em>
                  </span>
                  <span>
                    <b>{job.title}</b>
                    {/* A status dot before the word; the scene's shape (length,
                        shots) moved into the tooltip. */}
                    <small><span className={`scene-card__status scene-card__status--${job.status}`}>{STATUS_BADGE[job.status]}</span>{placements > 0 ? ` · ${placements} on timeline` : ""}</small>
                  </span>
                </button>;
              })}
              <button className="secondary-button scene-add" onClick={addScene}><Add16 /> Add scene</button>
            </div>
          ) : (
            <div className={`media-grid media-grid--${mediaLayout}`} role="tabpanel" aria-label="Media">
              {/* Draggable onto the timeline. `draggable` on a <button> is the
                  whole mechanism — the button still clicks and still takes
                  focus, so keyboard users are not shut out of selecting it.
                  Removing a file is Delete on the focused card, or its context
                  menu: no × on every card. The selected card is the one Delete
                  acts on — the focused one, or the last one clicked. */}
              {mediaAssets.map((asset) => <div className="media-card" key={asset.id}>
                <button
                  className={`media-card__source ui-selectable ui-selectable--card${asset.id === mediaSelectedId ? " is-selected" : ""}`}
                  draggable
                  data-asset-id={asset.id}
                  onFocus={() => setMediaSelectedId(asset.id)}
                  onClick={() => setMediaSelectedId(asset.id)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id);
                    event.dataTransfer.effectAllowed = "copy";
                    setDraggedAsset(asset);
                    setDraggedScene(undefined);
                  }}
                  onDragEnd={() => { setDraggedAsset(undefined); setDropTrackId(null); }}
                  onContextMenu={(event) => {
                    setMediaSelectedId(asset.id);
                    menu.open(event, [
                      { label: "Remove from project", icon: <Delete16 />, shortcut: "Delete", danger: true, onSelect: () => removeMediaAsset(asset.id) },
                    ], { "aria-label": `${asset.name} actions` });
                  }}
                  {...tooltipProps(`${asset.name}. Drag onto a track to use it.`)}
                >
                  <MediaThumbnail folderPath={folderPath} asset={asset} onMeasured={(measured) => recordMeasured(asset.id, measured)} />
                  <b>{asset.name}</b>
                  {/* Duration is only claimed when something actually measured it. */}
                  <small>{asset.kind}{asset.durationMs ? ` · ${(asset.durationMs / 1000).toFixed(1)}s` : ""}</small>
                </button>
              </div>)}
              {mediaAssets.length === 0 && !importError && <EmptyState
                className="media-grid__empty"
                icon={<Film32 />}
                title="No media yet"
                description="Import video, sound or images, then drag them onto a track."
                action={<button
                  type="button"
                  className="secondary-button"
                  onClick={() => void importMedia()}
                  disabled={importing || !isTauri()}
                  {...tooltipProps(isTauri() ? undefined : "Importing files is available in the desktop app")}
                ><Import16 aria-hidden="true" /> Import media</button>}
              />}
              {importError && <p className="panel-hint panel-hint--error" role="alert">{importError}</p>}
            </div>
          )}
        </aside>}
        {sourcesOpen && <Splitter {...sourcesPane.splitterProps} className="edit-panels__splitter" aria-label="Resize media panel" />}

        <main className="program-panel">
          <h2 className="sr-only">Program monitor</h2>
          <div ref={monitorCanvasRef} className={`program-canvas${monitorScale ? " program-canvas--zoomed" : ""}`}>
            <div className="program-stage" style={stageStyle}>
              {/* The real picture: the clip under the playhead, decoded from
                  its own file. An empty timeline still shows an empty monitor
                  with one muted line saying why. */}
              {clipCount > 0
                ? <ProgramMonitor
                  config={config}
                  folderPath={folderPath}
                  playheadMs={playhead}
                  playing={playing}
                  rate={rate}
                  onSeek={seek}
                  onPlayingChange={setPlayingFromMonitor}
                  selectedClipId={selectedId}
                  transformEditingDisabled={selectedTrack?.locked ?? false}
                  onSelectClip={setSelectedId}
                  onTransformChange={(clipId, transform) => updateClip(clipId, { transform: roundClipTransform(transform) }, `transform:${clipId}:gesture`)}
                />
                : <EmptyState
                  className="program-empty"
                  icon={<Scene32 />}
                  title="Nothing on the timeline yet"
                  description="Drop media on a track, or generate a scene."
                  action={<button
                    type="button"
                    className="secondary-button"
                    onClick={() => void importMedia()}
                    disabled={importing || !isTauri()}
                    {...tooltipProps(isTauri() ? undefined : "Importing files is available in the desktop app")}
                  ><Import16 aria-hidden="true" /> Import media</button>}
                />}
              {safeArea && <div className="program-safe" aria-hidden="true"><i className="program-safe__frame"><b className="program-safe__action" /><b className="program-safe__title" /></i></div>}
            </div>
          </div>
          {/* No header: the stage is the pane. The footer is its control strip —
              labelled values on the leading edge, view controls trailing. */}
          {/* The playhead's time is the timeline toolbar's timecode; the
              monitor does not repeat it. */}
          <footer className="program-footer">
            <span className="program-footer__value">
              <span className="program-footer__label" aria-hidden="true">Duration</span>
              <span className="program-footer__duration" aria-label="Timeline duration">{formatTimecode(contentEndMs, fps)}</span>
            </span>
            {(inMs !== null || outMs !== null) && <span className="program-footer__value">
              <span className="program-footer__label" aria-hidden="true">In–out</span>
              <span className="program-footer__range" aria-label="In to out">{formatTimecode(Math.max(0, (outMs ?? duration) - (inMs ?? 0)), fps)}</span>
            </span>}
            <span className="program-footer__spacer" />
            <button type="button" className="program-footer__toggle" aria-label="Zoom out preview"
              disabled={monitorZoom === MONITOR_ZOOM_STEPS[0]} onClick={() => stepMonitorZoom(-1)}
              {...tooltipProps("Zoom out preview", "Ctrl+wheel")}><ZoomOut16 aria-hidden="true" /></button>
            <ComboBox
              className="program-footer__zoom"
              aria-label="Monitor zoom"
              value={String(monitorZoom)}
              onChange={(value) => changeMonitorZoom(value === "fit" ? "fit" : Number(value))}
              options={[{ value: "fit", label: "Fit" }, ...MONITOR_ZOOM_STEPS.map((step) => ({ value: String(step), label: `${step}%` }))]}
            />
            <button type="button" className="program-footer__toggle" aria-label="Zoom in preview"
              disabled={monitorZoom === MONITOR_ZOOM_STEPS.at(-1)} onClick={() => stepMonitorZoom(1)}
              {...tooltipProps("Zoom in preview", "Ctrl+wheel")}><ZoomIn16 aria-hidden="true" /></button>
            <button
              type="button"
              className="ui-toggle-button program-footer__toggle"
              aria-pressed={safeArea}
              aria-label="Safe areas"
              {...tooltipProps("Title and action safe areas")}
              onClick={() => setSafeArea((value) => !value)}
            >{safeArea ? <SafeArea16Filled aria-hidden="true" /> : <SafeArea16 aria-hidden="true" />}</button>
          </footer>
        </main>

        {inspectorOpen && <Splitter {...inspectorPane.splitterProps} reverse className="edit-panels__splitter" aria-label="Resize inspector" />}
        {inspectorOpen && <aside className="clip-inspector" aria-label="Clip inspector">
          {selected && selectedKind ? <>
            {/* The selected clip heads the pane: its kind, its name (editable
                in place, and still the pane's heading for a screen reader),
                and where it sits. */}
            <ItemHeader
              className="clip-inspector__header"
              color={CLIP_KINDS[selectedKind].color}
              icon={CLIP_KINDS[selectedKind].icon}
              name={<h2 className="clip-inspector__heading" aria-label={selected.label}><input
                ref={clipNameRef}
                className="ui-item-header__input"
                value={selected.label}
                aria-label="Clip name"
                {...tooltipProps("Rename", "F2")}
                onChange={(event) => updateClip(selected.id, { label: event.target.value || "Untitled clip" }, `label:${selected.id}`)}
              /></h2>}
              meta={`${CLIP_KINDS[selectedKind].label} · ${trackLabels.get(selected.trackId) ?? ""} · ${(selected.durationMs / 1000).toFixed(1)} s`}
              actions={<button
                type="button"
                className="icon-button clip-inspector__more"
                aria-label={`${selected.label} actions`}
                aria-haspopup="menu"
                {...tooltipProps("More options")}
                onClick={(event) => menu.open(event.currentTarget, clipMenuItems(selected), { "aria-label": `${selected.label} actions`, placement: "bottom-end", focusFirst: true })}
              ><More16 aria-hidden="true" /></button>}
            />
            <PropSection title="Timing" persistKey="timeline.clip.timing" summary={`${shortTimecode(selected.startMs, fps)} → ${shortTimecode(clipEndMs(selected), fps)}`}>
              <PropRow label="Speed" htmlFor="clip-speed" value={clipPlaybackRate(selected)} defaultValue={1}
                onReset={speedDisabled ? undefined : () => changeSpeed(100)}
                tooltip="100% is normal speed. Changes duration while keeping the same source range and moving later clips on this track. Audio pitch changes with speed.">
                <CommittedNumberInput id="clip-speed" className="text-field" aria-label="Clip speed" minimum={MIN_CLIP_SPEED * 100} maximum={MAX_CLIP_SPEED * 100} step={1}
                  value={Number((clipPlaybackRate(selected) * 100).toFixed(2))} disabled={speedDisabled} onCommit={changeSpeed} />
                <span className="inspector-unit">%</span>
              </PropRow>
              <PropRow label="Starts at"><span className="inspector-value">{formatTimecode(selected.startMs, fps)}</span></PropRow>
              <PropRow label="Duration" htmlFor="clip-duration">
                <input
                  id="clip-duration"
                  className="text-field inspector-timecode"
                  value={durationDraft ?? formatTimecode(selected.durationMs, fps)}
                  onChange={(event) => typeDuration(event.target.value)}
                  onBlur={() => setDurationDraft(null)}
                  {...tooltipProps(`HH:MM:SS:FF, MM:SS or seconds.${sourceLimitMs === null ? "" : ` ${(sourceLimitMs / 1000).toFixed(1)}s of footage left.`}`)}
                  inputMode="decimal"
                />
              </PropRow>
            </PropSection>
            <PropSection title="Transform" persistKey="timeline.clip.transform" summary={transformChanges > 0 ? `${transformChanges} changed` : undefined}>
              {([
                ["scale", "Scale", "%", 100],
                ["rotation", "Rotation", "°", 0],
                ["positionX", "Position X", "%", 0],
                ["positionY", "Position Y", "%", 0],
              ] as const).map(([key, label, unit, fallback]) => {
                const value = selectedTransform?.[key] ?? fallback;
                const [minimum, maximum] = TRANSFORM_LIMITS[key];
                return <PropRow
                  key={key}
                  label={label}
                  htmlFor={`clip-${key}`}
                  value={value}
                  defaultValue={fallback}
                  onReset={visualControlsDisabled ? undefined : () => updateTransform(key, fallback)}
                  scrub={visualControlsDisabled ? undefined : { value, onChange: (next) => updateTransform(key, next), min: minimum, max: maximum, step: 1 }}
                >
                  <CommittedNumberInput id={`clip-${key}`} className="text-field" aria-label={label} minimum={minimum} maximum={maximum} step="1" value={value} disabled={visualControlsDisabled} onCommit={(next) => updateTransform(key, next)} />
                  <span className="inspector-unit">{unit}</span>
                </PropRow>;
              })}
            </PropSection>
            <PropSection title="Effects" persistKey="timeline.clip.effects" summary={selectedEffects.total > 0 ? selectedEffects.on < selectedEffects.total ? `${selectedEffects.total} · ${selectedEffects.total - selectedEffects.on} off` : String(selectedEffects.total) : undefined}>
              <ClipEffects clip={selected} disabled={visualControlsDisabled} onChange={(patch, key) => updateClip(selected.id, patch, key && `effect:${selected.id}:${key}`)} />
            </PropSection>
          </> : <EmptyState
            className="inspector-empty"
            icon={<CursorClick32 />}
            title={clipCount === 0 ? "Nothing on the timeline yet" : "No clip selected"}
            description={clipCount === 0
              ? "Drag media or a scene onto a track, then select the clip to edit it here."
              : "Select a clip on the timeline, or click the picture, to edit its timing, transform and effects."}
          />}
        </aside>}
      </div>

      <Splitter {...timelinePane.splitterProps} orientation="horizontal" reverse className="timeline-view__splitter" aria-label="Resize timeline" />

      <section className="pro-timeline">
        <header className="timeline-toolbar">
          <div className="timeline-toolbar__lead">
            <h2>Timeline</h2>
            {timecodeDraft === null
              ? <button
                type="button"
                className="transport-time"
                aria-label={`Playhead ${formatTimecode(playhead, fps)}. Select to type a time.`}
                {...tooltipProps("Go to time")}
                onClick={() => setTimecodeDraft(formatTimecode(playhead, fps))}
              >{/* Frames a step dimmer than the time they count within. */}
                {playheadTimecode.slice(0, framesAt)}<span className="transport-time__frames">{playheadTimecode.slice(framesAt)}</span>
              </button>
              : <input
                className="text-field transport-time transport-time--editing"
                aria-label="Go to time"
                autoFocus
                value={timecodeDraft}
                onChange={(event) => setTimecodeDraft(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => setTimecodeDraft(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); commitTimecode(); }
                  if (event.key === "Escape") { event.preventDefault(); setTimecodeDraft(null); }
                }}
              />}
            <span className="transport-format">{resolutionLabel(config.settings.resolution, config.settings.aspectRatio)} · {fps} fps</span>
          </div>
          {/* Go to start · Frame back · Play/Pause · Frame forward · Go to end —
              the order every NLE uses, flat 28px buttons, no accent fill. */}
          <div className="timeline-transport" role="group" aria-label="Transport">
            <button onClick={() => goTo(0)} aria-label="Go to start" {...tooltipProps(transportBlockedBy ?? "Go to start", transportBlockedBy ? undefined : "Home")} disabled={transportBlockedBy !== null}><GoToStart16 /></button>
            <button onClick={() => stepFrames(-1)} aria-label="Previous frame" {...tooltipProps(transportBlockedBy ?? "Previous frame", transportBlockedBy ? undefined : "Left")} disabled={transportBlockedBy !== null}><PreviousFrame16 /></button>
            <button className="play-button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} disabled={transportBlockedBy !== null} {...tooltipProps(transportBlockedBy ?? (playing ? "Pause" : "Play"), transportBlockedBy ? undefined : "Space")}>{playing ? <Pause16 /> : <Play16 />}</button>
            <button onClick={() => stepFrames(1)} aria-label="Next frame" {...tooltipProps(transportBlockedBy ?? "Next frame", transportBlockedBy ? undefined : "Right")} disabled={transportBlockedBy !== null}><NextFrame16 /></button>
            <button onClick={() => goTo(contentEndMs)} aria-label="Go to end" {...tooltipProps(transportBlockedBy ?? "Go to end", transportBlockedBy ? undefined : "End")} disabled={transportBlockedBy !== null}><GoToEnd16 /></button>
            {playing && rate !== 1 && <span className="transport-rate" aria-live="polite">{rate > 0 ? `${rate}×` : `−${-rate}×`}</span>}
          </div>
          <div className="timeline-tools">
            <button onClick={splitSelected} disabled={splitBlockedBy !== null} {...tooltipProps(splitBlockedBy ?? "Split at playhead", splitBlockedBy ? undefined : "Ctrl+K")}><Cut16 /> Split</button>
            <button onClick={duplicateSelected} disabled={duplicateBlockedBy !== null} {...tooltipProps(duplicateBlockedBy ?? "Duplicate clip", duplicateBlockedBy ? undefined : "Ctrl+D")}><Copy16 /> Duplicate</button>
            <button onClick={removeSelected} disabled={deleteBlockedBy !== null} {...tooltipProps(deleteBlockedBy ?? "Delete clip", deleteBlockedBy ? undefined : "Delete")}><Delete16 /> Delete</button>
            <span className="timeline-tools__separator" aria-hidden="true" />
            <button className="timeline-tools__icon" onClick={() => zoomTo(pxPerSecond / ZOOM_STEP)} disabled={!lanePx || pxPerSecond <= minPps + 1e-6} aria-label="Zoom out" {...tooltipProps("Zoom out", "-")}><ZoomOut16 /></button>
            <Slider className="timeline-zoom" aria-label="Timeline zoom" min={0} max={100} step={1} value={zoomSliderValue} disabled={!lanePx} onChange={zoomFromSlider} />
            <button className="timeline-tools__icon" onClick={() => zoomTo(pxPerSecond * ZOOM_STEP)} disabled={!lanePx || pxPerSecond >= maxPps - 1e-6} aria-label="Zoom in" {...tooltipProps("Zoom in", "=")}><ZoomIn16 /></button>
            <span className="timeline-tools__separator" aria-hidden="true" />
            <button className="timeline-tools__icon ui-toggle-button" onClick={toggleSources} aria-pressed={sourcesOpen} aria-label="Media panel" {...tooltipProps(sourcesOpen ? "Hide media panel" : "Show media panel")}>{sourcesOpen ? <PanelLeft16Filled /> : <PanelLeft16 />}</button>
            <button className="timeline-tools__icon ui-toggle-button" onClick={toggleInspector} aria-pressed={inspectorOpen} aria-label="Inspector" {...tooltipProps(inspectorOpen ? "Hide inspector" : "Show inspector")}>{inspectorOpen ? <PanelRight16Filled /> : <PanelRight16 />}</button>
          </div>
        </header>
        <div className="timeline-body">
          <div className="timeline-grid-scroll" ref={scrollRef}>
            <div
              className="timeline-grid"
              style={{
                "--lane-grid": `${(scale.majorMs / duration) * 100}%`,
                width: lanePx ? `calc(var(--track-column) + ${lanePx}px)` : "100%",
              } as React.CSSProperties}
            >
              <div className="track-corner" />
              <TimeRuler
                rulerRef={rulerRef}
                scrollRef={scrollRef}
                durationMs={duration}
                lanePx={lanePx}
                majorMs={scale.majorMs}
                minorMs={scale.minorMs}
                frames={scale.frames}
                fps={fps}
                inMs={inMs}
                outMs={outMs}
                onPointerDown={onRulerPointerDown}
                onContextMenu={onRulerMenu}
              />
              {drawnTracks.map((track, index) => <TrackRow
                key={track.id}
                track={track}
                alt={index % 2 === 1}
                label={trackLabels.get(track.id) ?? ""}
                duration={duration}
                folderPath={folderPath}
                generatedJobsByAssetId={generatedJobsByAssetId}
                assetsById={assetsById}
                playbackClips={playbackClips}
                selectedId={selectedId}
                draggingId={dragging ? dragRef.current?.clipId : undefined}
                dropActive={dropTrackId === track.id}
                /* A lane that stays dark is indistinguishable from a lane the
                   pointer simply is not over. Mark incompatible or locked lanes
                   for the whole drag, not just on hover. */
                dropBlocked={(draggedAsset !== undefined && !acceptsAsset(track, draggedAsset))
                  || (draggedScene !== undefined && !acceptsScene(track, draggedScene))}
                actions={actions}
              />)}
              {/* The in/out range, carried down through the lanes from the
                  ruler so what it covers can be read against the clips. */}
              {(inMs !== null || outMs !== null) && <div
                className="timeline-range"
                aria-hidden="true"
                style={{
                  left: `calc(var(--track-column) + (100% - var(--track-column)) * ${(inMs ?? 0) / duration})`,
                  width: `calc((100% - var(--track-column)) * ${((outMs ?? duration) - (inMs ?? 0)) / duration})`,
                }}
              />}
              {snapMark && <div
                className="timeline-snap"
                aria-hidden="true"
                style={{ left: `calc(var(--track-column) + (100% - var(--track-column)) * ${snapMark.ms / duration})` }}
              ><span>snap · {snapMark.label}</span></div>}
              {/* The playhead: a pentagon head in the ruler that can be dragged,
                  and a line through every track. While it is being dragged it
                  carries a flag with the time it is at. */}
              <div ref={playheadMarkerRef} className="timeline-playhead">
                <span className="timeline-playhead__head" onPointerDown={beginScrub} aria-hidden="true" />
                {scrubbing && <span className="timeline-playhead__flag" aria-hidden="true">{formatTimecode(playhead, fps)}</span>}
              </div>
            </div>
          </div>
          <Splitter {...trackPane.splitterProps} className="timeline-track-splitter" aria-label="Resize track headers" />
        </div>
      </section>
      <ProjectStatus label="Timeline status"><PreviewEngineStatus /></ProjectStatus>
      {menu.element}
    </div>
  );
}

/** The time ruler: labels at a density that follows the zoom (frames when
 *  zoomed in), minor ticks painted as a background, the in/out range shaded.
 *  Only the labels inside the visible stretch are rendered, and it re-renders
 *  on scroll by itself — never because the playhead moved. */
const TimeRuler = memo(function TimeRuler({ rulerRef, scrollRef, durationMs, lanePx, majorMs, minorMs, frames, fps, inMs, outMs, onPointerDown, onContextMenu }: {
  rulerRef: MutableRefObject<HTMLDivElement | null>;
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  durationMs: number;
  lanePx: number | null;
  majorMs: number;
  minorMs: number;
  frames: boolean;
  fps: number;
  inMs: number | null;
  outMs: number | null;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  const [view, setView] = useState({ left: 0, width: 0 });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const read = () => { frame = 0; setView({ left: element.scrollLeft, width: element.clientWidth }); };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    read();
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onScroll);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);
  const ticks = useMemo(() => {
    let first = 0;
    let last = durationMs;
    if (lanePx && view.width > 0) {
      const msPerPx = durationMs / lanePx;
      first = Math.max(0, (view.left - 200) * msPerPx);
      last = Math.min(durationMs, (view.left + view.width + 200) * msPerPx);
    }
    const result: number[] = [];
    for (let index = Math.floor(first / majorMs); index * majorMs <= last && result.length < 2000; index += 1) result.push(index * majorMs);
    return result;
  }, [durationMs, lanePx, majorMs, view.left, view.width]);
  const percent = (ms: number) => `${(ms / durationMs) * 100}%`;
  return <div
    ref={rulerRef}
    className="time-ruler"
    style={{ backgroundSize: `${(minorMs / durationMs) * 100}% 5px` }}
    onPointerDown={onPointerDown}
    onContextMenu={onContextMenu}
  >
    {(inMs !== null || outMs !== null) && <span
      className="time-ruler__range"
      aria-label="In and out range"
      style={{ left: percent(inMs ?? 0), width: percent((outMs ?? durationMs) - (inMs ?? 0)) }}
    />}
    {ticks.map((ms) => <span key={ms} className="time-ruler__tick" style={{ left: percent(ms) }}>{rulerLabel(ms, fps, frames)}</span>)}
  </div>;
});

const TrackRow = memo(function TrackRow({ track, alt, label, duration, folderPath, generatedJobsByAssetId, assetsById, playbackClips, selectedId, draggingId, dropActive, dropBlocked, actions }: {
  track: ProjectConfig["timeline"]["tracks"][number];
  /** Every other lane sits a step lighter on the well. */
  alt: boolean;
  /** "V1", "A1"… */
  label: string;
  duration: number;
  folderPath: string;
  generatedJobsByAssetId: ReadonlyMap<string, GenerationJob>;
  assetsById: ReadonlyMap<string, ProjectAsset>;
  playbackClips: ReadonlyMap<string, TimelineClip>;
  selectedId: string;
  /** The clip currently being dragged, so it can be drawn as the thing under
   *  the pointer rather than as one more clip sitting on the lane. */
  draggingId?: string;
  dropActive: boolean;
  dropBlocked: boolean;
  actions: MutableRefObject<TrackActions>;
}) {
  const named = track.name;
  /* A caption track is its own kind (and height), not a video track. */
  const kind = trackKindOf(track);
  return <>
    <div className={`track-head track-head--${kind}`} onContextMenu={(event) => actions.current.laneMenu(event, track)}>
      <b className="track-label" style={{ "--track-kind": CLIP_KINDS[kind].color } as React.CSSProperties}>{label}</b>
      {/* The name is an editable field, not a label: a project with three video
          layers needs the user's own words on them, and an always-live input
          needs no discovery. Blanking it falls back the way a clip name does,
          because the schema has no room for a nameless track. */}
      <input
        className="track-name"
        value={track.name}
        aria-label={`Rename ${named}`}
        {...tooltipProps("Rename track")}
        onChange={(event) => actions.current.rename(track.id, event.target.value || "Untitled track")}
      />
      <button className={track.muted ? "active" : ""} onClick={() => actions.current.toggle(track.id, "muted")} aria-label={`${track.muted ? "Unmute" : "Mute"} audio on ${named}`} aria-pressed={track.muted} {...tooltipProps(track.muted ? "Unmute" : "Mute")}>{track.muted ? <Mute14Filled /> : <Speaker14 />}</button>
      <button className={track.locked ? "active" : ""} onClick={() => actions.current.toggle(track.id, "locked")} aria-label={`${track.locked ? "Unlock" : "Lock"} ${named}`} aria-pressed={track.locked} {...tooltipProps(track.locked ? "Unlock" : "Lock")}>{track.locked ? <Lock14Filled /> : <Unlock14 />}</button>
    </div>
    <div
      className={`track-lane track-lane--${kind}${alt ? " track-lane--alt" : ""}${track.locked ? " track-lane--locked" : ""} ${track.muted ? "muted" : ""} ${dropActive ? "track-lane--drop" : ""} ${dropBlocked ? "track-lane--reject" : ""}`}
      /* Which track this lane IS, readable from the DOM: a clip dragged across
         lanes is hit-tested against the document, and the id is how the answer
         gets back to the model. */
      data-track-id={track.id}
      {...tooltipProps(dropBlocked ? (track.locked ? `${track.name} is locked` : `${track.name} cannot take this item`) : undefined)}
      onDragOver={(event) => actions.current.dragOverLane(event, track)}
      onDragLeave={() => actions.current.dragLeaveLane(track)}
      onDrop={(event) => actions.current.dropLane(event, track)}
      onContextMenu={(event) => { if (event.target === event.currentTarget) actions.current.laneMenu(event, track); }}
    >
      {track.clips.map((clip) => {
        const playbackClip = playbackClips.get(clip.id) ?? clip;
        const asset = assetsById.get(playbackClip.assetId);
        const audioOnly = asset?.kind === "audio";
        const generation = generatedJobsByAssetId.get(playbackClip.assetId);
        /* Current renders record this exactly. Completed files from projects
           saved before that metadata existed use the successful saved output
           as the compatibility signal; an explicit false always wins. */
        const hasAudio = audioOnly || asset?.hasAudio === true || Boolean(
          asset?.kind === "generated"
          && asset.hasAudio == null
          && generation?.outputRelativePath
          && !generation.error?.startsWith("Saved without sound"),
        );
        const isSelected = selectedId === clip.id;
        const clipKind = clipKindOf(asset, track);
        const effects = clipEffectCount(clip);
        /* The colour is the clip's own when it has one, and otherwise its
           kind's (--clip-kind, from the class) — never a blanket video blue. */
        return <div
          key={clip.id}
          className={`clip-slot ${isSelected ? "selected" : ""} ${draggingId === clip.id ? "clip-slot--dragging" : ""}`}
          style={{ left: `${clip.startMs / duration * 100}%`, width: `${clip.durationMs / duration * 100}%`, "--clip-color": clip.color || undefined } as React.CSSProperties}
        >
          {/* The clip is a div with a button's role rather than a <button>: it
              carries two trim handles of its own, and a button inside a button
              is not a thing a browser or a screen reader can make sense of. */}
          <div
            className={`timeline-clip timeline-clip--${clipKind} ${audioOnly ? "timeline-clip--audio-only" : ""} ${hasAudio ? "timeline-clip--has-audio" : ""} ${isSelected ? "selected" : ""} ${track.locked ? "timeline-clip--locked" : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            aria-label={`${clip.label}, ${(clip.durationMs / 1000).toFixed(1)} seconds, on ${track.name}${effects.total === 0 ? "" : effects.on === 0 ? `, ${effects.total} effects all off` : `, ${effects.total} effects`}`}
            onClick={() => actions.current.select(clip.id)}
            onKeyDown={(event) => { if (event.key === "Enter") actions.current.select(clip.id); }}
            onPointerDown={(event) => actions.current.clipPointerDown(event, clip, "move")}
            onContextMenu={(event) => actions.current.clipMenu(event, clip)}
          >
            {/* The title strip: the kind's glyph, the name, and an fx badge
                counting the clip's effects (struck through when every one of
                them is bypassed). */}
            <span className="timeline-clip__strip">
              {CLIP_KINDS[clipKind].glyph}
              <b className="timeline-clip__title">{clip.label}</b>
              {effects.total > 0 && <span
                className={`timeline-clip__fx${effects.on === 0 ? " timeline-clip__fx--off" : ""}`}
                aria-hidden="true"
              >fx {effects.total}</span>}
            </span>
            {!audioOnly && generation && <TimelineClipThumbnails
              folderPath={folderPath}
              job={generation}
              clip={playbackClip}
            />}
            {hasAudio && asset && <TimelineClipWaveform
              folderPath={folderPath}
              asset={asset}
              clip={playbackClip}
              cacheVersion={generation?.updatedAt}
            />}
          </div>
          {/* The two ends, which cut rather than move. They stop the press from
              reaching the clip body, or every trim would also be a move. A
              locked track gets neither: nothing on it can be changed. */}
          {!track.locked && <>
            <span
              className="clip-handle clip-handle--start"
              aria-hidden="true"
              onPointerDown={(event) => { event.stopPropagation(); actions.current.clipPointerDown(event, clip, "trim-start"); }}
            />
            <span
              className="clip-handle clip-handle--end"
              aria-hidden="true"
              onPointerDown={(event) => { event.stopPropagation(); actions.current.clipPointerDown(event, clip, "trim-end"); }}
            />
          </>}
        </div>;
      })}
    </div>
  </>;
});
