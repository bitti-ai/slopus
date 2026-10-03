import { Pause14, Play14 } from "../ui/icons";
import { useEffect, useRef, useState } from "react";
import { PropRow } from "../ui";
import { readMediaFileUrl } from "../../lib/persistence";
import type { ProjectReference } from "../../lib/project";
import { editReferenceVideoTrim, normalizeReferenceVideoTrim, referenceTime, MAX_REFERENCE_SECONDS, MIN_REFERENCE_SECONDS, type TrimAction } from "../../lib/referenceVideoTrim";
import { CommittedNumberInput } from "./CommittedNumberInput";

type AudioOptions = NonNullable<ProjectReference["audio"]>;

const AUDIO_TYPES: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", oga: "audio/ogg",
};
const audioType = (path: string | null | undefined) => AUDIO_TYPES[path?.split(".").pop()?.toLowerCase() ?? ""] ?? "audio/mpeg";

/** The part of a sound file sent as a reference: 2 to 15 seconds of it. */
export function ReferenceAudio({ folderPath, reference, onChange }: { folderPath: string; reference: ProjectReference; onChange: (audio: AudioOptions) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const location = reference.sourcePath ?? reference.relativePath;
  useEffect(() => {
    let disposed = false;
    let owned: string | null = null;
    setUrl(null); setError(null); setSourceDuration(null); setPreviewing(false);
    void readMediaFileUrl(folderPath, reference, audioType(location)).then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
      if (!value) setError("The sound file is unavailable.");
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, reference.id, location]);

  const usable = sourceDuration !== null && sourceDuration >= MIN_REFERENCE_SECONDS;
  const trim = usable ? normalizeReferenceVideoTrim(reference.audio ?? { startSeconds: 0, durationSeconds: MAX_REFERENCE_SECONDS }, sourceDuration) : null;
  const start = trim?.startSeconds ?? reference.audio?.startSeconds ?? 0;
  const length = trim?.durationSeconds ?? reference.audio?.durationSeconds ?? MAX_REFERENCE_SECONDS;
  const change = (action: TrimAction, value: number) => {
    if (!trim || sourceDuration === null) return;
    const next = editReferenceVideoTrim(trim, sourceDuration, action, value);
    onChange({ startSeconds: next.startSeconds, durationSeconds: next.durationSeconds });
  };
  const stop = () => { audio.current?.pause(); setPreviewing(false); };
  const playSelection = async () => {
    const element = audio.current;
    if (!element || !trim) return;
    if (previewing) { stop(); return; }
    element.currentTime = start;
    setPreviewing(true);
    try { await element.play(); }
    catch (reason) { stop(); setError(`Could not play the selection: ${String(reason)}`); }
  };

  return <div className="reference-audio">
    {url && <audio ref={audio} src={url} controls preload="metadata" aria-label={`${reference.name} preview`}
      onLoadedMetadata={(event) => {
        const duration = event.currentTarget.duration;
        setSourceDuration(Number.isFinite(duration) ? duration : null);
        if (Number.isFinite(duration) && duration < MIN_REFERENCE_SECONDS) setError("Sound references must be at least 2 seconds long.");
      }}
      onTimeUpdate={(event) => { if (previewing && event.currentTarget.currentTime >= start + length) stop(); }}
      onPause={() => setPreviewing(false)}
      onError={() => setError("This sound file cannot be played in Slopus.")} />}
    <div className="reference-trim__summary"><strong>{referenceTime(start)} – {referenceTime(start + length)}</strong><span>{Number(length.toFixed(2))} s selected</span></div>
    <PropRow label="Start" htmlFor={`${reference.id}-audio-start`}>
      <CommittedNumberInput id={`${reference.id}-audio-start`} className="text-field" aria-label="Sound start in seconds" step={0.1} disabled={!trim}
        value={Number(start.toFixed(2))} minimum={0} maximum={Math.max(0, (sourceDuration ?? 0) - MIN_REFERENCE_SECONDS)} onCommit={(value) => change("move", value)} />
    </PropRow>
    <PropRow label="Length" htmlFor={`${reference.id}-audio-length`}>
      <CommittedNumberInput id={`${reference.id}-audio-length`} className="text-field" aria-label="Sound length in seconds" step={0.1} disabled={!trim}
        value={Number(length.toFixed(2))} minimum={MIN_REFERENCE_SECONDS} maximum={MAX_REFERENCE_SECONDS} onCommit={(value) => change("duration", value)} />
    </PropRow>
    <button type="button" className="secondary-button" disabled={!trim} onClick={() => void playSelection()}>
      {previewing ? <><Pause14 aria-hidden="true" /> Stop</> : <><Play14 aria-hidden="true" /> Play selection</>}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
