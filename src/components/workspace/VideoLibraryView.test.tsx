// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDraftGenerationJob, createProjectConfig, generationAssetId, type ProjectConfig } from "../../lib/project";
import { newVideo } from "../../lib/videoLibrary";
import { PreviewSources } from "../../lib/exportPipeline";
import { shotPoster } from "./ShotThumbnail";
import { VideoLibraryView } from "./VideoLibraryView";
import { VideoPlayback } from "./VideoPlayback";
import type { BackNavigation } from "./useBackNavigation";
import { choose } from "./comboTestUtils";

vi.mock("./ShotThumbnail", async (original) => ({ ...await original<typeof import("./ShotThumbnail")>(), shotPoster: vi.fn(async () => ({ poster: "data:image/jpeg;base64,preview", failed: false })) }));
vi.mock("../../lib/nativeShell", async (original) => ({ ...await original<typeof import("../../lib/nativeShell")>(), askNative: vi.fn(async () => true) }));
vi.mock("./GeneratorView", () => ({ GeneratorView: ({ config, sceneIds, toolbarStart, onChange }: { config: ProjectConfig; sceneIds: string[]; toolbarStart?: ReactNode; onChange: (next: ProjectConfig) => void }) => <div aria-label="Scenes editor">
  {toolbarStart}
  <span>{sceneIds.join(",")}</span><span data-testid="all-scenes">{config.generationJobs.length}</span>
  <button onClick={() => onChange({ ...config, generationJobs: [...config.generationJobs, createDraftGenerationJob("New", { id: "added" })] })}>Add scene</button>
</div> }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });
const project = () => createProjectConfig({ name: "Library", prompt: "", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 30 });
function mount(config = project(), openScene?: { id: string }) {
  let latest = config;
  function Harness() {
    const [value, setValue] = useState(config), [back, setBack] = useState<BackNavigation | null>(null); latest = value;
    return <>{back && <button onClick={back.run}>{back.label}</button>}<VideoLibraryView onBackNavigationChange={setBack} config={value} folderPath="D:/Project" onChange={setValue} onOpenTimeline={() => {}} openScene={openScene} /></>;
  }
  return { ...render(<Harness />), config: () => latest };
}

it("creates nested folders and videos, moves cards to a folder, and opens only that video's scenes", () => {
  const config = project(); config.generationJobs = [createDraftGenerationJob("Existing", { id: "legacy" })]; const view = mount(config);
  fireEvent.click(screen.getByRole("button", { name: "New folder" })); fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Album" } }); fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Video library actions" })).getByRole("button", { name: "New video" }));
  const video = view.config().videos!.find((video) => video.title === "New video")!;
  expect(video.folderId).toBe(view.config().videoFolders![0].id);
  fireEvent.change(screen.getByRole("textbox", { name: "Video title" }), { target: { value: "Track one" } });
  fireEvent.click(screen.getByRole("button", { name: "Open Track one" }));
  expect(screen.getByTestId("all-scenes")).toHaveTextContent("1"); fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  expect(view.config().videos!.find((item) => item.id === video.id)?.sceneIds).toEqual(["added"]);
  expect(view.config().generationJobs.map((scene) => scene.id)).toEqual(["legacy", "added"]);
  fireEvent.click(screen.getByRole("button", { name: "Back to Video" }));
  fireEvent.click(within(screen.getByRole("navigation", { name: "Video path" })).getByRole("button", { name: "Video" }));
  const dataTransfer = { types: ["application/x-slopus-video"], getData: () => JSON.stringify({ projectId: config.id, videoId: "video-default" }), dropEffect: "" };
  fireEvent.drop(screen.getByRole("button", { name: "Open Album" }).closest('[role="listitem"]')!, { dataTransfer });
  expect(view.config().videos!.find((item) => item.id === "video-default")?.folderId).toBe(video.folderId);
  fireEvent.click(screen.getByRole("button", { name: "List view" })); fireEvent.click(screen.getByRole("button", { name: "Open Album" }));
  expect(screen.getByRole("button", { name: "Open Track one" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Open Library" })).toBeInTheDocument();
});

it("creates a whole-song scene sequence and opens the owner for a timeline navigation", () => {
  const config = project(); config.videos = [{ ...newVideo(null), title: "Song video" }];
  config.assets = [{ id: "song", kind: "audio", name: "Complete song", mimeType: "audio/wav", relativePath: "music/song.wav", durationMs: 25000, createdAt: config.createdAt }];
  const view = mount(config); choose("Background music", "Complete song"); fireEvent.click(screen.getByRole("button", { name: "Create scenes for song" }));
  expect(view.config().generationJobs).toHaveLength(3); expect(view.config().videos![0].sceneIds).toHaveLength(3);
  expect(screen.getByLabelText("Scenes editor")).toBeInTheDocument();
  const next = view.config(); view.unmount(); mount(next, { id: next.generationJobs[1].id }); expect(screen.getByLabelText("Scenes editor")).toBeInTheDocument();
});

it("restores the open video after leaving the tab, respects Back and lets scene navigation override it", () => {
  const config = project();
  config.videoFolders = [{ id: "folder", name: "Collection" }];
  config.videos = [{ ...newVideo("folder"), title: "First", sceneIds: ["a"] }, { ...newVideo(null), title: "Second", sceneIds: ["b"] }];
  config.generationJobs = ["a", "b"].map((id) => createDraftGenerationJob(id, { id }));
  function Harness() {
    const [visible, setVisible] = useState(true), [openId, setOpenId] = useState<string>();
    const [openScene, setOpenScene] = useState<{ id: string }>();
    const [back, setBack] = useState<BackNavigation | null>(null);
    return <><button onClick={() => setVisible(!visible)}>Switch tab</button><button onClick={() => { setOpenScene({ id: "b" }); setVisible(true); }}>Open scene B</button>
      {back && <button onClick={back.run}>{back.label}</button>}
      {visible && <VideoLibraryView config={config} folderPath="D:/Project" onChange={() => {}} onOpenTimeline={() => {}}
        onBackNavigationChange={setBack} initialOpenVideoId={openId} onOpenVideoChange={setOpenId} openScene={openScene} onSceneOpened={() => setOpenScene(undefined)} />}</>;
  }
  render(<Harness />);
  const switchTab = () => fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Collection" }));
  fireEvent.click(screen.getByRole("button", { name: "Open First" }));
  switchTab(); expect(screen.queryByLabelText("Scenes editor")).not.toBeInTheDocument(); switchTab();
  expect(screen.getByLabelText("Scenes editor")).toHaveTextContent("a");
  fireEvent.click(screen.getByRole("button", { name: "Back to Video" }));
  expect(screen.getByRole("button", { name: "Open First" })).toBeInTheDocument();
  switchTab(); switchTab(); expect(screen.queryByLabelText("Scenes editor")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open Collection" }));
  fireEvent.click(screen.getByRole("button", { name: "Open First" }));
  switchTab(); fireEvent.click(screen.getByRole("button", { name: "Open scene B" }));
  expect(screen.getByLabelText("Scenes editor")).toHaveTextContent("b");
  switchTab(); switchTab(); expect(screen.getByLabelText("Scenes editor")).toHaveTextContent("b");
});

it("removes folders without deleting their videos and removes video scenes without removing timeline media", async () => {
  const config = project(); config.videoFolders = [{ id: "folder", name: "Collection" }]; config.videos = [{ ...newVideo("folder"), title: "Film", sceneIds: ["a"] }]; config.generationJobs = [createDraftGenerationJob("A", { id: "a" })];
  const view = mount(config); fireEvent.contextMenu(screen.getByRole("button", { name: "Open Collection" })); fireEvent.click(screen.getByRole("menuitem", { name: "Remove folder" }));
  expect(view.config().videoFolders).toHaveLength(0); expect(screen.getByRole("button", { name: "Open Film" })).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: "Open Film" })); fireEvent.click(screen.getByRole("menuitem", { name: "Remove video" }));
  await waitFor(() => expect(view.config().videos).toHaveLength(0)); expect(view.config().generationJobs).toHaveLength(0); expect(view.config().timeline).toEqual(config.timeline);
});

it("prepares later clips before playback, retains decoders across cuts, replays and closes the popout", async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.spyOn(PreviewSources.prototype, "url").mockImplementation(async (asset) => 'blob:' + asset.relativePath);
  const ready = vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
  let now = 0, nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const tick = async (ms: number) => { await act(async () => { now += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback(now)); }); };
  const config = project(); config.generationJobs = ["a", "b"].map((id) => createDraftGenerationJob("Dance", { id, durationSeconds: 3 }));
  config.assets = config.generationJobs.map((job, index) => ({ id: generationAssetId(job.id), kind: "generated", name: job.id, relativePath: 'media/' + job.id + '.mp4', mimeType: "video/mp4", createdAt: config.createdAt, durationMs: 10000,
    sceneSegments: [{ sceneId: job.id, startFrame: index * 96, frameCount: 96, latentRelativePath: 'latents/' + job.id + '.safetensors' }] }));
  const video = { ...newVideo(null), title: "Film", sceneIds: ["a", "b"] }, close = vi.fn();
  const view = render(<VideoPlayback video={video} config={config} folderPath="D:/Project" popout onClose={close} />);
  await waitFor(() => expect(view.container.querySelectorAll("video")).toHaveLength(2));
  const incoming = view.container.querySelector<HTMLVideoElement>('[data-clip-id="video-preview-b"] video')!;
  await tick(5000); expect(view.container.querySelector('.video-card__position')).toHaveTextContent('1 / 2');
  ready.mockReturnValue(4); fireEvent.loadedData(incoming); expect(incoming.currentTime).toBe(4);
  await tick(16); await tick(3001);
  expect(view.container.querySelector('[data-clip-id="video-preview-b"] video')).toBe(incoming);
  expect(view.container.querySelector('.video-card__position')).toHaveTextContent('2 / 2');
  await tick(3100); fireEvent.click(screen.getByRole("button", { name: "Replay Film" }));
  expect(view.container.querySelector('.video-card__position')).toHaveTextContent('1 / 2');
  fireEvent.pointerDown(screen.getByRole("dialog")); expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(view.container.querySelector(".shot-popout")!); expect(close).toHaveBeenCalledTimes(1);
  view.unmount(); expect(incoming.pause).toHaveBeenCalled(); expect(incoming).not.toHaveAttribute('src');
});

it("uses the first playback frame as the poster and keeps playback buttons separate from opening scenes", async () => {
  const config = project(), job = createDraftGenerationJob('Dance', {id: 'clip'});
  config.generationJobs = [job]; config.videos = [{...newVideo(null), title: 'Film', sceneIds: [job.id]}];
  config.assets = [{id:generationAssetId(job.id),kind:'generated',name:'Film',relativePath:'media/film.mp4',mimeType:'video/mp4',createdAt:config.createdAt,durationMs:10000,sceneSegments:[{sceneId:job.id,startFrame:96,frameCount:96,latentRelativePath:'latents/clip.safetensors'}]}];
  const view = mount(config);
  await screen.findByRole('img', {name: 'First frame of Film'});
  expect(shotPoster).toHaveBeenCalledWith('D:/Project','media/film.mp4',4);
  expect(screen.queryByRole('button',{name:'Open scenes'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Pop out Film'})); expect(screen.getByRole('dialog')).toBeInTheDocument(); expect(screen.queryByLabelText('Scenes editor')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Close video preview'}));
  fireEvent.click(screen.getByRole('button',{name:'Open Film'}).closest('[role="listitem"]')!); expect(screen.getByLabelText('Scenes editor')).toBeInTheDocument();
  expect(view.config().timeline).toEqual(config.timeline);
});
