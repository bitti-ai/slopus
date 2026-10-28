import { useEffect, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent } from "react";
import { PROJECT_RESOLUTIONS, referenceTypeLabel, sceneDurationSeconds, sceneGenerationPending, type AspectRatio, type Resolution, type ProjectConfig, type ProjectVideo, type VideoSource } from "../../lib/project";
import { outputDimensions } from "../../lib/export";
import { SHOT_TAG_GROUPS } from "../../lib/shot-tags";
import { useShortcut } from "../../lib/commands";
import { citableReferences } from "./SceneEditor";
import { referenceMediaTypes } from "../../lib/referenceSelection";
import { mergeVideoScenes, newVideo, resolveVideoSource, songScenes, videoLibrary, videoScenes, videoSettings } from "../../lib/videoLibrary";
import { newMusicFolder } from "../../lib/music";
import { askNative } from "../../lib/nativeShell";
import { CommandBar, CommandBarButton, ComboBox, ItemHeader, ProgressRing, PropRow, PropSection, Splitter, useContextMenu, usePaneSize, type MenuEntry } from "../ui";
import { Add16, Delete16, Edit16, Film16, Film32, FolderAdd16, FolderOpen48, GridView16, GridView16Filled, ListView16, ListView16Filled, OpenExternal16, Play16 } from "../ui/icons";
import { GeneratorView } from "./GeneratorView";
import { VideoPlayback, videoPlaylist } from "./VideoPlayback";
import { VideoPoster } from "./VideoPoster";
import { PromptTextField } from "./PromptTextField";
import { useBackNavigation, type BackNavigationChange } from "./useBackNavigation";

const VIDEO_DRAG = "application/x-slopus-video";
const LOOKS = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!.options;
const sourceValue = (source: VideoSource | null | undefined) => source ? `${source.kind}:${source.id}` : "";
const parseSource = (value: string): VideoSource | null => value ? { kind: value.startsWith("asset:") ? "asset" : "reference", id: value.slice(value.indexOf(":") + 1) } : null;

export function VideoLibraryView(props: ComponentProps<typeof GeneratorView> & { openScene?: { id: string }; onSceneOpened?: () => void; initialOpenVideoId?: string; onOpenVideoChange?: (id: string | undefined) => void; onBackNavigationChange?: BackNavigationChange }) {
  const { config, onChange, folderPath } = props;
  const root = useRef<HTMLDivElement>(null), titleInput = useRef<HTMLInputElement>(null);
  const latest = useRef(config); latest.current = config;
  const videos = videoLibrary(config), folders = config.videoFolders ?? [];
  const [folderId, setFolderId] = useState<string | null>(() => videos.find((video) => video.id === props.initialOpenVideoId)?.folderId ?? null);
  const [selectedId, setSelectedId] = useState<string | undefined>(props.initialOpenVideoId);
  const [openId, setOpenId] = useState<string | undefined>(props.initialOpenVideoId);
  const [playback, setPlayback] = useState<{ id: string; popout: boolean }>();
  const [creatingFolder, setCreatingFolder] = useState(false), [folderName, setFolderName] = useState("");
  const [view, setView] = useState<"grid" | "list">(() => localStorage.getItem("slopus.video.view") === "list" ? "list" : "grid");
  const pane = usePaneSize("video.inspector", 340, { min: 280, max: 560 });
  const menu = useContextMenu();
  const currentFolder = folders.find((folder) => folder.id === folderId), currentFolderId = currentFolder?.id ?? null;
  const visible = videos.filter((video) => (video.folderId ?? null) === currentFolderId);
  const selected = visible.find((video) => video.id === selectedId) ?? visible[0];
  const selectedSettings = videoSettings(selected, config);
  const resolutionLabel = (resolution: Resolution) => { const size = outputDimensions(resolution, selectedSettings.aspectRatio); return `${size.width} × ${size.height}`; };
  const open = videos.find((video) => video.id === openId);
  useShortcut("F2", () => { titleInput.current?.focus(); titleInput.current?.select(); }, { scope: root, enabled: Boolean(selected) && !open });
  useBackNavigation(props.onBackNavigationChange, open ? "Back to Video" : null, () => setOpenId(undefined));
  useEffect(() => { props.onOpenVideoChange?.(open?.id); }, [open?.id, props.onOpenVideoChange]);
  const playing = videos.find((video) => video.id === playback?.id);
  const folderContents = (id: string) => {
    const videoCount = videos.filter((video) => video.folderId === id).length;
    const folderCount = folders.filter((folder) => folder.parentId === id).length;
    return [videoCount ? `${videoCount} video${videoCount === 1 ? "" : "s"}` : "", folderCount ? `${folderCount} folder${folderCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(" \u00b7 ") || "Empty folder";
  };
  const breadcrumbs: { id: string | null; name: string }[] = [];
  const visited = new Set<string>();
  let ancestor = currentFolder;
  while (ancestor && !visited.has(ancestor.id)) {
    visited.add(ancestor.id); breadcrumbs.unshift({ id: ancestor.id, name: ancestor.name });
    const parent = ancestor.parentId; ancestor = folders.find((folder) => folder.id === parent);
  }
  breadcrumbs.unshift({ id: null, name: "Video" });
  useEffect(() => {
    if (!props.openScene) return;
    const owner = videoLibrary(latest.current).find((video) => video.sceneIds.includes(props.openScene!.id));
    if (owner) { setFolderId(owner.folderId ?? null); setSelectedId(owner.id); setOpenId(owner.id); setPlayback(undefined); }
    props.onSceneOpened?.();
  }, [props.openScene]);
  const update = (change: (current: ProjectConfig) => ProjectConfig, key?: string) => {
    const current = latest.current;
    onChange(change({ ...current, videos: videoLibrary(current) }), key);
  };
  const edit = (patch: Partial<ProjectVideo>) => { if (selected) update((current) => ({ ...current, videos: current.videos!.map((video) => video.id === selected.id ? { ...video, ...patch } : video) }), `video:${selected.id}`); };
  const add = () => {
    const video = newVideo(currentFolderId);
    update((current) => ({ ...current, videos: [...current.videos!, video] })); setSelectedId(video.id);
  };
  const browse = (id: string | null) => { setFolderId(id); setPlayback(undefined); setCreatingFolder(false); menu.close(); };
  const openVideo = (video: ProjectVideo) => { setSelectedId(video.id); setOpenId(video.id); setPlayback(undefined); menu.close(); };
  const newItems = (): MenuEntry[] => [
    { label: "New video", icon: <Add16 />, onSelect: add },
    { label: "New folder", icon: <FolderAdd16 />, onSelect: () => { setFolderName(""); setCreatingFolder(true); } },
  ];
  const remove = async (video: ProjectVideo) => {
    if (!await askNative({ message: `Remove ${video.title} and its scenes? Existing timeline clips and media will be kept.`, title: "Remove video", kind: "warning" })) return;
    update((current) => ({ ...current, videos: current.videos!.filter((item) => item.id !== video.id), generationJobs: current.generationJobs.filter((scene) => !video.sceneIds.includes(scene.id)) }));
    setPlayback(undefined);
  };
  const dropProps = (destination: string | null) => ({
    onDragOver: (event: DragEvent<HTMLElement>) => { if (event.dataTransfer.types.includes(VIDEO_DRAG)) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault(); event.stopPropagation();
      try {
        const data = JSON.parse(event.dataTransfer.getData(VIDEO_DRAG));
        if (data.projectId === config.id && typeof data.videoId === "string") update((current) => ({ ...current, videos: current.videos!.map((video) => video.id === data.videoId ? { ...video, folderId: destination } : video) }));
      } catch { /* Ignore unrelated drags. */ }
    },
  });
  const sourceOptions = (kind: "audio" | "video") => [
    { value: "", label: "None" },
    ...config.assets.filter((asset) => (asset.kind === kind || kind === "video" && asset.kind === "generated") && (asset.relativePath || asset.sourcePath)).map((asset) => ({ value: `asset:${asset.id}`, label: config.musicSongs?.find((song) => song.assetId === asset.id)?.title ?? asset.name })),
    ...config.references.filter((reference) => reference.kind === kind && (reference.relativePath || reference.sourcePath)).map((reference) => ({ value: `reference:${reference.id}`, label: `${reference.name} (reference range)` })),
  ];
  if (open) return <div className="video-scenes">
    <GeneratorView {...props} key={open.id} config={{ ...config, videos }} sceneIds={open.sceneIds} selectedJobId={open.sceneIds.includes(props.selectedJobId ?? "") ? props.selectedJobId : undefined}
      toolbarStart={<strong className="video-scenes__title" title={open.title}>{open.title}</strong>}
      onChange={(next, key) => onChange(mergeVideoScenes(latest.current, open.id, next), key)} />
  </div>;
  return <div ref={root} className="video-library-view" style={pane.style}>
    <CommandBar className="generator-command" aria-label="Video library actions" end={<>
      <CommandBarButton icon={view === "grid" ? <GridView16Filled /> : <GridView16 />} label="Grid view" pressed={view === "grid"} onClick={() => { setView("grid"); localStorage.setItem("slopus.video.view", "grid"); }} />
      <CommandBarButton icon={view === "list" ? <ListView16Filled /> : <ListView16 />} label="List view" pressed={view === "list"} onClick={() => { setView("list"); localStorage.setItem("slopus.video.view", "list"); }} />
    </>}>
      <CommandBarButton icon={<Add16 />} label="New video" showLabel onClick={add} />
      <CommandBarButton icon={<FolderAdd16 />} label="New folder" showLabel onClick={() => { setFolderName(""); setCreatingFolder(true); }} />
    </CommandBar>
    <div className="video-library-body">
      <div className="video-library-stage">
        <div className="music-library" aria-label="Video library" tabIndex={0} onContextMenu={(event) => { if (!(event.target as HTMLElement).closest("input, textarea")) menu.open(event, newItems()); }}>
          <div className="music-library__heading"><nav aria-label="Video path"><h2 className="music-path">{breadcrumbs.map((folder, index) => <span key={folder.id ?? "root"}>{index > 0 && <span className="music-path__separator">/</span>}<button type="button" aria-current={folder.id === currentFolderId ? "page" : undefined} onClick={() => browse(folder.id)} {...dropProps(folder.id)}>{folder.name}</button></span>)}</h2></nav><span>{visible.length} videos</span></div>
          {creatingFolder && <form className="music-new-folder" onSubmit={(event) => { event.preventDefault(); if (!folderName.trim()) return; const folder = newMusicFolder(folderName, currentFolderId); update((current) => ({ ...current, videoFolders: [...(current.videoFolders ?? []), folder] })); browse(folder.id); }}>
            <input className="text-field" aria-label="Folder name" maxLength={200} autoFocus value={folderName} onChange={(event) => setFolderName(event.target.value)} />
            <button className="primary-button" disabled={!folderName.trim()}>Create folder</button><button type="button" className="secondary-button" onClick={() => setCreatingFolder(false)}>Cancel</button>
          </form>}
          <div className={`music-songs music-songs--${view}`} role="list" aria-label="Video contents">
            {folders.filter((folder) => (folder.parentId ?? null) === currentFolderId).map((folder) => <div className="music-song music-folder video-folder" role="listitem" key={folder.id} {...dropProps(folder.id)} onContextMenu={(event) => menu.open(event, [...newItems(), { separator: true }, { label: "Remove folder", icon: <Delete16 />, onSelect: () => update((current) => ({ ...current, videoFolders: current.videoFolders?.filter((item) => item.id !== folder.id).map((item) => item.parentId === folder.id ? { ...item, parentId: folder.parentId } : item), videos: current.videos!.map((video) => video.folderId === folder.id ? { ...video, folderId: folder.parentId } : video) })) }])}>
              <button type="button" className="music-song__select" aria-label={`Open ${folder.name}`} onClick={() => browse(folder.id)}><span className="music-song__art"><FolderOpen48 /></span><span className="music-song__info"><strong title={folder.name}>{folder.name}</strong><span>{folderContents(folder.id)}</span></span></button>
            </div>)}
            {visible.map((video) => {
              const scenes = videoScenes(video, config), playlist = videoPlaylist(video, config), playable = playlist.length, first = playlist[0];
              const [width, height] = videoSettings(video, config).aspectRatio.split(":").map(Number);
              const aspect = first?.asset.width && first.asset.height ? first.asset.width / first.asset.height : width / height;
              const pending = scenes.filter(sceneGenerationPending), running = pending.filter((scene) => scene.status !== "queued");
              const busy = pending.length > 0;
              const progress = running.reduce((sum, scene) => sum + scene.progress, 0) / Math.max(1, running.length) * 100;
              return <div key={video.id} role="listitem" style={{ "--video-card-aspect": aspect } as CSSProperties} className={`music-song video-card${busy ? " video-card--busy" : ""}${selected?.id === video.id ? " music-song--selected" : ""}${playable ? "" : " music-song--draft"}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(VIDEO_DRAG, JSON.stringify({ projectId: config.id, videoId: video.id })); }}
                onClick={(event) => { if (!(event.target as Element).closest("button, .video-card__player")) setSelectedId(video.id); }}
                onDoubleClick={(event) => { if (!(event.target as Element).closest("button, .video-card__player")) openVideo(video); }}
                onContextMenu={(event) => { setSelectedId(video.id); menu.open(event, [{ label: "Edit Scenes", onSelect: () => openVideo(video) }, ...newItems(), { separator: true }, { label: "Remove video", icon: <Delete16 />, disabled: busy, danger: true, onSelect: () => { void remove(video); } }]); }}>
                <button type="button" className="music-song__select" aria-label={`Select ${video.title}`} aria-pressed={selected?.id === video.id} onFocus={() => setSelectedId(video.id)} onClick={() => setSelectedId(video.id)} onDoubleClick={() => openVideo(video)}>
                  <span className="music-song__art"><VideoPoster folderPath={folderPath} relativePath={first?.asset.relativePath} seconds={first?.start ?? 0} revision={props.generationCompletionTimes?.[first?.sceneId ?? ""] ?? first?.asset.createdAt} title={video.title} /></span><span className="music-song__info"><strong>{video.title}</strong><span>{scenes.length} scenes · {scenes.reduce((seconds, scene) => seconds + sceneDurationSeconds(scene), 0).toFixed(1)} s</span><span>{busy ? "Generating" : playable ? `${playable} / ${scenes.length} scenes ready` : "Draft"}</span></span>
                </button>
                {busy && <ProgressRing className="video-card__progress" size={20} value={progress > 0 ? progress : undefined} aria-label={`${video.title} generation progress`} />}
                {playable > 0 && !(playing?.id === video.id && !playback?.popout) && <div className="video-card__controls"><button type="button" aria-label={`Play ${video.title}`} onClick={() => setPlayback({ id: video.id, popout: false })}><Play16 /></button><button type="button" aria-label={`Pop out ${video.title}`} onClick={() => setPlayback({ id: video.id, popout: true })}><OpenExternal16 /></button></div>}
                {playing?.id === video.id && !playback?.popout && <VideoPlayback key={video.id} video={video} config={config} folderPath={folderPath} popout={false} onClose={() => setPlayback(undefined)} onPopout={() => setPlayback({ id: video.id, popout: true })} />}
              </div>;
            })}
          </div>
          {!visible.length && !folders.some((folder) => (folder.parentId ?? null) === currentFolderId) && <div className="music-empty"><Film32 /><h3>Create a video</h3><p>Organize scenes and shots into a video, with shared prompts and references.</p><button type="button" className="primary-button" onClick={add}>New video</button></div>}
        </div>
        {playing && playback?.popout && <VideoPlayback key={playing.id} video={playing} config={config} folderPath={folderPath} popout onClose={() => setPlayback(undefined)} />}
      </div>
      <Splitter {...pane.splitterProps} reverse aria-label="Resize video inspector" />
      <aside className="music-inspector" aria-label="Video settings">
        {selected && <ItemHeader color="var(--clip-generated)" icon={<Film16 />}
          name={<h2 className="generator-panel__name"><input ref={titleInput} className="ui-item-header__input" aria-label="Video title" aria-keyshortcuts="F2" maxLength={200} value={selected.title} onChange={(event) => edit({ title: event.target.value || "New video" })} /></h2>}
          meta={`${videoScenes(selected, config).length} scenes · ${videoScenes(selected, config).reduce((seconds, scene) => seconds + sceneDurationSeconds(scene), 0).toFixed(1)} s`}
          actions={<button type="button" className="icon-button" aria-label={`Remove video ${selected.title}`} data-tooltip="Remove video"
            disabled={videoScenes(selected, config).some(sceneGenerationPending)} onClick={() => { void remove(selected); }}><Delete16 aria-hidden="true" /></button>} />}
        <div className="music-inspector__fields">{selected ? <>
        <PropSection title="Video">
          <div className="music-prompt"><span>Shared prompt</span><PromptTextField aria-label="Video prompt" rows={5} value={selected.prompt} references={citableReferences(config.references).map((reference) => ({ id: reference.id, name: reference.name, mediaTypes: referenceMediaTypes(reference), detail: referenceTypeLabel(reference) }))} placeholder="Visual style and references for every scene…" onChange={(prompt) => edit({ prompt: prompt.slice(0, 30000) })} /></div>
        </PropSection>
        <PropSection title="Settings">
          <PropRow label="Look"><ComboBox aria-label="Video Look" value={selected.defaultLook ?? ""} displayText={LOOKS.find((look) => look.id === selectedSettings.defaultLook)?.label ?? selectedSettings.defaultLook ?? "None"} options={[
            { value: "", label: `Project default (${LOOKS.find((look) => look.id === config.settings.defaultLook)?.label ?? config.settings.defaultLook ?? "None"})` },
            ...LOOKS.map((look) => ({ value: look.id, label: look.label })),
          ]} onChange={(value) => edit({ defaultLook: value || null })} /></PropRow>
          <PropRow label="Aspect ratio"><ComboBox aria-label="Video aspect ratio" value={selected.aspectRatio ?? ""} displayText={selectedSettings.aspectRatio} options={[
            { value: "", label: `Project default (${config.settings.aspectRatio})` },
            ...(["16:9", "9:16", "1:1", "4:5"] as const).map((value) => ({ value, label: value })),
          ]} onChange={(value) => edit({ aspectRatio: value ? value as AspectRatio : null })} /></PropRow>
          <PropRow label="Resolution"><ComboBox aria-label="Video resolution" value={selected.resolution ?? ""} displayText={resolutionLabel(selectedSettings.resolution)} options={[
            { value: "", label: `Project default (${resolutionLabel(config.settings.resolution)})` },
            ...[...new Set([...PROJECT_RESOLUTIONS, selectedSettings.resolution])].map((value) => ({ value, label: resolutionLabel(value) })),
          ]} onChange={(value) => edit({ resolution: value ? value as Resolution : null })} /></PropRow>
        </PropSection>
        <PropSection title="References">
          <PropRow label="Music"><ComboBox aria-label="Background music" value={sourceValue(selected.musicSource)} options={sourceOptions("audio")} placeholder="Reference unavailable" onChange={(value) => edit({ musicSource: parseSource(value) })} /></PropRow>
          <PropRow label="Video"><ComboBox aria-label="Reference video" value={sourceValue(selected.videoSource)} options={sourceOptions("video")} placeholder="Reference unavailable" onChange={(value) => edit({ videoSource: parseSource(value) })} /></PropRow>
          <p className="video-reference-help">Each scene uses its matching time range. Choose generated media, Timeline imports or a saved reference range.</p>
          {selected.musicSource && <p className="video-reference-help">Music needs an image in the shared prompt or a reference video, and a References/Singularity generator.</p>}
          {selected.musicSource && !selected.sceneIds.length && (resolveVideoSource(selected.musicSource, config, "audio")?.durationSeconds ?? 0) >= 2 && <button type="button" className="secondary-button" onClick={() => {
            const scenes = songScenes(selected, latest.current); if (!scenes.length) return;
            update((current) => ({ ...current, generationJobs: [...current.generationJobs, ...scenes], videos: current.videos!.map((video) => video.id === selected.id ? { ...video, sceneIds: scenes.map((scene) => scene.id) } : video) })); openVideo(selected);
          }}>Create scenes for song</button>}
        </PropSection>
        <PropSection title="Scenes">
          <p className="video-reference-help">{videoScenes(selected, config).map((scene, index, all) => { const start = all.slice(0, index).reduce((sum, item) => sum + sceneDurationSeconds(item), 0); return <span className="video-reference-range" key={scene.id}>{scene.title}: {start.toFixed(1)}–{(start + sceneDurationSeconds(scene)).toFixed(1)} s</span>; })}</p>
        </PropSection>
      </> : <p className="music-inspector__empty">Select a video to edit its settings.</p>}</div>
        {selected && <div className="inspector-actions"><button type="button" className="primary-button" onClick={() => openVideo(selected)}><Edit16 aria-hidden="true" />Edit Scenes</button></div>}
      </aside>
    </div>
    {menu.element}
  </div>;
}
