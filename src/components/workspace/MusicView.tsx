import { useEffect, useRef, useState } from "react";
import type { ProjectAsset, ProjectConfig } from "../../lib/project";
import { isTauri, readMediaFileUrl } from "../../lib/persistence";
import { loadGeneratorTemplateSettings, subscribeGeneratorTemplates, templateSupportsMusic, templateUsable, generatorPathFields, type GeneratorTemplate } from "../../lib/settings";
import { musicFolderLabel, musicSettingsForModel, moveSong, newMusicFolder, newSong, songReference, updateSong, type MusicSettings, type MusicSong } from "../../lib/music";
import { isWorkActive, type WorkItem } from "../../lib/workQueue";
import { ComboBox, PropRow, PropSection, Slider, Splitter, useContextMenu, usePaneSize } from "../ui";
import { Add16, Audio16, FolderAdd16, FolderOpen16, GoToEnd16, GoToStart16, GridView16, ListView16, Pause16, Play16, References16, Speaker14, Sparkle16, Stop14 } from "../ui/icons";
import { generatorOptions } from "../generatorOptions";
import { SliderNumberInput, GENERATION_STEPS_RANGE } from "./SliderNumberInput";
import type { ConfigUpdate } from "./TimelineView";
import { GeneratorSelector } from "./GeneratorSelector";
import { ProjectStatus } from "./ProjectStatus";

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
const SONG_DRAG_TYPE = "application/x-slopus-music-song";

export function MusicView({ config, folderPath, onChange, onGenerate, onCancel, workItems, openSong, onSongOpened }: {
  openSong?: { id: string }; onSongOpened?: () => void;
  config: ProjectConfig; folderPath: string; onChange: (update: ConfigUpdate, key?: string) => void;
  onGenerate: (songId: string, template: GeneratorTemplate) => string | void; onCancel: (id: string) => void;
  workItems: readonly WorkItem[];
}) {
  const [templates, setTemplates] = useState(() => loadGeneratorTemplateSettings().templates.filter(templateSupportsMusic));
  useEffect(() => subscribeGeneratorTemplates(() => setTemplates(loadGeneratorTemplateSettings().templates.filter(templateSupportsMusic))), []);
  const folders = config.musicFolders ?? [];
  const [folderId, setFolderId] = useState<string | null>(null);
  const currentFolder = folders.find((folder) => folder.id === folderId);
  const currentFolderId = currentFolder?.id ?? null;
  const visibleSongs = (config.musicSongs ?? []).filter((song) => (song.folderId ?? null) === currentFolderId);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [dropFolder, setDropFolder] = useState<string>();
  const [selectedId, setSelectedId] = useState(config.musicSongs?.[0]?.id);
  useEffect(() => { if (openSong) { setFolderId(config.musicSongs?.find((song) => song.id === openSong.id)?.folderId ?? null); setSelectedId(openSong.id); onSongOpened?.(); } }, [openSong]);
  const selected = visibleSongs.find((song) => song.id === selectedId) ?? visibleSongs[0];
  const [newGeneratorId, setNewGeneratorId] = useState(templates[0]?.id ?? "");
  const template = templates.find((item) => item.id === (selected?.generatorId ?? newGeneratorId)) ?? templates[0];
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("slopus.music.view") === "list" ? "list" : "grid");
  const inspector = usePaneSize("music.inspector", 340, { min: 280, max: 560 });
  const menu = useContextMenu();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const activeWork = selected && workItems.find((item) => item.sceneId === selected.id && isWorkActive(item));
  const busy = Boolean(activeWork);
  const templateReady = (candidate: GeneratorTemplate) => templateUsable(candidate) && generatorPathFields(candidate).every((field) => !field.required || candidate.paths[field.id].trim() || candidate.sources?.[field.id]?.length);
  const ready = template && templateReady(template);
  const generatorStatus = !isTauri()
    ? { state: "demo", label: "Music generator unavailable", detail: "Generate music in the desktop app." }
    : !ready ? { state: "modelsMissing", label: "Model weights missing", detail: "Download or select music model weights in Settings → Generators." }
      : { state: "ready", label: "Music generator ready", detail: template.name };
  const edit = (patch: Partial<MusicSong>) => {
    if (selected && !busy) onChange((current) => updateSong(current, selected.id, patch), `music:${selected.id}`);
  };
  const setting = (patch: Partial<MusicSettings>) => { if (selected) edit({ settings: { ...selected.settings, ...patch } }); };
  const add = () => {
    const song = newSong(template?.id, Math.min(100, template?.defaultSteps ?? 32), currentFolderId);
    onChange((current) => ({ ...current, musicSongs: [...(current.musicSongs ?? []), song] }));
    setSelectedId(song.id); setError(null);
  };
  const createFolder = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const folder = newMusicFolder(folderName, currentFolderId);
      onChange((current) => ({ ...current, musicFolders: [...(current.musicFolders ?? []), folder] }));
      setFolderName(""); setCreatingFolder(false); setFolderId(folder.id); setError(null);
    } catch { setError("Enter a folder name of 1 to 200 characters."); }
  };
  const dropSong = (event: React.DragEvent, destination: string | null) => {
    event.preventDefault(); setDropFolder(undefined);
    try {
      const data = JSON.parse(event.dataTransfer.getData(SONG_DRAG_TYPE));
      if (data.projectId !== config.id || !config.musicSongs?.some((song) => song.id === data.songId)) return;
      onChange((current) => moveSong(current, data.songId, destination));
    } catch { /* Ignore unrelated or malformed drag data. */ }
  };
  const chooseGenerator = (id: string) => {
    const next = templates.find((item) => item.id === id);
    setNewGeneratorId(id);
    if (next && selected) edit({ generatorId: id, steps: Math.min(100, next.defaultSteps), settings: musicSettingsForModel(selected.settings, next.modelType) });
  };
  const generate = () => {
    if (!selected || !template) return;
    setError(null);
    try { const id = onGenerate(selected.id, template); if (id) setSelectedId(id); } catch (reason) { setError(String(reason)); }
  };

  const audio = useRef<HTMLAudioElement>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playlist, setPlaylist] = useState<string[]>([]);
  const playerAsset = config.assets.find((asset) => asset.id === playerId);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const playWhenReady = useRef(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const visiblePlayable = visibleSongs.flatMap((song) => {
    const asset = config.assets.find((item) => item.id === song.assetId && item.kind === "audio" && item.relativePath);
    return asset ? [{ song, asset }] : [];
  });
  // Capture the folder's order when playback starts. Browsing other folders
  // does not change what plays next; drafts and unavailable assets are skipped.
  const playable = playlist.length ? playlist.flatMap((id) => {
    const asset = config.assets.find((item) => item.id === id && item.kind === "audio" && item.relativePath);
    return asset ? [{ asset }] : [];
  }) : visiblePlayable;
  useEffect(() => {
    let disposed = false, owned: string | null = null;
    audio.current?.pause(); setPlaying(false); setPosition(0); setLength(0); setUrl(null); setPlaybackError(null);
    if (playerAsset) void readMediaFileUrl(folderPath, playerAsset, "audio/wav").then((value) => {
      if (disposed) { if (value) URL.revokeObjectURL(value); return; }
      owned = value; setUrl(value);
      if (!value) { playWhenReady.current = false; setPlaybackError("This song's audio file is unavailable."); }
    }).catch((reason) => { if (!disposed) { playWhenReady.current = false; setPlaybackError(String(reason)); } });
    return () => { disposed = true; if (owned) URL.revokeObjectURL(owned); };
  }, [folderPath, playerAsset?.id, playerAsset?.relativePath]);
  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume, url]);
  const play = async () => {
    try { await audio.current?.play(); } catch (reason) { setPlaybackError(`Could not play song: ${String(reason)}`); setPlaying(false); }
  };
  const playAsset = (asset: ProjectAsset) => {
    setPlaybackError(null);
    if (asset.id === playerId && url) void play();
    else { playWhenReady.current = true; setPlayerId(asset.id); }
  };
  const startSong = (asset: ProjectAsset) => {
    setPlaylist(visiblePlayable.map((item) => item.asset.id));
    playAsset(asset);
  };
  const move = (direction: number) => {
    if (!playable.length) return;
    if (!playlist.length) setPlaylist(visiblePlayable.map((item) => item.asset.id));
    const index = playable.findIndex(({ asset }) => asset.id === playerId);
    playAsset(playable[(Math.max(0, index) + direction + playable.length) % playable.length].asset);
  };
  const toggle = () => {
    if (playing) { audio.current?.pause(); return; }
    const asset = playerAsset ?? visiblePlayable.find(({ song }) => song.id === selected?.id)?.asset ?? visiblePlayable[0]?.asset;
    if (asset) { if (playerAsset) playAsset(asset); else startSong(asset); }
  };
  const context = (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>, song: MusicSong) => {
    const asset = config.assets.find((item) => item.id === song.assetId);
    menu.open(event, [{ label: "Create Reference", icon: <References16 />, disabled: !asset?.relativePath || (asset.durationMs ?? 0) < 2000,
      onSelect: () => {
        try {
          const reference = songReference(song, asset!);
          onChange((current) => ({ ...current, references: [...current.references, reference] }));
          setNotice(`Added ${song.title} to References.`);
        } catch (reason) { setError(String(reason)); }
      } }], { "aria-label": `${song.title} actions` });
  };

  return <div className="music-view" style={inspector.style}>
    <div className="music-toolbar" role="toolbar" aria-label="Music tools">
      <GeneratorSelector aria-label="Generator" data-tooltip={template?.name ?? "Generator"} status={generatorStatus}
        value={template?.id ?? ""} placeholder="No music generators" disabled={busy || !templates.length}
        options={generatorOptions(templates, (item) => ({ disabled: !templateReady(item), description: !templateReady(item) ? "Download in Settings" : undefined }))}
        onChange={chooseGenerator} />
      <button type="button" className="secondary-button" onClick={add}><Add16 />New song</button>
      <button type="button" className="secondary-button" onClick={() => { setCreatingFolder(true); setFolderName(""); }}><FolderAdd16 />New folder</button>
      <div className="music-toolbar__views" role="group" aria-label="Song view">
        {(["grid", "list"] as const).map((mode) => <button type="button" className="icon-button" key={mode} aria-label={`${mode === "grid" ? "Grid" : "List"} view`} aria-pressed={view === mode}
          onClick={() => { setView(mode); localStorage.setItem("slopus.music.view", mode); }}>{mode === "grid" ? <GridView16 /> : <ListView16 />}</button>)}
      </div>
    </div>
    <div className="music-body">
      <div className="music-library">
        <div className="music-library__heading"><h2>{currentFolder?.name ?? "Your music"}</h2><span>{visibleSongs.length} songs</span></div>
        <nav className="music-folders" aria-label="Music folders">
          {[{ id: null, name: "Your music" }, ...folders.map((folder) => ({ id: folder.id, name: musicFolderLabel(folders, folder.id) }))].map((folder) =>
            <button key={folder.id ?? "root"} type="button" className="secondary-button" aria-current={currentFolderId === folder.id ? "page" : undefined}
              data-drop-target={dropFolder === (folder.id ?? "") ? "true" : undefined} onClick={() => { setFolderId(folder.id); setSelectedId(undefined); setNotice(null); }}
              onDragOver={(event) => { if (event.dataTransfer.types.includes(SONG_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropFolder(folder.id ?? ""); } }}
              onDragLeave={() => setDropFolder(undefined)} onDrop={(event) => dropSong(event, folder.id)} data-tooltip={folder.name}><FolderOpen16 /><span>{folder.name}</span></button>)}
        </nav>
        {creatingFolder && <form className="music-new-folder" onSubmit={createFolder}>
          <input className="text-field" aria-label="Folder name" placeholder="Folder name" autoFocus maxLength={200} value={folderName} onChange={(event) => setFolderName(event.target.value)} />
          <button type="submit" className="primary-button" disabled={!folderName.trim()}>Create folder</button>
          <button type="button" className="secondary-button" onClick={() => setCreatingFolder(false)}>Cancel</button>
        </form>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
        {!visibleSongs.length ? <div className="music-empty"><Audio16 /><h3>{currentFolder ? "This folder is empty" : "Create your first song"}</h3><p>Add a song, describe its style and write lyrics, or leave lyrics empty for an instrumental.</p><button type="button" className="primary-button" onClick={add}><Add16 />New song</button></div> :
          <div className={`music-songs music-songs--${view}`} role="list" aria-label="Songs">
            {visibleSongs.map((song, index) => {
              const asset = config.assets.find((item) => item.id === song.assetId);
              const work = workItems.find((item) => item.sceneId === song.id && isWorkActive(item));
              return <div className={`music-song${selected?.id === song.id ? " music-song--selected" : ""}`} role="listitem" key={song.id}
                draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(SONG_DRAG_TYPE, JSON.stringify({ projectId: config.id, songId: song.id })); }} onDragEnd={() => setDropFolder(undefined)}
                onContextMenu={(event) => context(event, song)}>
                <button type="button" className="music-song__select" aria-label={`Select ${song.title}`} aria-pressed={selected?.id === song.id}
                  onClick={() => setSelectedId(song.id)} onDoubleClick={() => { if (asset) startSong(asset); }}
                  onKeyDown={(event) => { if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") context(event, song); }}>
                  <span className="music-song__art" aria-hidden="true"><Audio16 /><span>{String(index + 1).padStart(2, "0")}</span></span>
                  <span className="music-song__info"><strong>{song.title}</strong><span>{song.style || "Add a style to get started"}</span></span>
                  <span className="music-song__status">{work ? `${work.detail} · ${Math.round(work.progress * 100)}%` : song.status === "completed" && asset ? time((asset.durationMs ?? 0) / 1000) : song.status}</span>
                </button>
                <button type="button" className="icon-button music-song__play" aria-label={`Play ${song.title}`} disabled={!asset?.relativePath} onClick={() => asset && startSong(asset)}><Play16 /></button>
              </div>;
            })}
          </div>}
      </div>
      <Splitter {...inspector.splitterProps} reverse aria-label="Resize music inspector" aria-controls="music-inspector" />
      <aside id="music-inspector" className="music-inspector" aria-label="Song settings">
        {selected ? <>
          <div className="music-inspector__fields">
            <PropSection title="Song">
              <PropRow label="Title"><input className="text-field" aria-label="Song title" value={selected.title} maxLength={200} disabled={busy} onChange={(event) => edit({ title: event.target.value || "New song" })} /></PropRow>
              <label className="music-prompt">Style<textarea className="text-field" aria-label="Music style" value={selected.style} maxLength={10000} rows={3} disabled={busy} placeholder="Genre, mood, instruments and vocals…" onChange={(event) => edit({ style: event.target.value })} /></label>
              <label className="music-prompt">Lyrics<textarea className="text-field music-lyrics" aria-label="Music lyrics" value={selected.settings.lyrics} maxLength={30000} rows={10} disabled={busy} placeholder="[Verse]… Leave empty for an instrumental." onChange={(event) => setting({ lyrics: event.target.value })} /></label>
            </PropSection>
            <PropSection title="Generation" persistKey="music.generation">
              <PropRow label="Duration"><SliderNumberInput aria-label="Song duration" minimum={2} maximum={300} step={1} suffix="s" value={selected.settings.duration} disabled={busy} onCommit={(duration) => setting({ duration })} /></PropRow>
              <PropRow label="Steps"><SliderNumberInput aria-label="Music steps" {...GENERATION_STEPS_RANGE} value={selected.steps} disabled={busy} onCommit={(steps) => edit({ steps })} /></PropRow>
              <PropRow label="Seed" tooltip="Use -1 for a random seed."><input className="text-field" aria-label="Music seed" type="number" min={-1} max={Number.MAX_SAFE_INTEGER} step={1} value={selected.seed} disabled={busy} onChange={(event) => { const seed = event.target.valueAsNumber; if (Number.isSafeInteger(seed) && seed >= -1) edit({ seed }); }} /></PropRow>
            </PropSection>
            <PropSection title="Advanced" persistKey="music.advanced" defaultOpen={false}>
              {template?.modelType === "yue2" && <PropRow label="Planning"><ComboBox aria-label="Music planning" value={selected.settings.planning} disabled={busy} options={[{ value: "full", label: "Full (melody and chords)" }, { value: "melody", label: "Melody" }, { value: "off", label: "Off" }]} onChange={(planning) => setting({ planning: planning as MusicSettings["planning"], ...(planning === "off" ? { abc: "" } : {}) })} /></PropRow>}
              {([
                ["top_k", "Top K", 0, 1024, 1], ["semantic_guidance", "Guidance", 0, 5, 1],
                ...(template?.modelType === "yue2" ? [["temperature", "Temperature", 0, 2, 0.05], ["top_p", "Top P", 0.05, 1, 0.05], ["repetition_penalty", "Repetition penalty", 1, 2, 0.05]] : [["flow_guidance", "Flow guidance", 0, 5, 0.1]]),
              ] as [keyof MusicSettings, string, number, number, number][]).map(([key, label, minimum, maximum, step]) => <PropRow key={key} label={label} tooltip={key === "top_k" || key.includes("guidance") ? "Zero uses the model default." : undefined}>
                <SliderNumberInput aria-label={label} minimum={minimum} maximum={maximum} step={step} integer={key === "top_k"} value={Number(selected.settings[key])} disabled={busy} onCommit={(value) => setting({ [key]: key === "semantic_guidance" && value > 0 && value < 1 ? 1 : value })} /></PropRow>)}
              {template?.modelType === "yue2" && selected.settings.planning !== "off" && <>
                <PropRow label="Planning tokens"><SliderNumberInput aria-label="Planning tokens" minimum={32} maximum={4096} step={32} integer value={selected.settings.abc_max_tokens} disabled={busy} onCommit={(abc_max_tokens) => setting({ abc_max_tokens })} /></PropRow>
                <label className="music-prompt">ABC (optional)<textarea className="text-field" aria-label="Music ABC" value={selected.settings.abc} maxLength={30000} rows={3} disabled={busy} onChange={(event) => setting({ abc: event.target.value })} /></label>
              </>}
            </PropSection>
          </div>
          <div className="inspector-actions">
            {selected.error && <p role="alert">{selected.error}</p>}
            {activeWork ? <><progress value={activeWork.progress} max={1} aria-label="Music generation progress" /><button type="button" className="primary-button" disabled={activeWork.cancelling || activeWork.status === "encoding"} onClick={() => onCancel(activeWork.id)}><Stop14 aria-hidden="true" />{activeWork.cancelling ? "Cancelling…" : "Cancel"}</button></> :
              <button type="button" className="primary-button" data-tooltip={generatorStatus.state !== "ready" ? generatorStatus.detail : undefined} disabled={!ready || !isTauri() || !selected.style.trim()} onClick={generate}><Sparkle16 aria-hidden="true" />Generate</button>}
          </div>
        </> : <p className="music-inspector__empty">Add a song to edit its lyrics, style and generation settings.</p>}
      </aside>
    </div>
    <div className="music-player" aria-label="Music player">
      <div className="music-player__now"><Audio16 /><div><strong>{playerAsset?.name ?? "No song playing"}</strong><span>{playing ? "Playing" : playerAsset ? "Paused" : "Choose a generated song"}</span></div></div>
      <div className="music-player__transport">
        <div className="music-player__buttons"><button type="button" className="icon-button" aria-label="Previous song" disabled={!playable.length} onClick={() => move(-1)}><GoToStart16 /></button><button type="button" className="music-player__toggle primary-button" aria-label={playing ? "Pause music" : "Play music"} disabled={!playable.length && !playerAsset} onClick={toggle}>{playing ? <Pause16 /> : <Play16 />}</button><button type="button" className="icon-button" aria-label="Next song" disabled={!playable.length} onClick={() => move(1)}><GoToEnd16 /></button></div>
        <div className="music-player__seek"><span>{time(position)}</span><Slider aria-label="Song playback position" min={0} max={length || 1} step={0.1} value={position} disabled={!url || !length} onChange={(value) => { if (audio.current) audio.current.currentTime = value; setPosition(value); }} /><span>{time(length)}</span></div>
      </div>
      <div className="music-player__volume"><Speaker14 /><Slider aria-label="Music volume" min={0} max={1} step={0.01} value={volume} onChange={setVolume} /></div>
      {playbackError && <p className="music-player__error" role="alert">{playbackError}</p>}
      <audio ref={audio} src={url ?? undefined} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        onLoadedMetadata={(event) => { const duration = event.currentTarget.duration; setLength(Number.isFinite(duration) ? duration : 0); }}
        onCanPlay={() => { if (playWhenReady.current) { playWhenReady.current = false; void play(); } }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)} onEnded={() => { setPlaying(false); const index = playable.findIndex(({ asset }) => asset.id === playerId); if (index >= 0 && index + 1 < playable.length) playAsset(playable[index + 1].asset); }}
        onError={() => { if (url) { playWhenReady.current = false; setPlaying(false); setPlaybackError("This song could not be played."); } }} />
    </div>
    <ProjectStatus label="Music status">
      <span>{config.musicSongs?.length ?? 0} songs</span>
      {generatorStatus.state !== "ready" && <span className="generator-status__runtime">{generatorStatus.detail}</span>}
    </ProjectStatus>
    {menu.element}
  </div>;
}
