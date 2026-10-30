// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useContext } from "react";
import { encodeGenerationPreview, type GenerationPreview } from "../../lib/generationPreview";
import { GenerationPreviewContext, GenerationPreviewSource } from "./GenerationPreviewSource";
vi.mock("../../lib/generationPreview", () => ({ encodeGenerationPreview: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const preview: GenerationPreview = { jobId: "job", width: 2, height: 2, fps: 4, step: 0, frames: ["/9j/AA=="] };
function Consumer() {
  const source = useContext(GenerationPreviewContext);
  return source?.url ? <video aria-label="Preview" src={source.url} /> : source ? <img src={`data:image/jpeg;base64,${source.preview.frames[0]}`} /> : null;
}
function Preview({ preview }: { preview?: GenerationPreview }) {
  return <GenerationPreviewSource preview={preview}><Consumer /></GenerationPreviewSource>;
}

it("replaces playable previews, ignores stale encoding and releases URLs on unmount", async () => {
  const create = vi.fn().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  vi.mocked(encodeGenerationPreview).mockResolvedValueOnce(new Blob());
  const view = render(<Preview preview={preview} />);
  await waitFor(() => expect(screen.getByLabelText("Preview")).toHaveAttribute("src", "blob:first"));
  let stale!: (blob: Blob) => void;
  vi.mocked(encodeGenerationPreview).mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }));
  view.rerender(<Preview preview={{ ...preview, step: 1 }} />);
  vi.mocked(encodeGenerationPreview).mockResolvedValueOnce(new Blob());
  view.rerender(<Preview preview={{ ...preview, step: 2 }} />);
  await waitFor(() => expect(screen.getByLabelText("Preview")).toHaveAttribute("src", "blob:second"));
  stale(new Blob());
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith("blob:first");
  view.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:second");
});

it("keeps a still preview when this webview cannot encode previews", async () => {
  vi.mocked(encodeGenerationPreview).mockRejectedValue(new Error("unsupported"));
  const view = render(<Preview preview={preview} />);
  expect(screen.getByRole("img")).toHaveAttribute("src", "data:image/jpeg;base64,/9j/AA==");
  view.rerender(<Preview />);
  expect(screen.queryByRole("img")).toBeNull();
});
