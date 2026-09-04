import { Film, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipFrameStyle, clipVisualSettings, visibleClipAt } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import type { ClipTransform, ProjectAsset, ProjectConfig, TimelineClip } from "../../lib/project";
import { clipEndMs } from "../../lib/timeline";
import { PreviewSources } from "../../lib/exportPipeline";

/* The picture, played back.
 *
 * PolStudio has no player of its own and does not need one: the webview owns a
 * hardware decoder, and a <video> pointed at the right file at the right offset
 * IS the shot. What this component adds is the part a media element cannot do —
 * being a TIMELINE rather than a file:
 *
 *  * The clip under the playhead decides what is on screen, and crossing a cut
 *    re-points the same element at the next file.
 *  * Timeline time and source time are different numbers. A clip trimmed to
 *    start 8s into a rush shows second 8 of the file at second 0 of the cut.
 *  * Sound from every audiovisual track plays alongside, each additional clip in its own element,
 *    corrected back into step whenever it drifts.
 *
 * While playing, a monotonic animation clock advances the playhead and the
 * media element plays alongside it. Explicit jumps and cuts seek the decoder;
 * the same clock also carries playback through gaps and still images.
 *
 * The whole file is read into a blob, as everywhere else in PolStudio (see
 * MediaThumbnail): the project's media lives outside the webview's reach and
 * comes back through Tauri. Blobs are cached per asset for the life of the
 * view, so scrubbing back and forth across a cut re-reads nothing. */

/** How far a sound may drift from the cut before it is pulled back. Below this
 *  a correction is more audible than the drift it fixes. */
const AUDIO_DRIFT_LIMIT_S = 0.25;
/** Seeks below this are not worth the stutter — a paused element is already
 *  showing that frame. Roughly one frame at 30fps. */
const SEEK_EPSILON_S = 0.033;
const isImage = (asset: ProjectAsset) => asset.mimeType.startsWith("image/") || asset.kind === "image";
const carriesAudio = (asset: ProjectAsset | undefined) => Boolean(
  asset && (asset.kind === "audio" || ((asset.kind === "video" || asset.kind === "generated") && asset.hasAudio === true)),
);

/** Where inside the FILE this moment of the timeline lives. */
const sourceTimeMs = (clip: TimelineClip, timelineMs: number) => clip.sourceStartMs + (timelineMs - clip.startMs);

const describe = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** Set an element's play position without fighting a seek already in flight.
 *  A scrub fires dozens of these a second; a media element that is asked to
 *  seek while seeking drops requests, so the latest target is remembered and
 *  applied when the current one lands. */
function seekTo(element: HTMLMediaElement, seconds: number, pending: { current: number | null }) {
  if (!Number.isFinite(seconds)) return;
  const target = Math.max(0, seconds);
  if (element.readyState === 0) {
    pending.current = target;
    return;
  }
  if (element.seeking) {
    pending.current = target;
    return;
  }
  if (Math.abs(element.currentTime - target) < SEEK_EPSILON_S) return;
  element.currentTime = target;
}

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
  const clip = useMemo(() => visibleClipAt(tracks, playheadMs, assetsById), [tracks, playheadMs, assetsById]);
  const asset = useMemo(
    () => (clip ? config.assets.find((candidate) => candidate.id === clip.assetId) : undefined),
    [clip, config.assets],
  );
  const frameStyle = useMemo(
    () => clip ? clipFrameStyle(clipVisualSettings(clip), playheadMs - clip.startMs) : null,
    [clip, playheadMs],
  );
  const mediaStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!frameStyle) return undefined;
    const { transform, look, opacity, revealStart, revealEnd } = frameStyle;
    const warmth = look.temperature / 100;
    const filter = warmth === 0
      ? "none"
      : `sepia(${Math.abs(warmth) * 0.22}) saturate(${1 + Math.abs(warmth) * 0.3}) hue-rotate(${warmth > 0 ? -8 : 172}deg)`;
    return {
      transform: `translate(${transform.positionX}%, ${transform.positionY}%) scale(${transform.scale / 100}) rotate(${transform.rotation}deg)`,
      opacity,
      filter,
      clipPath: `inset(0 ${(1 - revealEnd) * 100}% 0 ${revealStart * 100}%)`,
    };
  }, [frameStyle]);
  /* Sound that should be audible at this moment: audio-only files and embedded
     sound from every active video, minus muted tracks. The visible video plays
     its own stream, so a second audio element is only needed for the rest. */
  const audioClips = useMemo(() => tracks
    .filter((track) => !track.muted)
    .flatMap((track) => track.clips)
    .filter((candidate) => playheadMs >= candidate.startMs && playheadMs < clipEndMs(candidate))
    .filter((candidate) => candidate.id !== clip?.id && carriesAudio(assetsById.get(candidate.assetId))),
    [tracks, playheadMs, clip?.id, assetsById]);
  const videoTrackMuted = useMemo(
    () => tracks.find((track) => track.id === clip?.trackId)?.muted ?? false,
    [tracks, clip],
  );

  /** Where the picture ends. Playback stops there rather than running the clock
   *  over a timeline that has nothing left on it. */
  const contentEndMs = useMemo(
    () => tracks.reduce((end, track) => track.clips.reduce((furthest, item) => Math.max(furthest, clipEndMs(item)), end), 0),
    [tracks],
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const pictureRef = useRef<HTMLDivElement>(null);
  const transformGesture = useRef<TransformGesture | null>(null);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const pendingVideoSeek = useRef<number | null>(null);
  /* The last playhead value THIS component produced. Anything else arriving in
     the prop came from outside — the ruler, the scroll wheel, a scene card —
     and has to be seeked to even mid-playback. Without this the monitor cannot
     tell its own echo from a scrub. */
  const advancedTo = useRef<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
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
     PolStudio that shows footage does the same (MediaThumbnail, the export
     preview) because project media lives outside the webview and arrives
     through Tauri as bytes. The cleanup revokes every URL handed out, so
     leaving the timeline — or opening another project — gives all of it back. */
  const sources = useMemo(() => new PreviewSources(folderPath), [folderPath]);
  useEffect(() => () => sources.dispose(), [sources]);

  /* The playhead as of this render, readable from inside the animation frame
     without making the clock restart every time it ticks. */
  const positionRef = useRef(playheadMs);
  positionRef.current = playheadMs;

  const report = useCallback((ms: number) => {
    const rounded = Math.round(ms);
    /* Keep the local clock advancing even when React batches visual updates
       while pointer and hover events are busy. */
    positionRef.current = rounded;
    advancedTo.current = rounded;
    onSeek(rounded);
  }, [onSeek]);

  // The picture's file. Nothing is read for a clip the playhead is not inside.
  useEffect(() => {
    if (!asset || (!asset.relativePath && !asset.sourcePath)) {
      setUrl(null);
      setReady(false);
      setError(null);
      return;
    }
    let live = true;
    setError(null);
    setReady(false);
    void sources.url(asset).then(
      (value) => { if (live) setUrl(value); },
      (reason) => { if (live) { setUrl(null); setError(describe(reason)); } },
    );
    return () => { live = false; };
  }, [asset, sources]);

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

  /* Scrubbing, every other jump, and the first frame of every new shot.
     While playing this deliberately does nothing for the playhead's own
     advance — seeking the element to every animation tick would stutter. It
     does have to fire on the two other cases:
     a playhead that moved for some other reason (the ruler, the wheel, a scene
     card), and a CUT. Crossing a cut re-points the element at another file, or
     at another moment of the same file, and neither knows where in the footage
     this clip begins until it is told. */
  const playingClipId = useRef<string | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || !url) return;
    const crossedACut = playingClipId.current !== clip.id;
    playingClipId.current = clip.id;
    const external = advancedTo.current === null || Math.abs(advancedTo.current - playheadMs) > 1;
    if (playing && !external && !crossedACut) return;
    seekTo(video, sourceTimeMs(clip, playheadMs) / 1000, pendingVideoSeek);
  }, [playheadMs, playing, clip, url]);

  // A seek that lands while another was queued: apply the newest target.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const flush = () => {
      const target = pendingVideoSeek.current;
      if (target === null) return;
      pendingVideoSeek.current = null;
      seekTo(video, target, pendingVideoSeek);
    };
    video.addEventListener("seeked", flush);
    video.addEventListener("loadeddata", flush);
    return () => {
      video.removeEventListener("seeked", flush);
      video.removeEventListener("loadeddata", flush);
    };
  }, [url]);

  /* Play and pause the picture. A media element that is asked to play before it
     has data rejects, which is a promise nobody was awaiting — caught here so a
     slow file does not throw into the console on every press. */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && url) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing, url, clip?.id]);

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
        onPlayingChange(false);
        return;
      }
      /* Past the end of THIS clip while its file still has footage left: the
         cut is what ends the shot, not the file. Stepping just past the tail
         hands the next clip — or the gap after it — to the next render. */
      if (clip && next >= clipEndMs(clip)) report(clipEndMs(clip));
      else report(next);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, clip, url, contentEndMs, report, onPlayingChange]);

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
  } else if (error) {
    overlay = <div className="program-note program-note--error" role="alert"><TriangleAlert size={22} /><span>{clip.label} could not be played: {error}</span></div>;
  } else if (!url || (!ready && asset && !isImage(asset))) {
    overlay = <div className="program-note"><span>Loading {clip.label}…</span></div>;
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
    {/* One element, re-pointed at whatever the playhead is over. Rebuilding it
        per clip would drop the decoder and re-open the file on every cut. */}
    {asset && !isImage(asset) && url && <video
      ref={videoRef}
      src={url}
      style={mediaStyle}
      muted={videoTrackMuted}
      playsInline
      preload="auto"
      onLoadedData={() => setReady(true)}
      onError={() => setError("This file could not be decoded.")}
    />}
    {asset && isImage(asset) && url && <img src={url} alt={clip?.label ?? ""} style={mediaStyle} />}
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
