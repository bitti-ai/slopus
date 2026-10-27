import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { ProjectConfig } from "../../lib/project";
import { isTauri, readMediaFileUrl } from "../../lib/persistence";
import { MUSIC_EXPORT_BITRATES, MUSIC_EXPORT_FORMATS, musicExportSongs, musicExportSupport, type MusicExportFormat, type MusicExportSettings } from "../../lib/musicExport";
import { cancelExportJob, dismissExportOutcome, exportFraction, isExportActive, startMusicExportJob, useExportJob } from "../../lib/exportJob";
import { ComboBox, EmptyState, InfoBar, ProgressBar, PropRow, PropSection, Splitter, usePaneSize } from "../ui";
import { Audio16 } from "../ui/icons";

const STORAGE_KEY = "slopus.music-export.v1";
function loadPreferences(): MusicExportSettings {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return { format: MUSIC_EXPORT_FORMATS.some((item) => item.value === value.format) ? value.format : "wav",
      bitrate: MUSIC_EXPORT_BITRATES.some((item) => Number(item.value) === value.bitrate) ? value.bitrate : 192000 };
  } catch { return { format: "wav", bitrate: 192000 }; }
}

export function MusicExportView({ config, folderPath }: { config: ProjectConfig; folderPath: string }) {
  const pane = usePaneSize("export.settings", 340, { min: 280, max: 560 });
  const songs = musicExportSongs(config);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = songs.find(({ song }) => song.id === selectedId) ?? songs[0];
  const [settings, setSettings] = useState(loadPreferences);
  const [support, setSupport] = useState<Partial<Record<MusicExportFormat, boolean>>>({});
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const job = useExportJob(folderPath, "music");
  const active = isExportActive(job);
  const choose = (patch: Partial<MusicExportSettings>) => {
    const next = { ...settings, ...patch }; setSettings(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* Keep the session preference. */ }
  };
  useEffect(() => {
    let disposed = false; setSupport({});
    void Promise.all(MUSIC_EXPORT_FORMATS.map(async ({ value }) => [value, await musicExportSupport(value, settings.bitrate)] as const))
      .then((entries) => { if (!disposed) setSupport(Object.fromEntries(entries)); });
    return () => { disposed = true; };
  }, [settings.bitrate]);
  useEffect(() => {
    let disposed = false, owned: string | null = null;
    const player = audio.current;
    player?.pause(); setUrl(null); setError(null);
    if (selected) void readMediaFileUrl(folderPath, selected.asset, selected.asset.mimeType ?? "audio/wav").then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
      if (!value) setError("This song's audio file is unavailable.");
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; player?.pause(); if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, selected?.asset.id, selected?.asset.relativePath]);
  const blocker = !selected ? "Generate a song in Music before exporting."
    : !isTauri() ? "Exporting is available in the Slopus desktop app."
      : support[settings.format] === undefined ? "Checking available audio formats…"
        : !support[settings.format] ? "This format is unavailable on this device. Choose another format." : null;
  const exportSong = async () => {
    if (!selected || blocker || choosing) return;
    setChoosing(true); setError(null);
    const captured = { folderPath, projectName: config.name, asset: structuredClone(selected.asset), title: selected.song.title, settings: { ...settings } };
    try {
      const destination = await invoke<string | null>("choose_music_export_destination", { suggestedName: captured.title, format: captured.settings.format });
      if (destination) void startMusicExportJob({ ...captured, destination });
    } catch (reason) { setError(String(reason)); }
    finally { setChoosing(false); }
  };

  return <div className="export-view" style={pane.style}>
    <h1 className="sr-only">Export music</h1>
    <div className="export-body">
      <section className="export-preview" aria-label="Music export preview">
        <div className="music-export-library">
          {songs.length ? <div className="music-songs music-songs--list" role="list" aria-label="Songs to export">
            {songs.map(({ song, asset, label }) => <div role="listitem" key={song.id} className={`music-song music-song--playable${selected?.song.id === song.id ? " music-song--selected" : ""}`}>
              <button type="button" className="music-song__select" aria-label={`Export song ${label}`} aria-pressed={selected?.song.id === song.id} onClick={() => setSelectedId(song.id)}>
                <span className="music-song__art" aria-hidden="true"><Audio16 /></span>
                <span className="music-song__info"><strong>{label}</strong><span>{song.style}</span></span>
                <span className="music-song__status">{((asset.durationMs ?? 0) / 1000).toFixed(1)} s</span>
              </button>
            </div>)}
          </div> : <EmptyState icon={<Audio16 />} title="No music to export yet" description="Generate a song in the Music tab first." />}
        </div>
        {selected && <div className="music-export-player"><span>{selected.song.title}</span><audio ref={audio} aria-label="Music export playback" controls src={url ?? undefined} preload="metadata" onError={() => { if (url) setError("This song could not be played."); }} /></div>}
      </section>
      <Splitter {...pane.splitterProps} reverse aria-label="Resize export settings" aria-controls="music-export-settings" />
      <section id="music-export-settings" className="export-settings" aria-label="Export settings">
        <div className="export-settings__scroll">
          <PropSection title="Output" persistKey="export.music.output">
            <PropRow label="Format" htmlFor="music-export-format"><ComboBox id="music-export-format" value={settings.format} disabled={choosing}
              onChange={(format) => choose({ format: format as MusicExportFormat })}
              options={MUSIC_EXPORT_FORMATS.map(({ value, label }) => ({ value, label, disabled: support[value] !== true,
                description: support[value] === false ? "Unavailable on this device" : support[value] === undefined ? "Checking support…" : undefined }))} /></PropRow>
            {settings.format !== "wav" && <PropRow label="Bitrate" htmlFor="music-export-bitrate"><ComboBox id="music-export-bitrate" value={String(settings.bitrate)} options={MUSIC_EXPORT_BITRATES} disabled={choosing} onChange={(value) => choose({ bitrate: Number(value) })} /></PropRow>}
            <PropRow label="Sample rate"><span>48 kHz</span></PropRow>
          </PropSection>
          <div className="export-messages">
            {blocker && <InfoBar message={blocker} />}
            {active && <InfoBar title={job.status === "queued" ? "Queued for export" : "Exporting music"} message={job.progress?.detail ?? "Waiting for the current export to finish."} />}
            {job.progress && <ProgressBar aria-label="Music export progress" value={exportFraction(job.progress) * 100} />}
            {job.outcome?.kind === "saved" && <InfoBar severity="success" title="Music exported" message={job.outcome.path} onClose={() => dismissExportOutcome(job.id)} />}
            {job.outcome?.kind === "failed" && <InfoBar severity="error" title="Couldn’t export music" message={job.outcome.message} onClose={() => dismissExportOutcome(job.id)} />}
            {job.outcome?.kind === "cancelled" && <InfoBar title="Export cancelled" onClose={() => dismissExportOutcome(job.id)} />}
            {error && <InfoBar severity="error" title="Couldn’t export music" message={error} onClose={() => setError(null)} />}
          </div>
        </div>
        <div className="export-settings__foot"><div className="export-settings__actions">
          {active && <button type="button" className="secondary-button" disabled={job.cancelling || job.progress?.phase === "writing"} onClick={() => cancelExportJob(job.id)}>Cancel export</button>}
          <button type="button" className="primary-button" disabled={Boolean(blocker) || choosing} onClick={() => void exportSong()}>{choosing ? "Choosing destination…" : "Export…"}</button>
        </div></div>
      </section>
    </div>
  </div>;
}
