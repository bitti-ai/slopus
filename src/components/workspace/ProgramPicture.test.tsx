// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProgramPicture } from "./ProgramPicture";
import { PreviewMedia } from "../../lib/previewPresentation";
import { createPreviewCompositor } from "../../lib/exportPipeline";
import type { TimelineClip } from "../../lib/project";

vi.mock("../../lib/exportPipeline", () => ({ createPreviewCompositor: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("keeps the canvas and GPU compositor through cuts and releases them when the monitor closes", async () => {
  const compositor = { kind: "webgpu" as const, clear: vi.fn(), draw: vi.fn(), take: vi.fn(), dispose: vi.fn() };
  vi.mocked(createPreviewCompositor).mockResolvedValue(compositor);
  const props = { media: new PreviewMedia(), width: 1280, height: 720, background: "#000000", onAvailable: vi.fn() };
  const clip = { id: "first" } as TimelineClip;
  const view = render(<ProgramPicture {...props} layers={[clip]} playheadMs={0} />);
  await act(async () => undefined);
  const canvas = view.container.querySelector("canvas");
  view.rerender(<ProgramPicture {...props} layers={[{ ...clip, id: "second" }]} playheadMs={1000} />);
  expect(view.container.querySelector("canvas")).toBe(canvas);
  expect(createPreviewCompositor).toHaveBeenCalledTimes(1);
  expect(compositor.clear).not.toHaveBeenCalled(); // no decoded frames yet
  view.rerender(<ProgramPicture {...props} layers={[]} playheadMs={2000} />);
  expect(compositor.clear).toHaveBeenCalledTimes(1); // intentional gap
  view.unmount();
  expect(compositor.dispose).toHaveBeenCalledTimes(1);
});

it("disposes a compositor that finishes initializing after unmount", async () => {
  const compositor = { kind: "webgpu" as const, clear: vi.fn(), draw: vi.fn(), take: vi.fn(), dispose: vi.fn() };
  let finish!: (value: typeof compositor) => void;
  vi.mocked(createPreviewCompositor).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<ProgramPicture media={new PreviewMedia()} width={640} height={360} background="#000000" onAvailable={vi.fn()} layers={[]} playheadMs={0} />);
  view.unmount();
  await act(async () => finish(compositor));
  expect(compositor.clear).not.toHaveBeenCalled();
  expect(compositor.dispose).toHaveBeenCalledTimes(1);
});
