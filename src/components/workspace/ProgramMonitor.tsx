import { ProgramLayer } from "./ProgramLayer";
import { Film } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipFrameStyle, clipVisualSettings } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import type { ClipTransform, ProjectAsset, ProjectConfig, TimelineClip } from "../../lib/project";
import { clipEndMs } from "../../lib/timeline";
import { PreviewSources } from "../../lib/exportPipeline";
import { preparedPreviewClips, previewSegmentIndex, previewSegments } from "../../lib/timelinePreview";

/* The monitor owns a continuous timeline clock. Each visible or upcoming clip
 * owns a persistent media element: loading, decoding the first frame and seeking
 * a trim happen ahead of a cut. Promoting a prepared layer preserves its decoder
 * and effect renderer, including when a lower track becomes the foreground. */

/** How far a sound may drift from the cut before it is pulled back. Below this
 *  a correction is more audible than the drift it fixes. */
const AUDIO_DRIFT_LIMIT_S = 0.25;
/** Seeks below this are not worth the stutter — a paused element is already
 *  showing that frame. Roughly one frame at 30fps. */
const SEEK_EPSILON_S = 0.033;
const carriesAudio = (asset: ProjectAsset | undefined) => Boolean(
  asset && (asset.kind === "audio" || ((asset.kind === "video" || asset.kind === "generated") && asset.hasAudio === true)),
);

/** Where inside the FILE this moment of the timeline lives. */
const sourceTimeMs = (clip: TimelineClip, timelineMs: number) => clip.sourceStartMs + (timelineMs - clip.startMs);

type TransformGesture = {
  kind: "move" | "scale" | "rotate";
  pointerId: number;
  startX: number;
  startY: number;
  centerX: number;
  centerY: number;
  startDistance: number;
  startAngle: number;
  initial: ClipTransform;
  frameWidth: number;
  frameHeight: number;
  captureTarget: HTMLElement;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const angleAt = (x: number, y: number, centerX: number, centerY: number) => Math.atan2(y - centerY, x - centerX) * 180 / Math.PI;
const normalizedAngle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;

export function ProgramMonitor({ config, folderPath, playheadMs, playing, onSeek, onPlayingChange, selectedClipId = null, transformEditingDisabled = false, onSelectClip, onTransformChange }: {
  config: ProjectConfig;
  folderPath: string;
  playheadMs: number;
  playing: boolean;
  /** Where playback has reached. The view owns the playhead; this reports the
   *  monitor's monotonic playback clock. */
  onSeek: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
  /** Timeline-only direct manipulation. Export omits these props and therefore
   *  never renders editor chrome into its preview. */
  selectedClipId?: string | null;
  transformEditingDisabled?: boolean;
  onSelectClip?: (clipId: string) => void;
  onTransformChange?: (clipId: string, transform: ClipTransform) => void;
}) {
  const tracks = config.timeline.tracks;
  const assetsById = useMemo(() => new Map(config.assets.map((candidate) => [candidate.id, candidate])), [config.assets]);
  const segments = useMemo(() => previewSegments(tracks, assetsById), [tracks, assetsById]);
  const segmentIndex = previewSegmentIndex(segments, playheadMs);
  const layers = segments[segmentIndex].clips;
  const prepared = useMemo(() => preparedPreviewClips(segments, segmentIndex), [segments, segmentIndex]);
  const clip = layers[0] ?? null;
  const asset = useMemo(
    () => (clip ? config.assets.find((candidate) => candidate.id === clip.assetId) : undefined),
    [clip, config.assets],
  );
  const frameStyle = useMemo(
    () => clip ? clipFrameStyle(clipVisualSettings(clip), playheadMs - clip.startMs) : null,
    [clip, playheadMs],
  );
  /* Sound that should be audible at this moment: audio-only files and embedded
     sound from every active video, minus muted tracks. The visible video plays
     its own stream, so a second audio element is only needed for the rest. */
  const audioClips = useMemo(() => tracks
    .filter((track) => !track.muted)
    .flatMap((track) => track.clips)
    .filter((candidate) => playheadMs >= candidate.startMs && playheadMs < clipEndMs(candidate))
    .filter((candidate) => candidate.id !== clip?.id && carriesAudio(assetsById.get(candidate.assetId))),
    [tracks, playheadMs, clip?.id, assetsById]);
  /** Where the picture ends. Playback stops there rather than running the clock
   *  over a timeline that has nothing left on it. */
  const contentEndMs = useMemo(
    () => tracks.reduce((end, track) => track.clips.reduce((furthest, item) => Math.max(furthest, clipEndMs(item)), end), 0),
    [tracks],
  );

  const pictureRef = useRef<HTMLDivElement>(null);
  const transformGesture = useRef<TransformGesture | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  /* The last playhead value THIS component produced. Anything else arriving in
     the prop came from outside — the ruler, the scroll wheel, a scene card —
     and has to be seeked to even mid-playback. Without this the monitor cannot
     tell its own echo from a scrub. */
  const advancedTo = useRef<number | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const selectionFromPicture = useRef<string | null>(null);

  /* A timeline selection identifies what the inspector edits, but does not put
     handles over the picture. Only a click on the video opts into direct
     manipulation; a later selection elsewhere dismisses it. */
  useEffect(() => {
    if (selectionFromPicture.current === selectedClipId) {
      selectionFromPicture.current = null;
      return;
    }
    selectionFromPicture.current = null;
    setEditingClipId(null);
  }, [selectedClipId]);
  useEffect(() => setEditingClipId(null), [clip?.id]);

  /* One blob per asset, held for the life of this view so that scrubbing back
     and forth across a cut re-reads nothing. The cost is real and worth stating:
     a blob is the WHOLE file, so a timeline built from four 300 MB rushes holds
     1.2 GB once all four have been under the playhead. Everything else in
     Slopus that shows footage does the same (MediaThumbnail, the export
     preview) because project media lives outside the webview and arrives
     through Tauri as bytes. The cleanup revokes every URL handed out, so
     leaving the timeline — or opening another project — gives all of it back. */
  const sources = useMemo(() => new PreviewSources(folderPath), [folderPath]);
  useEffect(() => () => sources.dispose(), [sources]);

  /* The playhead as of this render, readable from inside the animation frame
     without making the clock restart every time it ticks. */
  const positionRef = useRef(playheadMs);
  const externalSeek = advancedTo.current === null || Math.abs(advancedTo.current - playheadMs) > 1;
  if (externalSeek) positionRef.current = playheadMs;

  const callbacks = useRef({ onSeek, onPlayingChange });
  callbacks.current = { onSeek, onPlayingChange };
  const report = useCallback((ms: number) => {
    const rounded = Math.round(ms);
    /* Keep the local clock advancing even when React batches visual updates
       while pointer and hover events are busy. */
    // Keep fractional milliseconds internally; rounding every display tick
    // otherwise speeds the clock up and eventually forces corrective seeks.
    positionRef.current = ms;
    advancedTo.current = rounded;
    callbacks.current.onSeek(rounded);
  }, []);

  // The sound files. Each audio clip under the playhead gets its own element,
  // so two tracks can be heard at once rather than one winning.
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    for (const audioClip of audioClips) {
      const audioAsset = config.assets.find((candidate) => candidate.id === audioClip.assetId);
      // This effect re-runs on every frame of playback (the set of audible
      // clips is recomputed from the playhead), so the guard is what keeps one
      // sound from being asked for sixty times a second while it loads.
      if (!audioAsset || askedFor.current.has(audioAsset.id)) continue;
      askedFor.current.add(audioAsset.id);
      void sources.url(audioAsset).then(
        (value) => setAudioUrls((current) => ({ ...current, [audioAsset.id]: value })),
        // A sound that cannot be read is not worth blanking the picture over;
        // the monitor says so only when the PICTURE fails.
        () => undefined,
      );
    }
  }, [audioClips, config.assets, sources]);

  /* The clock advances one animation frame at a time. It deliberately does
     not rely on the media element's coarser currentTime update cadence. */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastTick = performance.now();
    const step = () => {
      const now = performance.now();
      const elapsed = now - lastTick;
      lastTick = now;
      /* Media currentTime can be exposed in coarse jumps while Chromium is
         handling pointer/hover work. A monotonic local clock keeps the ruler
         smooth; media is still sought at cuts and explicit user jumps. */
      const next = positionRef.current + elapsed;
      // Past the end of everything there is nothing left to show, so playback
      // stops there instead of running the clock over an empty ruler.
      if (next >= contentEndMs) {
        report(contentEndMs);
        callbacks.current.onPlayingChange(false);
        return;
      }
      // Preserve elapsed time across cuts; neither media loads nor React
      // commits restart the clock or discard the fraction past a boundary.
      report(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, contentEndMs, report]);

  /* Sound, kept in step with the cut. Each element is put where the playhead
     says it should be, and corrected only once it has drifted audibly — a
     correction on every frame would be a stutter rather than a soundtrack. */
  useEffect(() => {
    for (const audioClip of audioClips) {
      const element = audioRefs.current.get(audioClip.id);
      if (!element || element.readyState === 0) continue;
      const target = sourceTimeMs(audioClip, playheadMs) / 1000;
      if (Math.abs(element.currentTime - target) > (playing ? AUDIO_DRIFT_LIMIT_S : SEEK_EPSILON_S)) {
        element.currentTime = Math.max(0, target);
      }
      if (playing) void element.play().catch(() => undefined);
      else element.pause();
    }
  }, [audioClips, playheadMs, playing]);

  const hasClips = tracks.some((track) => track.clips.length > 0);

  const beginTransform = (kind: TransformGesture["kind"], event: React.PointerEvent<HTMLElement>) => {
    if (!clip || !frameStyle || transformEditingDisabled || !onTransformChange) return;
    const bounds = pictureRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onPlayingChange(false);
    const initial = frameStyle.transform;
    const centerX = bounds.left + bounds.width / 2 + bounds.width * initial.positionX / 100;
    const centerY = bounds.top + bounds.height / 2 + bounds.height * initial.positionY / 100;
    transformGesture.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centerX,
      centerY,
      startDistance: Math.max(1, Math.hypot(event.clientX - centerX, event.clientY - centerY)),
      startAngle: angleAt(event.clientX, event.clientY, centerX, centerY),
      initial,
      frameWidth: bounds.width,
      frameHeight: bounds.height,
      captureTarget: event.currentTarget,
    };
  };

  const moveTransform = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = transformGesture.current;
    if (!gesture || !clip || !onTransformChange || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    let next = gesture.initial;
    if (gesture.kind === "move") {
      next = {
        ...next,
        positionX: clamp(gesture.initial.positionX + (event.clientX - gesture.startX) / gesture.frameWidth * 100, -100, 100),
        positionY: clamp(gesture.initial.positionY + (event.clientY - gesture.startY) / gesture.frameHeight * 100, -100, 100),
      };
    } else if (gesture.kind === "scale") {
      const distance = Math.hypot(event.clientX - gesture.centerX, event.clientY - gesture.centerY);
      next = { ...next, scale: clamp(gesture.initial.scale * distance / gesture.startDistance, 10, 400) };
    } else {
      const delta = angleAt(event.clientX, event.clientY, gesture.centerX, gesture.centerY) - gesture.startAngle;
      next = { ...next, rotation: normalizedAngle(gesture.initial.rotation + delta) };
    }
    onTransformChange(clip.id, next);
  };

  const endTransform = (event: React.PointerEvent<HTMLElement>) => {
    const gesture = transformGesture.current;
    if (gesture?.pointerId !== event.pointerId) return;
    transformGesture.current = null;
    if (gesture.captureTarget.hasPointerCapture?.(event.pointerId)) gesture.captureTarget.releasePointerCapture(event.pointerId);
  };

  /* What the monitor can say, in the order the user needs it: no way to read
     the file, or the file still being read. A GAP says nothing at all — the
     empty frame in the project's own background colour is exactly what the
     export writes there, and a panel over it only hid the answer. */
  let overlay: React.ReactNode = null;
  if (!hasClips || !clip) overlay = null;
  else if (asset?.kind === "generated" && !asset.relativePath && !asset.sourcePath) {
    overlay = <div className="program-note"><Film size={22} /><span>Generate {clip.label} to preview it. Its place on the timeline is already saved.</span></div>;
  }
  else if (!isTauri()) {
    overlay = <div className="program-note"><Film size={22} /><span>Playback needs the desktop app — the browser preview has no project folder to read the footage from.</span></div>;
  }

  /* The frame is fitted inside the panel and the rest is the project's own
     background colour — the same letterboxing, against the same colour, that
     the export writes into the file. Nothing is cropped to fill the panel: a
     9:16 cut has to LOOK 9:16 while it is being cut. */
  return <div
    ref={pictureRef}
    className={`program-picture${onSelectClip && clip ? " program-picture--selectable" : ""}`}
    style={{ backgroundColor: config.settings.backgroundColor }}
    onClick={() => {
      if (!clip || !onSelectClip) return;
      selectionFromPicture.current = clip.id;
      setEditingClipId(clip.id);
      onSelectClip(clip.id);
    }}
  >
    <div className="program-media">{prepared.map(({ clip: layer, prepareAtMs }) => {
      const depth = layers.findIndex((visible) => visible.id === layer.id);
      return <ProgramLayer
        key={`${folderPath}:${layer.id}`}
        clip={layer}
        asset={assetsById.get(layer.assetId)}
        sources={sources}
        playheadMs={depth >= 0 ? playheadMs : prepareAtMs}
        playing={playing}
        active={depth >= 0}
        foreground={depth === 0}
        muted={depth !== 0 || (tracks.find((track) => track.id === layer.trackId)?.muted ?? false)}
        externalSeek={externalSeek}
        depth={depth >= 0 ? layers.length - depth : 0}
      />;
    })}</div>
    {clip && frameStyle && editingClipId === clip.id && onTransformChange && !transformEditingDisabled && <div
      className="program-transform"
      style={{ transform: `translate(${frameStyle.transform.positionX}%, ${frameStyle.transform.positionY}%) scale(${frameStyle.transform.scale / 100}) rotate(${frameStyle.transform.rotation}deg)` }}
      role="group"
      aria-label={`Transform ${clip.label}`}
      onPointerDown={(event) => beginTransform("move", event)}
      onPointerMove={moveTransform}
      onPointerUp={endTransform}
      onPointerCancel={endTransform}
    >
      <button className="program-transform__rotate" type="button" aria-label="Rotate clip" title="Drag to rotate" onPointerDown={(event) => beginTransform("rotate", event)} />
      <button className="program-transform__scale" type="button" aria-label="Scale clip" title="Drag to scale" onPointerDown={(event) => beginTransform("scale", event)} />
      <span className="sr-only">Drag inside the frame to move the clip.</span>
    </div>}
    {audioClips.map((audioClip) => {
      const audioUrl = audioUrls[audioClip.assetId];
      return audioUrl
        ? <audio
          key={audioClip.id}
          ref={(element) => { if (element) audioRefs.current.set(audioClip.id, element); else audioRefs.current.delete(audioClip.id); }}
          src={audioUrl}
          preload="auto"
        />
        : null;
    })}
    {overlay}
  </div>;
}
