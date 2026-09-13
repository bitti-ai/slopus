// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readMediaFileUrl } from "../../lib/persistence";
import { MediaThumbnail } from "./MediaThumbnail";

vi.mock("../../lib/persistence", () => ({ readMediaFileUrl: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("draws and caches the first source frame and releases the video blob", async () => {
  vi.mocked(readMediaFileUrl).mockResolvedValue("blob:first-reference-frame");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { revokeObjectURL: revoke });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,firstframe");
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const create = document.createElement.bind(document);
  const seek = vi.fn();
  let video: HTMLVideoElement | undefined;
  vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
    const element = create(tag, options);
    if (tag === "video") {
      video = element as HTMLVideoElement;
      Object.defineProperties(element, {
        videoWidth: { value: 1280 }, videoHeight: { value: 720 }, duration: { value: 8 },
        currentTime: { get: () => 0, set: seek },
      });
      setTimeout(() => element.dispatchEvent(new Event("loadeddata")), 0);
    }
    return element;
  });
  const props = { folderPath: "C:/first-frame-test", asset: {
    id: "video-reference", kind: "video" as const, name: "Uncategorized", sourcePath: "D:/clip.mp4",
    mimeType: "video/mp4", createdAt: "2026-09-13T00:00:00.000Z",
  }, posterTimeSeconds: 0 };
  try {
    const first = render(<MediaThumbnail {...props} />);
    expect(await screen.findByRole("img", { name: "Frame from Uncategorized" })).toHaveAttribute("src", "data:image/jpeg;base64,firstframe");
    expect(seek).not.toHaveBeenCalled();
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
    expect(revoke).toHaveBeenCalledWith("blob:first-reference-frame");
    first.unmount();
    render(<MediaThumbnail {...props} />);
    expect(screen.getByRole("img", { name: "Frame from Uncategorized" })).toBeInTheDocument();
    expect(readMediaFileUrl).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});
