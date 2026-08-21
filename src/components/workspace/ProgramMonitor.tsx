import { Film, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { visibleClipAt } from "../../lib/export";
import { isTauri } from "../../lib/persistence";
import type { ProjectAsset, ProjectConfig, TimelineClip } from "../../lib/project";
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
 *  * Sound on the audio tracks plays alongside, each clip in its own element,
 *    corrected back into step whenever it drifts.
 *
 * While playing, the VIDEO element is the clock: the playhead is derived from
 * where the decoder actually is, not from a timer running beside it, so the
 * picture and the playhead cannot disagree. Over a gap — or with nothing
 * readable — a wall clock takes over, because a black stretch still has to
 * play through.
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
/** How far outside a clip's own stretch of its file the decoder may read and
 *  still be believed. A frame or two of slack, so ordinary rounding at a cut
 *  does not hand the clock to the wall. */
const CUT_SLACK_MS = 120;

const isImage = (asset: ProjectAsset) => asset.mimeType.startsWith("image/") || asset.kind === "image";

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

export function ProgramMonitor({ config, folderPath, playheadMs, playing, onSeek, onPlayingChange }: {
  config: ProjectConfig;
  folderPath: string;
  playheadMs: number;
  playing: boolean;
  /** Where playback has reached. The view owns the playhead; this only ever
   *  reports where the decoder actually is. */
  onSeek: (ms: number) => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const tracks = config.timeline.tracks;
  const clip = useMemo(() => visibleClipAt(tracks, playheadMs), [tracks, playheadMs]);
  const asset = useMemo(
    () => (clip ? config.assets.find((candidate) => candidate.id === clip.assetId) : undefined),
    [clip, config.assets],
  );
  /* Sound that should be audible at this moment: every audio clip the playhead
     is inside, minus the tracks the user has muted. A muted track is dropped
     here rather than played silently, so nothing is decoded for it at all. */
  const audioClips = useMemo(() => tracks
    .filter((track) => track.kind === "audio" && !track.muted)
    .flatMap((track) => track.clips)
    .filter((candidate) => playheadMs >= candidate.startMs && playheadMs < clipEndMs(candidate)),
    [tracks, playheadMs]);
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
    advancedTo.current = rounded;
    onSeek(rounded);
  }, [onSeek]);

  // The picture's file. Nothing is read for a clip the playhead is not inside.
  useEffect(() => {
    if (!asset) {
      setUrl(null);
      setReady(false);
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
     advance — the element is the clock then, and seeking it to its own reading
     would stutter every frame. It does have to fire on the two other cases:
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

  /* The clock. One frame at a time: read where the decoder is, turn that back
     into a position on the ruler, and hand it up. With no picture to read —
     a gap, an unreadable file, a still image — the wall clock stands in, so a
     black stretch still plays through at the right speed. */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastTick = performance.now();
    const step = () => {
      const now = performance.now();
      const elapsed = now - lastTick;
      lastTick = now;
      const video = videoRef.current;
      /* The decoder is only the clock while it is actually inside THIS clip's
         stretch of the file. Just after a cut it is not: the element has been
         re-pointed and its currentTime still reads 0 (or the last shot's
         position) until the seek lands. Believing it there would put the
         playhead before the clip that is on screen, which hands the render back
         to the previous clip and bounces between the two. The wall clock covers
         those few frames instead. */
      const sourceNowMs = video ? video.currentTime * 1000 : 0;
      const insideThisClip = clip !== null
        && sourceNowMs >= clip.sourceStartMs - CUT_SLACK_MS
        && sourceNowMs <= clip.sourceStartMs + clip.durationMs + CUT_SLACK_MS;
      const decoded = clip && video && url && !video.paused && !video.seeking && Number.isFinite(video.currentTime) && insideThisClip
        ? clip.startMs + (sourceNowMs - clip.sourceStartMs)
        : null;
      const next = decoded ?? positionRef.current + elapsed;
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

  /* What the monitor can say, in the order the user needs it: nothing cut yet,
     nothing under the playhead, no way to read the file, or the picture. */
  let overlay: React.ReactNode = null;
  if (!hasClips) overlay = null;
  else if (!clip) overlay = <div className="program-note"><Film size={22} /><span>Nothing under the playhead here.</span></div>;
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
  return <div className="program-picture" style={{ backgroundColor: config.settings.backgroundColor }}>
    {/* One element, re-pointed at whatever the playhead is over. Rebuilding it
        per clip would drop the decoder and re-open the file on every cut. */}
    {asset && !isImage(asset) && url && <video
      ref={videoRef}
      src={url}
      muted={videoTrackMuted}
      playsInline
      preload="auto"
      onLoadedData={() => setReady(true)}
      onError={() => setError("This file could not be decoded.")}
    />}
    {asset && isImage(asset) && url && <img src={url} alt={clip?.label ?? ""} />}
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
