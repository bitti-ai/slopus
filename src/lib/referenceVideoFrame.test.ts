// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { captureReferenceVideoFrame } from "./referenceVideoFrame";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("captures the displayed frame at full resolution and saves PNG bytes through binary IPC", async () => {
  const video = document.createElement("video");
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 2 } });
  video.currentTime = 4.25;
  vi.spyOn(video, "pause").mockImplementation(() => {});
  const drawImage = vi.fn();
  const convertToBlob = vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer }));
  const sizes: number[][] = [];
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(width: number, height: number) { sizes.push([width, height]); }
    getContext() { return { drawImage }; }
    convertToBlob = convertToBlob;
  });
  vi.mocked(invoke).mockResolvedValue("references/frames/saved.png");
  const frame = await captureReferenceVideoFrame("C:/My project", "Motion", video);
  expect(sizes).toEqual([[1920, 1080]]);
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
  expect(convertToBlob).toHaveBeenCalledWith({ type: "image/png" });
  expect(invoke).toHaveBeenCalledWith("write_reference_frame", new Uint8Array([137, 80, 78, 71]), { headers: {
    "x-reference-folder": "C%3A%2FMy%20project", "x-reference-frame": frame.id,
  } });
  expect(frame).toMatchObject({ relativePath: "references/frames/saved.png", timeSeconds: 4.25 });
  expect(video.pause).toHaveBeenCalled();
});

it("rejects an incomplete seek without writing a stale frame", async () => {
  const video = document.createElement("video");
  Object.defineProperties(video, { videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 2 }, seeking: { value: true } });
  await expect(captureReferenceVideoFrame("C:/project", "Motion", video)).rejects.toThrow("finish loading");
  expect(invoke).not.toHaveBeenCalled();
});
