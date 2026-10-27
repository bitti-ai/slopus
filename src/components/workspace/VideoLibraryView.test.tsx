// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDraftGenerationJob, createProjectConfig, generationAssetId, type ProjectConfig } from "../../lib/project";
import { newVideo } from "../../lib/videoLibrary";
import { readMediaFileUrl } from "../../lib/persistence";
import { VideoLibraryView } from "./VideoLibraryView";
import { VideoPlayback } from "./VideoPlayback";
import { choose } from "./comboTestUtils";

vi.mock("../../lib/persistence", async (original) => ({ ...await original<typeof import("../../lib/persistence")>(), readMediaFileUrl: vi.fn(async (_, item) => `blob:${item.relativePath}`) }));
vi.mock("../../lib/nativeShell", async (original) => ({ ...await original<typeof import("../../lib/nativeShell")>(), askNative: vi.fn(async () => true) }));
vi.mock("./GeneratorView", () => ({ GeneratorView: ({ config, sceneIds, onChange }: { config: ProjectConfig; sceneIds: string[]; onChange: (next: ProjectConfig) => void }) => <div aria-label="Scenes editor">
  <span>{sceneIds.join(",")}</span><span data-testid="all-scenes">{config.generationJobs.length}</span>
  <button onClick={() => onChange({ ...config, generationJobs: [...config.generationJobs, createDraftGenerationJob("New", { id: "added" })] })}>Add scene</button>
</div> }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(); vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const project = () => createProjectConfig({ name: "Library", prompt: "", resolution: "416p", aspectRatio: "16:9", targetDurationSeconds: 30 });
function mount(config = project(), openScene?: { id: string }) {
  let latest = config;
  function Harness() { const [value, setValue] = useState(config); latest = value; return <VideoLibraryView config={value} folderPath="D:/Project" onChange={setValue} onOpenTimeline={() => {}} openScene={openScene} />; }
  return { ...render(<Harness />), config: () => latest };
}

it("creates nested folders and videos, moves cards to a folder, and opens only that video's scenes", () => {
  const config = project(); config.generationJobs = [createDraftGenerationJob("Existing", { id: "legacy" })]; const view = mount(config);
  fireEvent.click(screen.getByRole("button", { name: "New folder" })); fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Album" } }); fireEvent.click(screen.getByRole("button", { name: "Create folder" }));
  fireEvent.click(within(screen.getByRole("toolbar", { name: "Video library actions" })).getByRole("button", { name: "New video" }));
  const video = view.config().videos!.find((video) => video.title === "New video")!;
  expect(video.folderId).toBe(view.config().videoFolders![0].id);
  fireEvent.change(screen.getByRole("textbox", { name: "Video title" }), { target: { value: "Track one" } });
  fireEvent.doubleClick(screen.getByRole("button", { name: "Select Track one" }));
  expect(screen.getByTestId("all-scenes")).toHaveTextContent("1"); fireEvent.click(screen.getByRole("button", { name: "Add scene" }));
  expect(view.config().videos!.find((item) => item.id === video.id)?.sceneIds).toEqual(["added"]);
  expect(view.config().generationJobs.map((scene) => scene.id)).toEqual(["legacy", "added"]);
  fireEvent.click(screen.getByRole("button", { name: "Back to Video" }));
  fireEvent.click(within(screen.getByRole("navigation", { name: "Video path" })).getByRole("button", { name: "Video" }));
  const dataTransfer = { types: ["application/x-slopus-video"], getData: () => JSON.stringify({ projectId: config.id, videoId: "video-default" }), dropEffect: "" };
  fireEvent.drop(screen.getByRole("button", { name: "Open Album" }).closest('[role="listitem"]')!, { dataTransfer });
  expect(view.config().videos!.find((item) => item.id === "video-default")?.folderId).toBe(video.folderId);
  fireEvent.click(screen.getByRole("button", { name: "List view" })); fireEvent.click(screen.getByRole("button", { name: "Open Album" }));
  expect(screen.getByRole("button", { name: "Select Track one" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Select Library" })).toBeInTheDocument();
});

it("creates a whole-song scene sequence and opens the owner for a timeline navigation", () => {
  const config = project(); config.videos = [{ ...newVideo(null), title: "Song video" }];
  config.assets = [{ id: "song", kind: "audio", name: "Complete song", mimeType: "audio/wav", relativePath: "music/song.wav", durationMs: 25000, createdAt: config.createdAt }];
  const view = mount(config); choose("Background music", "Complete song"); fireEvent.click(screen.getByRole("button", { name: "Create scenes for song" }));
  expect(view.config().generationJobs).toHaveLength(3); expect(view.config().videos![0].sceneIds).toHaveLength(3);
  expect(screen.getByLabelText("Scenes editor")).toBeInTheDocument();
  const next = view.config(); view.unmount(); mount(next, { id: next.generationJobs[1].id }); expect(screen.getByLabelText("Scenes editor")).toBeInTheDocument();
});

it("removes folders without deleting their videos and removes video scenes without removing timeline media", async () => {
  const config = project(); config.videoFolders = [{ id: "folder", name: "Collection" }]; config.videos = [{ ...newVideo("folder"), title: "Film", sceneIds: ["a"] }]; config.generationJobs = [createDraftGenerationJob("A", { id: "a" })];
  const view = mount(config); fireEvent.contextMenu(screen.getByRole("button", { name: "Open Collection" })); fireEvent.click(screen.getByRole("menuitem", { name: "Remove folder" }));
  expect(view.config().videoFolders).toHaveLength(0); expect(screen.getByRole("button", { name: "Select Film" })).toBeInTheDocument();
  fireEvent.contextMenu(screen.getByRole("button", { name: "Select Film" })); fireEvent.click(screen.getByRole("menuitem", { name: "Remove video" }));
  await waitFor(() => expect(view.config().videos).toHaveLength(0)); expect(view.config().generationJobs).toHaveLength(0); expect(view.config().timeline).toEqual(config.timeline);
});

it("plays successive scene ranges, replays the full video, closes outside the popout and releases media", async () => {
  const config = project(); config.generationJobs = ["a", "b"].map((id) => createDraftGenerationJob("Dance", { id, durationSeconds: 3 }));
  config.assets = config.generationJobs.map((job, index) => ({ id: generationAssetId(job.id), kind: "generated", name: job.id, relativePath: `media/${job.id}.mp4`, mimeType: "video/mp4", createdAt: config.createdAt, durationMs: 10000,
    sceneSegments: [{ sceneId: job.id, startFrame: index * 96, frameCount: 96, latentRelativePath: `latents/${job.id}.safetensors` }] }));
  const video = { ...newVideo(null), title: "Film", sceneIds: ["a", "b"] }, close = vi.fn();
  const view = render(<VideoPlayback video={video} config={config} folderPath="D:/Project" popout onClose={close} />);
  const player = view.container.querySelector("video")!;
  await waitFor(() => expect(player).toHaveAttribute("src", "blob:media/a.mp4"));
  await act(async () => { fireEvent.loadedMetadata(player); }); expect(player.currentTime).toBe(0);
  player.currentTime = 3; fireEvent.timeUpdate(player);
  await waitFor(() => expect(player).toHaveAttribute("src", "blob:media/b.mp4"));
  await act(async () => { fireEvent.loadedMetadata(player); }); expect(player.currentTime).toBe(4);
  fireEvent.ended(player); fireEvent.click(screen.getByRole("button", { name: "Replay Film" }));
  await waitFor(() => expect(player).toHaveAttribute("src", "blob:media/a.mp4"));
  fireEvent.pointerDown(screen.getByRole("dialog")); expect(close).not.toHaveBeenCalled();
  fireEvent.pointerDown(view.container.querySelector(".shot-popout")!); expect(close).toHaveBeenCalledTimes(1);
  view.unmount(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media/a.mp4"); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media/b.mp4");
  expect(readMediaFileUrl).toHaveBeenCalledTimes(3);
});
