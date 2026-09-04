// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeTimelineThumbnails, timelineThumbnailRelativePath, writeTimelineThumbnail } from "./timelineThumbnails";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const scope = globalThis as unknown as Record<string, unknown>;
afterEach(() => {
  delete scope.__TAURI_INTERNALS__;
  vi.clearAllMocks();
});

describe("timeline thumbnail persistence", () => {
  it("uses stable project-relative cache names", () => {
    expect(timelineThumbnailRelativePath("scene-12", 2_000)).toBe("thumbnails/timeline/scene-12/00002000.jpg");
  });

  it("writes raw JPEG bytes and purges only the named scene cache", async () => {
    scope.__TAURI_INTERNALS__ = {};
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    await writeTimelineThumbnail("C:\Project", "scene-12", 2_000, bytes);
    await purgeTimelineThumbnails("C:\Project", "scene-12");

    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(1, "write_timeline_thumbnail", bytes, {
      headers: {
        "x-thumbnail-folder": encodeURIComponent("C:\Project"),
        "x-thumbnail-job": "scene-12",
        "x-thumbnail-time": "2000",
      },
    });
    expect(vi.mocked(invoke)).toHaveBeenNthCalledWith(2, "purge_timeline_thumbnails", {
      folderPath: "C:\Project",
      jobId: "scene-12",
    });
  });
});
