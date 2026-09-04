// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftGenerationJob, type TimelineClip } from "../../lib/project";
import { readProjectFileUrl } from "../../lib/persistence";
import { TimelineClipThumbnails } from "./TimelineClipThumbnails";

vi.mock("../../lib/persistence", () => ({
  readProjectFileUrl: vi.fn(async (_folder: string, relativePath: string) => `blob:${relativePath}`),
}));
vi.mock("./ShotThumbnail", () => ({ shotPoster: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});
afterEach(cleanup);

describe("timeline clip thumbnails", () => {
  it("places cached source frames at their correct offsets in a trimmed clip", async () => {
    const job = {
      ...createDraftGenerationJob("A scene", { id: "scene-one", durationSeconds: 8 }),
      status: "completed" as const,
      stage: "completed" as const,
      progress: 1,
      outputRelativePath: "media/generated/scene-one.mp4",
    };
    const clip: TimelineClip = {
      id: "clip-one",
      assetId: "asset-scene-one",
      trackId: "track-video-1",
      startMs: 10_000,
      durationMs: 5_000,
      sourceStartMs: 1_000,
      label: "A scene",
      color: null,
      status: "generated",
    };
    const view = render(<TimelineClipThumbnails folderPath="C:\Project" job={job} clip={clip} />);

    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(3));
    expect(vi.mocked(readProjectFileUrl).mock.calls.map((call) => call[1])).toEqual([
      "thumbnails/timeline/scene-one/00000000.jpg",
      "thumbnails/timeline/scene-one/00002000.jpg",
      "thumbnails/timeline/scene-one/00004000.jpg",
    ]);
    expect([...view.container.querySelectorAll("img")].map((image) => ({
      left: image.style.left,
      width: image.style.width,
    }))).toEqual([
      { left: "-20%", width: "40%" },
      { left: "20%", width: "40%" },
      { left: "60%", width: "40%" },
    ]);
  });
});
