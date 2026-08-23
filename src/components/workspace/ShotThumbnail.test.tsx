// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
async function withFakeFile(file: { seconds: number }, body: (seen: { seeks: number[]; reads: () => number }) => Promise<void>) {
  const { invoke } = await import("@tauri-apps/api/core");
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  vi.mocked(invoke).mockResolvedValue(new ArrayBuffer(8));
  URL.createObjectURL = () => "blob:polstudio-test";
  URL.revokeObjectURL = () => undefined;
  const load = HTMLMediaElement.prototype.load;
  const getContext = HTMLCanvasElement.prototype.getContext;
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as unknown as typeof getContext;
  const seeks: number[] = [];
  // The drawn frame is named after the moment it was taken from, so a test can
  // tell one card's picture from another's.
  HTMLCanvasElement.prototype.toDataURL = function () {
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
      setTimeout(() => element.dispatchEvent(new Event("loadeddata")), 0);
    }
    return element;
  });
  try {
    await body({ seeks, reads: () => vi.mocked(invoke).mock.calls.length });
  } finally {
    spy.mockRestore();
    HTMLMediaElement.prototype.load = load;
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
  it("can draw the exact first frame for a scene card", async () => {
    const folder = "C:\\Exact first frame";
    const job = rendered(folder);
    await withFakeFile({ seconds: 9 }, async (seen) => {
      render(<ShotThumbnail folderPath={folder} job={job} seconds={0} shotNumber={1} posterOffsetSeconds={0} />);
      const picture = await screen.findByRole("img", { name: "Shot 1 of First scene" }) as HTMLImageElement;
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
      const drawn = () => screen.getAllByRole("img", { name: /of First scene$/ }) as HTMLImageElement[];
      await waitFor(() => expect(drawn()).toHaveLength(2));
      const pictures = drawn();
      expect(pictures.map((image) => image.getAttribute("alt")))
        .toEqual(["Shot 1 of First scene", "Shot 2 of First scene"]);
      // The file was read once, for both cards.
      expect(seen.reads()).toBe(1);
      /* And each card got ITS shot's frame: a quarter of a second past the cut,
         which is inside the shot and past a fade-in that would otherwise hand
         the first card a black rectangle. */
      expect(seen.seeks).toEqual([0.25, 4.75]);
      expect(pictures[0].src).not.toBe(pictures[1].src);
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
