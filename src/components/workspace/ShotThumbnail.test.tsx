// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectConfig, parseProjectConfig, sceneShots, type GenerationJob } from "../../lib/project";
import { ShotThumbnail } from "./ShotThumbnail";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

/** A media stack that behaves like a browser's: the desktop shell serves the
 *  bytes, blob URLs exist, a <video> reports this file's metadata, and a canvas
 *  actually draws. jsdom does none of that, so it is stood in for — and every
 *  seek the component asks for is recorded, because WHICH frame each card gets
 *  is the whole point of this component. */
async function withFakeFile(file: { seconds: number }, body: (seen: {
  seeks: number[];
  reads: () => number;
  posters: () => Array<{ width: number; height: number; type: string; quality: number | undefined }>;
}) => Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(8));
  URL.createObjectURL = () => "blob:slopus-test";
  URL.revokeObjectURL = () => undefined;
  const load = HTMLMediaElement.prototype.load;
  const play = HTMLMediaElement.prototype.play;
  const pause = HTMLMediaElement.prototype.pause;
  const getContext = HTMLCanvasElement.prototype.getContext;
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as unknown as typeof getContext;
  const seeks: number[] = [];
  const posters: Array<{ width: number; height: number; type: string; quality: number | undefined }> = [];
  // The drawn frame is named after the moment it was taken from, so a test can
  // tell one card's picture from another's.
  HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, type?: string, quality?: number) {
    posters.push({ width: this.width, height: this.height, type: type ?? "", quality });
    return `data:image/jpeg;base64,frame-${seeks.length === 0 ? 0 : seeks[seeks.length - 1]}`;
  } as unknown as typeof toDataURL;
  const create = document.createElement.bind(document);
  const spy = vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = create(tag, options);
    if (tag === "video") {
      for (const [name, value] of [["duration", file.seconds], ["videoWidth", 1920], ["videoHeight", 1080]] as const) {
        Object.defineProperty(element, name, { value, configurable: true });
      }
      let currentTime = 0;
      Object.defineProperty(element, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
          seeks.push(value);
          setTimeout(() => element.dispatchEvent(new Event("seeked")), 0);
        },
      });
      setTimeout(() => {
        element.dispatchEvent(new Event("loadedmetadata"));
        element.dispatchEvent(new Event("loadeddata"));
      }, 0);
    }
    return element;
  });
  try {
    await body({ seeks, reads: () => vi.mocked(invoke).mock.calls.length, posters: () => posters });
  } finally {
    spy.mockRestore();
    HTMLMediaElement.prototype.load = load;
    HTMLMediaElement.prototype.play = play;
    HTMLMediaElement.prototype.pause = pause;
    HTMLCanvasElement.prototype.getContext = getContext;
    HTMLCanvasElement.prototype.toDataURL = toDataURL;
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    vi.mocked(invoke).mockReset();
  }
}

/** A finished scene of two shots with a real file in the project folder. */
const rendered = (folder: string): GenerationJob => {
  const fresh = createProjectConfig({ name: folder, prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
  return parseProjectConfig({
    ...fresh,
    generationJobs: [{
      ...fresh.generationJobs[0],
      status: "completed",
      stage: "completed",
      progress: 1,
      outputRelativePath: "media/generated/first-scene.mp4",
      durationSeconds: 9,
      shots: [
        { id: "a1", startSeconds: 0, action: "she walks towards the camera" },
        { id: "a2", startSeconds: 4.5, action: "she stops at the doorway" },
      ],
    }],
  }).generationJobs[0];
};

describe("a shot's picture", () => {
  it("pops a shot into the board, respects its source offset and cut, and replays without reopening the file", async () => {
    const folder = "C:\\Popout shot replay", job = rendered(folder);
    await withFakeFile({ seconds: 20 }, async seen => {
      const { container } = render(<div className="generator-board-viewport"><div className="generator-board">
        <ShotThumbnail folderPath={folder} job={job} seconds={1} endSeconds={2} sourceOffsetSeconds={5} shotNumber={1} />
      </div></div>);
      const button = await screen.findByRole("button", { name: "Pop out shot 1 of First scene" });
      button.focus(); fireEvent.click(button);
      const dialog = await screen.findByRole("dialog", { name: "shot 1 of First scene preview" });
      expect(dialog.closest(".generator-board-viewport")).toBe(container.firstChild);
      expect(container.querySelector(".generator-board")?.hasAttribute("inert")).toBe(true);
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Pause shot 1 of First scene" })).not.toBeNull());
      const video = dialog.querySelector("video")!;
      expect(seen.seeks).toContain(6);
      fireEvent.pointerDown(video); fireEvent.click(video);
      expect(screen.getByRole("dialog")).toBe(dialog);
      video.currentTime = 7; fireEvent.timeUpdate(video);
      const reads = seen.reads();
      fireEvent.click(within(dialog).getByRole("button", { name: "Replay shot 1 of First scene" }));
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "Pause shot 1 of First scene" })).not.toBeNull());
      expect(video.currentTime).toBe(6);
      expect(seen.reads()).toBe(reads);
      fireEvent.click(dialog.parentElement!);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(container.querySelector(".generator-board")?.hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(button);
    });
  });

  it("stops inline playback when popping out and dismisses with Escape or an outside pointer press", async () => {
    const folder = "C:\\Popout dismissal", job = rendered(folder);
    await withFakeFile({ seconds: 9 }, async () => {
      render(<div className="generator-board-viewport"><div className="generator-board">
        <ShotThumbnail folderPath={folder} job={job} seconds={0} endSeconds={4.5} shotNumber={1} />
      </div></div>);
      fireEvent.click(await screen.findByRole("button", { name: "Play shot 1 of First scene" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause shot 1 of First scene" })).not.toBeNull());
      const popout = screen.getByRole("button", { name: "Pop out shot 1 of First scene" });
      fireEvent.click(popout);
      await screen.findByRole("dialog");
      expect(document.querySelector(".shot-thumb video")).toBeNull();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      fireEvent.click(popout); await screen.findByRole("dialog");
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("reports popout file errors and releases a file that finishes loading after dismissal", async () => {
    const folder = "C:\\Popout errors", job = rendered(folder);
    const { invoke } = await import("@tauri-apps/api/core");
    await withFakeFile({ seconds: 9 }, async () => {
      render(<div className="generator-board-viewport"><div className="generator-board">
        <ShotThumbnail folderPath={folder} job={job} seconds={0} shotNumber={1} />
      </div></div>);
      const popout = await screen.findByRole("button", { name: "Pop out shot 1 of First scene" });
      vi.mocked(invoke).mockRejectedValueOnce(new Error("Missing file"));
      fireEvent.click(popout);
      expect((await screen.findByRole("alert")).textContent).toContain("Could not open");
      fireEvent.click(screen.getByRole("button", { name: "Close shot preview" }));
      let finish!: (value: ArrayBuffer) => void;
      vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      fireEvent.click(popout);
      await waitFor(() => expect(finish).toBeDefined());
      fireEvent.keyDown(document, { key: "Escape" });
      finish(new ArrayBuffer(8));
      await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:slopus-test"));
      expect(screen.queryByRole("dialog")).toBeNull();
      revoke.mockRestore();
    });
  });

  it("previews the new scene inside its joined file and stops at the offset cut", async () => {
    const folder = "C:\\Joined scene playback";
    const job = rendered(folder);
    await withFakeFile({ seconds: 20 }, async (seen) => {
      render(<ShotThumbnail folderPath={folder} job={job} seconds={0} endSeconds={2} sourceOffsetSeconds={5} shotNumber={1} />);
      fireEvent.click(await screen.findByRole("button", { name: "Play shot 1 of First scene" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause shot 1 of First scene" })).not.toBeNull());
      expect(seen.seeks).toContain(5);
      const video = document.querySelector("video")!;
      video.currentTime = 6;
      fireEvent.timeUpdate(video);
      expect(screen.getByRole("button", { name: "Pause shot 1 of First scene" })).not.toBeNull();
      video.currentTime = 7;
      fireEvent.timeUpdate(video);
      expect(screen.getByRole("button", { name: "Play shot 1 of First scene" })).not.toBeNull();
    });
  });
  it("can draw the exact first frame for a scene card", async () => {
    const folder = "C:\\Exact first frame";
    const job = rendered(folder);
    await withFakeFile({ seconds: 9 }, async (seen) => {
      render(<ShotThumbnail folderPath={folder} job={job} seconds={0} shotNumber={1} />);
      const control = await screen.findByRole("button", { name: "Play shot 1 of First scene" });
      const picture = control.querySelector("img") as HTMLImageElement;
      expect(seen.seeks).toEqual([]);
      expect(picture.src).toContain("frame-0");
    });
  });

  it("takes each shot's own frame out of the scene's file, opening that file once", async () => {
    /* One .mp4 holds the whole scene, so a component that read the file per
       card would pull the same few hundred megabytes through the webview once
       per shot. */
    const folder = "C:\\Opened once";
    const job = rendered(folder);
    await withFakeFile({ seconds: 9 }, async (seen) => {
      render(<>{sceneShots(job).map((shot, index) =>
        <ShotThumbnail key={shot.id} folderPath={folder} job={job} seconds={shot.startSeconds} shotNumber={index + 1} />)}</>);

      /* Named "Shot N of <scene>" once a real frame is drawn; until then the
         placeholder is named for the state instead, so this waits for the
         picture rather than for anything with a role of img. */
      const drawn = () => screen.getAllByRole("button", { name: /^Play shot .* of First scene$/ });
      await waitFor(() => expect(drawn()).toHaveLength(2));
      const pictures = drawn().map((control) => control.querySelector("img") as HTMLImageElement);
      // The file was read once, for both cards.
      expect(seen.reads()).toBe(1);
      // Each card gets the exact frame where its shot starts. Frame zero is
      // already loaded, so only shot 2 requires an explicit seek.
      expect(seen.seeks).toEqual([4.5]);
      expect(pictures[0].src).not.toBe(pictures[1].src);
      expect(seen.posters()).toEqual([
        { width: 640, height: 360, type: "image/jpeg", quality: 0.92 },
        { width: 640, height: 360, type: "image/jpeg", quality: 0.92 },
      ]);
    });
  });

  it("plays from this shot's cut and stops at the next cut", async () => {
    const folder = "C:\\Shot playback";
    const job = rendered(folder);
    const onPlay = vi.fn();
    await withFakeFile({ seconds: 9 }, async (seen) => {
      render(<ShotThumbnail folderPath={folder} job={job} seconds={4.5} endSeconds={6} shotNumber={2} onPlay={onPlay} />);
      fireEvent.click(await screen.findByRole("button", { name: "Play shot 2 of First scene" }));
      expect(onPlay).toHaveBeenCalledTimes(1);

      const video = await waitFor(() => {
        const found = document.querySelector("video");
        expect(found).not.toBeNull();
        return found as HTMLVideoElement;
      });
      await waitFor(() => expect(screen.getByRole("button", { name: "Pause shot 2 of First scene" })).not.toBeNull());
      expect(seen.seeks).toContain(4.5);

      video.currentTime = 6;
      fireEvent.timeUpdate(video);
      await waitFor(() => expect(screen.getByRole("button", { name: "Play shot 2 of First scene" })).not.toBeNull());
      expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
      expect(seen.reads()).toBe(2);
    });
  });

  it("shows no picture and reads no file until the scene has been rendered", async () => {
    const folder = "C:\\Not rendered";
    const fresh = createProjectConfig({ name: "Draft", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const job = fresh.generationJobs[0];
    await withFakeFile({ seconds: 9 }, async (seen) => {
      render(<ShotThumbnail folderPath={folder} job={job} seconds={0} shotNumber={1} />);
      // A labelled placeholder that says which state the scene is in, never an
      // invented picture and never a read of a file that does not exist.
      expect(screen.getByRole("img", { name: "Shot 1 — Not rendered yet" })).not.toBeNull();
      expect(screen.queryByRole("img", { name: /of / })).toBeNull();
      expect(seen.reads()).toBe(0);
    });
  });

  it("shows the render ETA on its own line beneath the percentage", () => {
    const fresh = createProjectConfig({ name: "Draft", prompt: "A quiet product film", aspectRatio: "16:9", resolution: "1080p", targetDurationSeconds: 30 });
    const job: GenerationJob = { ...fresh.generationJobs[0], status: "generating", stage: "generating", progress: 0.42 };
    render(<ShotThumbnail folderPath="C:\\Rendering" job={job} seconds={0} shotNumber={1} estimatedCompletionAt={Date.now() + 90_000} />);

    const rendering = screen.getByText("Rendering 42%");
    expect(rendering.tagName).toBe("EM");
    expect(rendering.nextElementSibling?.classList.contains("shot-thumb__eta")).toBe(true);
    expect(rendering.nextElementSibling?.textContent).toBe("1m 30s left");
  });

  it("says a finished scene could not be previewed rather than showing nothing", async () => {
    const folder = "C:\\Unreadable";
    const job = rendered(folder);
    const { invoke } = await import("@tauri-apps/api/core");
    await withFakeFile({ seconds: 9 }, async () => {
      vi.mocked(invoke).mockRejectedValue(new Error("That file is not in the project folder."));
      render(<ShotThumbnail folderPath={folder} job={job} seconds={0} shotNumber={1} />);
      await waitFor(() => expect(screen.getByRole("img", { name: "Shot 1 — No preview" })).not.toBeNull());
    });
  });
});
